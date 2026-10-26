import { PROJECT_NAME_PATTERN, PROJECT_NAME_RULES, type CreateProjectRequest, type CreateProjectResponse } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { join, normalize, resolve, sep } from "node:path";
import { createProject, listProjects, ProjectExistsError, waitForPostgres } from "./postgres";

const log = createLogger("api");

// Set in the Docker image, where the API also serves the pre-built dashboard.
const dashboardDir = process.env.DASHBOARD_DIR && resolve(process.env.DASHBOARD_DIR);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

type Handler = (req: Request, log: Logger) => Response | Promise<Response>;

// Gives each request an id and a scoped logger, then logs one line per request.
function logged(handler: Handler) {
  return async (req: Request) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const reqLog = log.child({ req: requestId });
    const start = performance.now();
    const { pathname } = new URL(req.url);

    let res: Response;
    try {
      res = await handler(req, reqLog);
    } catch (err) {
      reqLog.error("unhandled error", { method: req.method, path: pathname, err });
      res = json({ error: "internal error", requestId }, 500);
    }

    const fields = {
      method: req.method,
      path: pathname,
      status: res.status,
      ms: Number((performance.now() - start).toFixed(1)),
    };
    if (res.status >= 500) reqLog.error("request failed", fields);
    else if (res.status >= 400) reqLog.warn("request rejected", fields);
    else reqLog.info("request", fields);

    res.headers.set("X-Request-Id", requestId);
    return res;
  };
}

// Serves files from the dashboard build. The normalize + prefix check keeps
// requests from escaping the directory.
async function serveDashboard(req: Request): Promise<Response> {
  if (!dashboardDir || req.method !== "GET") return json({ error: "not found" }, 404);
  const { pathname } = new URL(req.url);
  const path = normalize(join(dashboardDir, pathname === "/" ? "index.html" : pathname));
  const file = Bun.file(path);
  if (!path.startsWith(dashboardDir + sep) || !(await file.exists())) return json({ error: "not found" }, 404);
  return new Response(file);
}

await waitForPostgres(log);

const server = Bun.serve({
  port: Number(process.env.API_PORT ?? 4000),
  routes: {
    "/health": logged(() => json({ ok: true })),
    "/projects": {
      GET: logged(async () => json(await listProjects())),
      POST: logged(async (req, log) => {
        const { name } = (await req.json()) as CreateProjectRequest;
        if (!name) return json({ error: "name is required" }, 400);
        if (!PROJECT_NAME_PATTERN.test(name)) return json({ error: PROJECT_NAME_RULES }, 400);
        // TODO: provision a storage bucket once the backend is chosen.
        try {
          const { project, credentials } = await createProject(name, log);
          log.info("project created", { project: name });
          return json({ ...project, credentials } satisfies CreateProjectResponse, 201);
        } catch (err) {
          if (err instanceof ProjectExistsError) return json({ error: err.message }, 409);
          throw err;
        }
      }),
      OPTIONS: () => new Response(null, { headers: cors }),
    },
  },
  fetch: logged(serveDashboard),
});

log.info("listening", { url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "info", dashboard: dashboardDir ?? "off" });

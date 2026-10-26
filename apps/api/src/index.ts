import type { CreateProjectRequest, Project } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";

const log = createLogger("api");

// In-memory registry until the metadata store is decided (see CLAUDE.md).
const projects = new Map<string, Project>();

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

const server = Bun.serve({
  port: Number(process.env.API_PORT ?? 4000),
  routes: {
    "/health": logged(() => json({ ok: true })),
    "/projects": {
      GET: logged(() => json([...projects.values()])),
      POST: logged(async (req, log) => {
        const { name } = (await req.json()) as CreateProjectRequest;
        if (!name) return json({ error: "name is required" }, 400);
        if (projects.has(name)) return json({ error: `project "${name}" already exists` }, 409);
        // TODO: provision Postgres database + role and storage bucket.
        const project: Project = { name, createdAt: new Date().toISOString() };
        projects.set(name, project);
        log.info("project created", { project: name });
        return json(project, 201);
      }),
      OPTIONS: () => new Response(null, { headers: cors }),
    },
  },
  fetch: logged(() => json({ error: "not found" }, 404)),
});

log.info("listening", { url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "info" });

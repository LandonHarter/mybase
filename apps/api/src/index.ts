import { PROJECT_NAME_PATTERN, PROJECT_NAME_RULES, PUBLIC_PREFIX, type CreateProjectRequest } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import type { BunRequest, S3File } from "bun";
import { join, normalize, resolve, sep } from "node:path";
import { ProjectExistsError, ProjectNotFoundError } from "./errors";
import { waitForPostgres } from "./postgres";
import { createProject, deleteProject, listProjects } from "./projects";
import { file, listFiles, waitForGarage } from "./storage";

const log = createLogger("api");

// Set in the Docker image, where the API also serves the pre-built dashboard.
const dashboardDir = process.env.DASHBOARD_DIR && resolve(process.env.DASHBOARD_DIR);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

type Handler = (req: BunRequest, log: Logger) => Response | Promise<Response>;

// Gives each request an id and a scoped logger, then logs one line per request.
function logged(handler: Handler) {
  return async (req: BunRequest) => {
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

// Storage errors from Bun's S3 client carry the S3 error code.
const s3Code = (err: unknown) => (err as { code?: string }).code;

// Wraps a storage handler: validates the project name and turns missing buckets/objects into 404s.
function storage(handler: (req: BunRequest, log: Logger, project: string) => Promise<Response>): Handler {
  return async (req, log) => {
    const { name: project = "" } = req.params as { name?: string };
    if (!PROJECT_NAME_PATTERN.test(project)) return json({ error: "not found" }, 404);
    try {
      return await handler(req, log.child({ project }), project);
    } catch (err) {
      const code = s3Code(err);
      if (code === "NoSuchBucket" || code === "NoSuchKey" || code === "ERR_S3_FILE_NOT_FOUND") return json({ error: "not found" }, 404);
      throw err;
    }
  };
}

/**
 * The object key is everything after `prefix` in the raw path, URL-decoded.
 * Rejects empty keys and `.`/`..` segments so keys stay sane in listings and logs.
 */
function objectKey(req: Request, prefix: string): string | null {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(prefix)) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  const segments = key.split("/");
  if (!key || key.length > 1024 || segments.some((s) => s === "." || s === "..") || key.startsWith("/")) return null;
  return key;
}

/** Streams an object through the API, so browsers never need to reach Garage directly. */
async function sendObject(req: Request, obj: S3File, headers: Record<string, string> = {}): Promise<Response> {
  const stat = await obj.stat();
  const etag = stat.etag;
  if (etag && req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(obj.stream(), {
    headers: {
      "Content-Type": stat.type || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Last-Modified": stat.lastModified.toUTCString(),
      ...(etag ? { ETag: etag } : {}),
      ...headers,
    },
  });
}

await waitForPostgres(log);
await waitForGarage(log);

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
        try {
          const project = await createProject(name, log);
          log.info("project created", { project: name, bucket: project.credentials.storage.bucket });
          return json(project, 201);
        } catch (err) {
          if (err instanceof ProjectExistsError) return json({ error: err.message }, 409);
          throw err;
        }
      }),
      OPTIONS: () => new Response(null, { headers: cors }),
    },
    "/projects/:name": {
      DELETE: logged(async (req, log) => {
        const { name } = req.params as { name: string };
        if (!PROJECT_NAME_PATTERN.test(name)) return json({ error: `project "${name}" not found` }, 404);
        try {
          await deleteProject(name, log);
        } catch (err) {
          if (err instanceof ProjectNotFoundError) return json({ error: err.message }, 404);
          throw err;
        }
        log.info("project deleted", { project: name });
        return new Response(null, { status: 204, headers: cors });
      }),
      OPTIONS: () => new Response(null, { headers: cors }),
    },
    "/projects/:name/files": {
      GET: logged(
        storage(async (req, _log, project) => {
          const prefix = new URL(req.url).searchParams.get("prefix") ?? "";
          return json(await listFiles(project, prefix));
        }),
      ),
    },
    "/projects/:name/files/*": {
      GET: logged(
        storage(async (req, _log, project) => {
          const key = objectKey(req, `/projects/${project}/files/`);
          if (!key) return json({ error: "invalid file path" }, 400);
          const name = key.slice(key.lastIndexOf("/") + 1);
          return sendObject(req, file(project, key), { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
        }),
      ),
      PUT: logged(
        storage(async (req, log, project) => {
          const key = objectKey(req, `/projects/${project}/files/`);
          if (!key) return json({ error: "invalid file path" }, 400);
          const obj = file(project, key);
          await obj.write(req, { type: req.headers.get("Content-Type") ?? undefined });
          // write() reports 0 bytes for a streamed body, so ask storage for the real size.
          const { size } = await obj.stat();
          log.info("file uploaded", { key, bytes: size });
          return json({ key, size }, 201);
        }),
      ),
      DELETE: logged(
        storage(async (req, log, project) => {
          const key = objectKey(req, `/projects/${project}/files/`);
          if (!key) return json({ error: "invalid file path" }, 400);
          await file(project, key).delete();
          log.info("file deleted", { key });
          return new Response(null, { status: 204, headers: cors });
        }),
      ),
      OPTIONS: () => new Response(null, { headers: cors }),
    },
    // Unauthenticated reads, limited to the `public/` prefix.
    "/storage/:name/public/*": {
      GET: logged(
        storage(async (req, _log, project) => {
          const rest = objectKey(req, `/storage/${project}/${PUBLIC_PREFIX}`);
          if (!rest) return json({ error: "not found" }, 404);
          return sendObject(req, file(project, PUBLIC_PREFIX + rest), { "Cache-Control": "public, max-age=300", ...cors });
        }),
      ),
    },
  },
  fetch: logged(serveDashboard),
  // Uploads stream through the API to storage.
  maxRequestBodySize: Number(process.env.MYBASE_MAX_UPLOAD ?? 1024 ** 3),
});

log.info("listening", { url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "info", dashboard: dashboardDir ?? "off" });

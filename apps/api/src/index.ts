import {
  PROJECT_NAME_PATTERN,
  PROJECT_NAME_RULES,
  PUBLIC_PREFIX,
  type CreateProjectRequest,
  type QueryError,
  type QueryResponse,
  type RowValues,
} from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import type { BunRequest, S3File } from "bun";
import { join, normalize, resolve, sep } from "node:path";
import { createJob, deleteJob, getJob, getSecret, listJobs, listRuns, overview, rotateSecret, runNow, syncJobs, updateJob } from "./cron";
import { startScheduler } from "./cron-scheduler";
import { migrate } from "./control";
import { databaseDetails, disableExtension, enableExtension, listExtensions, setConnectionLimit } from "./database";
import { BadRequestError, ConflictError, NotFoundError, ProjectExistsError, ProjectNotFoundError, QueryFailedError } from "./errors";
import { projectExists, waitForPostgres } from "./postgres";
import { createProject, deleteProject, listProjects } from "./projects";
import { disableService, enableService } from "./services";
import { file, listFiles, waitForGarage } from "./storage";
import { deleteRow, insertRow, listTables, runQuery, tableRows, updateRow } from "./tables";

const log = createLogger("api");

// Set in the Docker image, where the API also serves the pre-built dashboard.
const dashboardDir = process.env.DASHBOARD_DIR && resolve(process.env.DASHBOARD_DIR);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
 * Wraps a handler that works inside one project: checks the project exists (so names like
 * `postgres` or `template1` never reach a project connection) and turns the shared error
 * classes into 4xx responses.
 */
function inProject(handler: (req: BunRequest, log: Logger, project: string) => Promise<Response>): Handler {
  return async (req, log) => {
    const { name: project = "" } = req.params as { name?: string };
    if (!PROJECT_NAME_PATTERN.test(project) || !(await projectExists(project))) return json({ error: `project "${project}" not found` }, 404);
    try {
      return await handler(req, log.child({ project }), project);
    } catch (err) {
      if (err instanceof NotFoundError) return json({ error: err.message }, 404);
      if (err instanceof ConflictError) return json({ error: err.message }, 409);
      if (err instanceof BadRequestError) return json({ error: err.message }, 400);
      if (err instanceof QueryFailedError) {
        const body: QueryError = { error: err.message, position: err.position, detail: err.detail, hint: err.hint };
        return json(body, 400);
      }
      throw err;
    }
  };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestError("expected a JSON object");
  return body as Record<string, unknown>;
}

/** Row values from the dashboard: column → Postgres text value, or null for NULL. */
function rowValues(value: unknown, field: string): RowValues {
  const ok =
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => v === null || typeof v === "string");
  if (!ok) throw new BadRequestError(`${field} must map column names to strings or null`);
  return value as RowValues;
}

/** An integer query param within [min, max], or `fallback` when absent. */
function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestError(`${key} must be an integer from ${min} to ${max}`);
  return n;
}

const noContent = () => new Response(null, { status: 204, headers: cors });
const preflight = () => new Response(null, { headers: cors });

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
await migrate(log);
await waitForGarage(log);
await startScheduler();

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
    "/projects/:name/database": {
      GET: logged(inProject(async (_req, _log, project) => json(await databaseDetails(project)))),
      PATCH: logged(
        inProject(async (req, log, project) => {
          const { connectionLimit } = await readJson(req);
          const valid = connectionLimit === null || (Number.isInteger(connectionLimit) && (connectionLimit as number) >= 1 && (connectionLimit as number) <= 1000);
          if (!valid) return json({ error: "connectionLimit must be null (no limit) or an integer from 1 to 1000" }, 400);
          await setConnectionLimit(project, connectionLimit as number | null, log);
          return json(await databaseDetails(project));
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/database/extensions": {
      GET: logged(inProject(async (_req, _log, project) => json(await listExtensions(project)))),
    },
    "/projects/:name/database/extensions/:ext": {
      PUT: logged(
        inProject(async (req, log, project) => {
          await enableExtension(project, (req.params as { ext: string }).ext, log);
          return noContent();
        }),
      ),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await disableExtension(project, (req.params as { ext: string }).ext, log);
          return noContent();
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/database/tables": {
      GET: logged(inProject(async (_req, _log, project) => json(await listTables(project)))),
    },
    "/projects/:name/database/tables/:schema/:table": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const { schema, table } = req.params as { schema: string; table: string };
          const url = new URL(req.url);
          const limit = intParam(url, "limit", 50, 1, 500);
          const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
          return json(await tableRows(project, schema, table, limit, offset));
        }),
      ),
    },
    "/projects/:name/database/tables/:schema/:table/rows": {
      POST: logged(
        inProject(async (req, log, project) => {
          const { schema, table } = req.params as { schema: string; table: string };
          const body = await readJson(req);
          await insertRow(project, schema, table, rowValues(body.values, "values"), log);
          return noContent();
        }),
      ),
      PATCH: logged(
        inProject(async (req, log, project) => {
          const { schema, table } = req.params as { schema: string; table: string };
          const body = await readJson(req);
          await updateRow(project, schema, table, rowValues(body.key, "key"), rowValues(body.values, "values"), log);
          return noContent();
        }),
      ),
      DELETE: logged(
        inProject(async (req, log, project) => {
          const { schema, table } = req.params as { schema: string; table: string };
          const body = await readJson(req);
          await deleteRow(project, schema, table, rowValues(body.key, "key"), log);
          return noContent();
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/database/query": {
      POST: logged(
        inProject(async (req, log, project) => {
          const { sql } = await readJson(req);
          if (typeof sql !== "string" || !sql.trim()) return json({ error: "sql is required" }, 400);
          const body: QueryResponse = { results: await runQuery(project, sql, log) };
          return json(body);
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/services/:id": {
      PUT: logged(
        inProject(async (req, log, project) => {
          await enableService(project, (req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await disableService(project, (req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/cron": {
      GET: logged(inProject(async (_req, _log, project) => json(await overview(project)))),
    },
    "/projects/:name/cron/jobs": {
      GET: logged(inProject(async (_req, _log, project) => json(await listJobs(project)))),
      POST: logged(inProject(async (req, log, project) => json(await createJob(project, await readJson(req), log), 201))),
      // Replaces the code-defined jobs (`mybase cron sync`).
      PUT: logged(
        inProject(async (req, log, project) => {
          const { jobs, dryRun = false } = await readJson(req);
          if (typeof dryRun !== "boolean") return json({ error: "dryRun must be true or false" }, 400);
          return json(await syncJobs(project, jobs, dryRun, log));
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/cron/jobs/:job": {
      GET: logged(inProject(async (req, _log, project) => json(await getJob(project, (req.params as { job: string }).job)))),
      PATCH: logged(inProject(async (req, log, project) => json(await updateJob(project, (req.params as { job: string }).job, await readJson(req), log)))),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await deleteJob(project, (req.params as { job: string }).job, log);
          return noContent();
        }),
      ),
      OPTIONS: preflight,
    },
    "/projects/:name/cron/jobs/:job/run": {
      POST: logged(inProject(async (req, log, project) => json({ runId: await runNow(project, (req.params as { job: string }).job, log) }, 202))),
      OPTIONS: preflight,
    },
    "/projects/:name/cron/jobs/:job/runs": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const limit = intParam(new URL(req.url), "limit", 50, 1, 100);
          return json(await listRuns(project, (req.params as { job: string }).job, limit));
        }),
      ),
    },
    "/projects/:name/cron/secret": {
      GET: logged(inProject(async (_req, _log, project) => json(await getSecret(project)))),
    },
    "/projects/:name/cron/secret/rotate": {
      POST: logged(inProject(async (_req, log, project) => json(await rotateSecret(project, log)))),
      OPTIONS: preflight,
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

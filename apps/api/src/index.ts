import {
  type AuthStatus,
  CRON_TASK_STATUSES,
  type CronTaskStatus,
  PROJECT_NAME_PATTERN,
  PROJECT_NAME_RULES,
  PUBLIC_PREFIX,
  type CreateProjectRequest,
  MYBASE_VERSION,
  type QueryError,
  type QueryResponse,
  type RowValues,
} from "@mybase/shared";
import { ANALYTICS_LIMITS } from "@mybase-dev/sdk/analytics";
import { createLogger, type Logger } from "@mybase/shared/logger";
import type { BunRequest, S3File, Server } from "bun";
import { join, normalize, resolve, sep } from "node:path";
import {
  adminExists,
  adminUsername,
  authenticate,
  bootstrapAdmin,
  changePassword,
  createAdmin,
  createSession,
  createToken,
  deleteAllSessions,
  deleteSession,
  deleteToken,
  listTokens,
  updateToken,
  verifyAdmin,
  type Auth,
} from "./auth";
import {
  completeChallenge,
  confirmTotpSetup,
  createChallenge,
  disableTotp,
  mfaEnabled,
  mfaStatus,
  regenerateRecoveryCodes,
  startMfa,
  startTotpSetup,
} from "./auth-mfa";
import { fullReport, projectReport } from "./advisor";
import { alertsOverview, createChannel, deleteChannel, rotateChannelSecret, setRule, startAlerts, testChannel, updateChannel } from "./alerts";
import { ANONYMOUS, audit, auditOnce, finishRequest, flushAudit, getAuditSettings, listAudit, setAuditActor, startAudit, updateAuditSettings, withAuditScope, type AuditActor } from "./audit";
import { analyticsScript, clearEvents, getSettings, listEvents, overview as analyticsOverview, readRange, readTimeZone, rotateKey, updateSettings } from "./analytics";
import { flushAnalytics, ingest, startAnalytics } from "./analytics-ingest";
import {
  cacheOverview,
  deleteKey,
  getKey,
  httpCommand,
  httpMultiExec,
  httpPipeline,
  listKeys,
  putKey,
  requireCache,
  rotatePassword,
  setKeyTtl,
} from "./cache";
import { bearerToken, clientIp, crossOrigin, isHttps, isPrivateIp, LoginThrottle, RateLimit, readCookie, SESSION_COOKIE, sessionCookie, trustedCountry, viaCloudflare } from "./auth-http";
import { projectContext } from "./context";
import { listPages, llmsFullTxt, llmsTxt, loadDocs, getPage, renderPage, searchDocs } from "./docs";
import { handleMcp } from "./mcp";
import { createJob, deleteJob, getJob, getSecret, listJobs, listRuns, overview, requireEnabled, rotateSecret, runNow, syncJobs, updateJob } from "./cron";
import { startScheduler } from "./cron-scheduler";
import { cancelTask, createTask, getTask, listTasks, MAX_APP_BODY, startTaskRunner, type TaskRef } from "./cron-tasks";
import { migrate } from "./control";
import { upgradeDb } from "./db-proxy";
import { databaseDetails, disableExtension, enableExtension, listExtensions, setConnectionLimit } from "./database";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ProjectExistsError,
  ProjectNotFoundError,
  QueryFailedError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnsupportedMediaError,
  UpstreamError,
  UnauthorizedError,
} from "./errors";
import { allows, canSeeProject, deniedMessage, requirement } from "./permissions";
import { projectExists, waitForPostgres } from "./postgres";
import { createProject, deleteProject, listProjects } from "./projects";
import * as queue from "./queue";
import * as ratelimit from "./ratelimit";
import * as search from "./search";
import * as secrets from "./secrets";
import * as vector from "./vector";
import * as users from "./users";
import * as captcha from "./captcha";
import * as realtime from "./realtime";
import * as sandbox from "./sandbox";
import { upgradeSandboxBrowser } from "./sandbox-browser";
import { flushWebhooks } from "./realtime-webhook";
import { websocket, type SocketData } from "./websocket";
import { linkCredentials, relinkService, unlinkEnv } from "./secrets-link";
import { dbPublicStatus, startDbPublic } from "./db-public";
import { disableService, enableService } from "./services";
import { API_HEADERS, dashboardCsp, dashboardHeaders, inlineScriptHashes, objectHeaders, setMissing } from "./security-headers";
import { file, listFiles, waitForGarage } from "./storage";
import { deleteRow, insertRow, listTables, runQuery, schemaOverview, tableRows, updateRow } from "./tables";
import { waitForValkey } from "./valkey";

const log = createLogger("api");

// Set in the Docker image, where the API also serves the pre-built dashboard.
const dashboardDir = process.env.DASHBOARD_DIR && resolve(process.env.DASHBOARD_DIR);
// The built page's inline theme script is allowed by hash; nothing else inline may run.
const dashboardPolicy = dashboardDir ? await dashboardCspFor(join(dashboardDir, "index.html")) : null;

async function dashboardCspFor(path: string): Promise<string | null> {
  const page = Bun.file(path);
  return (await page.exists()) ? dashboardCsp(await inlineScriptHashes(await page.text())) : null;
}

// Only public files are readable cross-origin. Admin routes are same-origin (the dashboard) or
// not from a browser at all (the CLI), so they send no CORS headers.
const publicCors = { "Access-Control-Allow-Origin": "*" };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (body: string, type = "text/plain") => new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8` } });

// What apps and agents call this instance (docs and MCP fill it into examples).
const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** What `logged` knows about a request, for handlers that need it. */
interface RequestContext {
  ip: string;
  /** Always set on routes that aren't `open`. */
  auth: Auth | null;
  server: Server<SocketData>;
}

/** `undefined` only after a WebSocket upgrade. */
type Handler = (req: BunRequest, log: Logger, ctx: RequestContext) => Response | undefined | Promise<Response | undefined>;

/** Open handlers, whether each wants to know who's signed in (`ctx.auth`), and whether other sites may POST to it. */
const openHandlers = new WeakMap<Handler, { lookup: boolean; crossSite: boolean }>();

/**
 * Marks a handler as reachable without signing in. Every other route requires auth.
 * `anonymous` skips the session lookup for routes that never use it (static files, public
 * objects), sparing Postgres a query per asset.
 * `crossSite` lets other sites' pages POST to it (analytics ingest), skipping the CSRF check.
 * Only for anonymous routes: with no session read, there's nothing to forge.
 */
function open(handler: Handler, { anonymous = false, crossSite = false } = {}): Handler {
  if (crossSite && !anonymous) throw new Error("crossSite routes must be anonymous");
  openHandlers.set(handler, { lookup: !anonymous, crossSite });
  return handler;
}

// Wrong API keys, per IP: the same backoff as sign-ins. App routes are on the internet.
const keyThrottle = new LoginThrottle();

/**
 * Gives each request an id and a scoped logger, checks auth, then logs one line per request.
 * Default-deny: a handler runs signed out only if it was wrapped in `open`, and a key needs
 * the permission its route asks for (`requirement` in permissions.ts: admin unless listed).
 */
function logged(handler: Handler) {
  const openAs = openHandlers.get(handler);
  return async (req: BunRequest, server: Server<SocketData>) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const reqLog = log.child({ req: requestId });
    const start = performance.now();
    const { pathname } = new URL(req.url);

    let res: Response | undefined;
    // Assigned inside the audit scope's callback, which TS can't follow.
    let auth = null as Auth | null;
    const ip = clientIp(req, server);
    await withAuditScope(ANONYMOUS, ip, requestId, async () => {
      try {
        const bearer = bearerToken(req);
        const lookup = !openAs || openAs.lookup;
        const wait = lookup && bearer ? keyThrottle.retryAfter(ip) : 0;
        if (wait) {
          res = Response.json({ error: `Too many requests with a wrong key. Try again in ${wait} seconds.` }, { status: 429, headers: { "Retry-After": String(wait) } });
        } else {
          if (lookup) auth = await authenticate(readCookie(req, SESSION_COOKIE), bearer);
          if (auth) setAuditActor(actorOf(auth));
          if (lookup && bearer && !auth) {
            keyThrottle.fail(ip);
            reqLog.warn("api key rejected", { ip });
            // One per IP per minute: a misconfigured app retrying shouldn't flood the log.
            auditOnce(`key.rejected:${ip}`, 60_000, { action: "key.rejected", outcome: "denied", target: `${req.method} ${pathname}` });
          }
          res = denied(req, pathname, openAs, auth, bearer !== null) ?? (await handler(req, reqLog, { ip, auth, server }));
        }
      } catch (err) {
        reqLog.error("unhandled error", { method: req.method, path: pathname, err });
        res = json({ error: "internal error", requestId }, 500);
      }
      finishRequest(req.method, pathname, res?.status ?? 101);
    });

    const status = res?.status ?? 101;
    const fields = {
      method: req.method,
      path: pathname,
      status,
      auth: auth?.kind,
      ms: Number((performance.now() - start).toFixed(1)),
    };
    if (status >= 500) reqLog.error("request failed", fields);
    else if (status >= 400) reqLog.warn("request rejected", fields);
    else reqLog.info("request", fields);

    if (res) {
      res.headers.set("X-Request-Id", requestId);
      setMissing(res, API_HEADERS);
      // Signed-in answers can hold project data: keep them out of shared and browser caches.
      if (auth && !res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
    }
    return res;
  };
}

/** Who a request is, for the audit log. */
const actorOf = (auth: Auth): AuditActor => (auth.kind === "token" ? { kind: "token", id: auth.tokenId, name: auth.tokenName } : { kind: "session", id: null, name: "admin" });

/** The answer for a request that may not go on, or null when it may. */
function denied(req: BunRequest, pathname: string, openAs: { crossSite: boolean } | undefined, auth: Auth | null, sentKey: boolean): Response | null {
  if (!openAs?.crossSite && crossOrigin(req)) return json({ error: "cross-origin request blocked" }, 403);
  if (openAs) return null;
  if (!auth) {
    const error = sentKey ? "invalid API key" : "sign in first, or send an API key (Authorization: Bearer mb_…)";
    return Response.json({ error }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mybase"' } });
  }
  const params = (req.params ?? {}) as { name?: string; project?: string };
  const project = params.name ?? params.project ?? null;
  const need = requirement(req.method, pathname);
  return allows(auth, need, project) ? null : json({ error: deniedMessage(auth, need, project) }, 403);
}

/** A browser session (cookie), or an API token when the CLI asked for one (`tokenName`). */
async function signedIn(req: Request, log: Logger, ip: string, username: string, tokenName: unknown, mfa: boolean): Promise<Response> {
  if (tokenName !== undefined) {
    const created = await createToken({ name: tokenName }, log);
    log.info("signed in", { ip, via: "token" });
    audit({ action: "auth.login", outcome: "ok", actor: { kind: "token", id: created.id, name: created.name }, meta: { via: "token", mfa } });
    return json({ username, token: created.token });
  }
  log.info("signed in", { ip, via: "session" });
  audit({ action: "auth.login", outcome: "ok", actor: { kind: "session", id: null, name: username }, meta: { via: "session", mfa } });
  return withCookie(json({ username }), sessionCookie(req, await createSession()));
}

/** For 2FA settings: refuses API keys, so a leaked key can't turn 2FA off. Includes `handled`. */
function sessionOnly(handler: Handler): Handler {
  return handled((req, log, ctx) => {
    if (ctx.auth?.kind !== "session") throw new ForbiddenError("2FA settings can only be changed from a signed-in browser");
    return handler(req, log, ctx);
  });
}

/** Turns the shared error classes into 4xx responses. */
function handled(handler: Handler): Handler {
  return async (req, log, ctx) => {
    try {
      return await handler(req, log, ctx);
    } catch (err) {
      if (err instanceof BadRequestError) return json({ error: err.message }, 400);
      if (err instanceof UnauthorizedError) return json({ error: err.message }, 401);
      if (err instanceof ForbiddenError) return json({ error: err.message }, 403);
      if (err instanceof NotFoundError) return json({ error: err.message }, 404);
      if (err instanceof ConflictError) return json({ error: err.message }, 409);
      if (err instanceof TooManyRequestsError) {
        return Response.json({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfter) } });
      }
      if (err instanceof UnsupportedMediaError) return json({ error: err.message }, 415);
      if (err instanceof UpstreamError) return json({ error: err.message }, 502);
      if (err instanceof ServiceUnavailableError) return json({ error: err.message }, 503);
      throw err;
    }
  };
}

const withCookie = (res: Response, cookie: string) => {
  res.headers.append("Set-Cookie", cookie);
  return res;
};

const throttle = new LoginThrottle();

// Captcha: challenges are free to ask for, so cap them per IP; siteverify guards the secret.
const challengeLimit = new RateLimit(60);
const siteVerifyLimit = new RateLimit(300);

// Serves files from the dashboard build. The normalize + prefix check keeps
// requests from escaping the directory.
async function serveDashboard(req: Request): Promise<Response> {
  if (!dashboardDir || req.method !== "GET") return json({ error: "not found" }, 404);
  const { pathname } = new URL(req.url);
  const path = normalize(join(dashboardDir, pathname === "/" ? "index.html" : pathname));
  const file = Bun.file(path);
  if (!path.startsWith(dashboardDir + sep) || !(await file.exists())) return json({ error: "not found" }, 404);
  return new Response(file, { headers: dashboardHeaders(dashboardPolicy, isHttps(req)) });
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
function inProject(handler: (req: BunRequest, log: Logger, project: string, ctx: RequestContext) => Promise<Response>): Handler {
  return async (req, log, ctx) => {
    const { name: project = "" } = req.params as { name?: string };
    if (!PROJECT_NAME_PATTERN.test(project) || !(await projectExists(project))) return json({ error: `project "${project}" not found` }, 404);
    try {
      return await handler(req, log.child({ project }), project, ctx);
    } catch (err) {
      if (err instanceof NotFoundError) return json({ error: err.message }, 404);
      if (err instanceof ConflictError) return json({ error: err.message }, 409);
      if (err instanceof BadRequestError) return json({ error: err.message }, 400);
      if (err instanceof ForbiddenError) return json({ error: err.message }, 403);
      if (err instanceof ServiceUnavailableError) return json({ error: err.message }, 503);
      if (err instanceof UpstreamError) return json({ error: err.message }, 502);
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

async function sandboxJson(req: Request): Promise<Record<string, unknown>> {
  const bytes = await sandbox.readBoundedBody(req, 300_000);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BadRequestError("expected a JSON object"); }
}
function sandboxRoute(handler: (req: BunRequest, project: string, id: string) => Promise<Response>): Handler {
  return handled(async req => {
    const { project,id } = req.params as { project: string; id: string };
    if (!PROJECT_NAME_PATTERN.test(project)) throw new NotFoundError("project not found");
    await sandbox.requireSandbox(project);
    return handler(req,project,id);
  });
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

const noContent = () => new Response(null, { status: 204 });

function parseBody(body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new BadRequestError("expected a JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestError("expected a JSON object");
  return value as Record<string, unknown>;
}

// Analytics ingest is called by any site's pages (fetch or sendBeacon), never with cookies.
const ingestCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** A public route other sites call from the browser: CORS headers on every answer, errors included. */
function fromBrowser(handler: Handler): Handler {
  return open(
    async (req, log, ctx) => {
      const res = await handled(handler)(req, log, ctx);
      for (const [k, v] of Object.entries(ingestCors)) res?.headers.set(k, v);
      return res;
    },
    { anonymous: true, crossSite: true },
  );
}

const ANALYTICS_EVENT_TYPES = ["pageview", "event", "error"] as const;

/**
 * A route apps call server-to-server (`/queue/:project/…`, `/ratelimit/…`, `/cache/…`,
 * `/cron/:project/tasks…`) with an API key as `Authorization: Bearer`. `logged` has checked
 * the key by now; `requireEnabled` checks the project has the service. The body is read as
 * text, up to `maxBytes`.
 */
function appRoute(
  maxBytes: number,
  requireEnabled: (project: string) => Promise<unknown>,
  handler: (req: BunRequest, log: Logger, project: string, body: string, ctx: RequestContext) => Promise<Response>,
): Handler {
  return handled(async (req, log, ctx) => {
    const { project = "" } = req.params as { project?: string };
    if (!PROJECT_NAME_PATTERN.test(project)) return json({ error: `project "${project}" not found` }, 404);
    await requireEnabled(project);
    if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return json({ error: "body too large" }, 413);
    const body = await req.text();
    if (body.length > maxBytes) return json({ error: "body too large" }, 413);
    return handler(req, log.child({ project, via: "app" }), project, body, ctx);
  });
}

/** JSON of any shape (cache commands are arrays). */
function parseAny(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequestError("expected JSON");
  }
}

const CACHE_BODY_BYTES = 1024 * 1024;

const REALTIME_PUBLISH_BYTES = 64 * 1024;

// A full send batch is 1 MB of bodies, plus JSON escaping and attributes.
const QUEUE_BODY_BYTES = 3 * 1024 * 1024;

/**
 * One queue operation, shared by the dashboard/CLI route (`/projects/:name/queue/queues/…`)
 * and the app route (`/queue/:project/queues/…`, with an API key).
 */
type QueueOp = (project: string, name: string, body: Record<string, unknown>, log: Logger, req: BunRequest, ctx: RequestContext) => Promise<Response>;

const queueName = (req: BunRequest) => (req.params as { queue?: string }).queue ?? "";

function adminQueue(op: QueueOp): Handler {
  return inProject(async (req, log, project, ctx) => {
    await queue.requireEnabled(project);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    return op(project, queueName(req), body, log, req, ctx);
  });
}

function appQueue(op: QueueOp): Handler {
  return appRoute(QUEUE_BODY_BYTES, queue.requireEnabled, (req, log, project, body, ctx) =>
    op(project, queueName(req), body.trim() ? parseBody(body) : {}, log, req, ctx),
  );
}

// A full upsert: 100 documents with long texts or 2000-dimension vectors, as JSON.
const VECTOR_BODY_BYTES = 10 * 1024 * 1024;

/**
 * One vector index operation, shared by the dashboard/CLI route (`/projects/:name/vector/indexes/…`)
 * and the app route (`/vector/:project/indexes/…`, with an API key).
 */
type VectorOp = (project: string, index: string, body: Record<string, unknown>, log: Logger, req: BunRequest) => Promise<Response>;

const vectorIndexName = (req: BunRequest) => (req.params as { index?: string }).index ?? "";

function adminVector(op: VectorOp): Handler {
  return inProject(async (req, log, project, { server }) => {
    await vector.requireEnabled(project);
    // Embedding with a remote model can outlast Bun's default 10 s idle timeout.
    server.timeout(req, 120);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    return op(project, vectorIndexName(req), body, log, req);
  });
}

function appVector(op: VectorOp): Handler {
  return appRoute(VECTOR_BODY_BYTES, vector.requireEnabled, (req, log, project, body, { server }) => {
    server.timeout(req, 120);
    return op(project, vectorIndexName(req), body.trim() ? parseBody(body) : {}, log, req);
  });
}

const vectorOps = {
  list: (async (project) => json(await vector.listIndexes(project))) as VectorOp,
  get: (async (project, name) => json(await vector.getIndex(project, name))) as VectorOp,
  update: (async (project, name, body, log) => json(await vector.updateIndex(project, name, body, log))) as VectorOp,
  delete: (async (project, name, _body, log) => {
    await vector.deleteIndex(project, name, log);
    return noContent();
  }) as VectorOp,
  documents: (async (project, name, _body, _log, req) => json(await vector.listDocuments(project, name, new URL(req.url).searchParams))) as VectorOp,
  upsert: (async (project, name, body, log) => json(await vector.upsertDocuments(project, name, body, log))) as VectorOp,
  deleteDocuments: (async (project, name, body, log) => json(await vector.deleteDocuments(project, name, body, log))) as VectorOp,
  deleteDocument: (async (project, name, _body, log, req) => {
    await vector.deleteDocument(project, name, (req.params as { id: string }).id, log);
    return noContent();
  }) as VectorOp,
  query: (async (project, name, body, log) => json(await vector.query(project, name, body, log))) as VectorOp,
};

const createVectorOp = (source: "dashboard" | "api"): VectorOp =>
  async (project, _name, body, log) => {
    const { index, created } = await vector.createIndex(project, body, source, log);
    return json(index, created ? 201 : 200);
  };

/** A cron task route for apps (`createCronClient` in the SDK). */
const appCron = (handler: (req: BunRequest, log: Logger, project: string, body: string) => Promise<Response>) =>
  appRoute(MAX_APP_BODY, requireEnabled, handler);

const queueOps = {
  list: (async (project) => json(await queue.listQueues(project))) as QueueOp,
  get: (async (project, name) => json(await queue.getQueue(project, name))) as QueueOp,
  update: (async (project, name, body, log) => json(await queue.updateQueue(project, name, body, log))) as QueueOp,
  delete: (async (project, name, _body, log) => {
    await queue.deleteQueue(project, name, log);
    return noContent();
  }) as QueueOp,
  purge: (async (project, name, _body, log) => {
    await queue.purgeQueue(project, name, log);
    return noContent();
  }) as QueueOp,
  send: (async (project, name, body, log) => json(await queue.sendMessages(project, name, body, log))) as QueueOp,
  // Long polls outlast Bun's default 10 s idle timeout.
  receive: (async (project, name, body, _log, req, { server }) => {
    server.timeout(req, Math.ceil(queue.receiveWaitMs(body) / 1000) + 10);
    return json({ messages: await queue.receiveMessages(project, name, body, req.signal) });
  }) as QueueOp,
  deleteMessages: (async (project, name, body) => json(await queue.deleteMessages(project, name, body))) as QueueOp,
  visibility: (async (project, name, body) => json(await queue.changeVisibility(project, name, body))) as QueueOp,
  redrive: (async (project, name, body, log) => json(await queue.redrive(project, name, body, log))) as QueueOp,
};

const createQueueOp = (source: "dashboard" | "api"): QueueOp =>
  async (project, _name, body, log) => {
    const { queue: created, created: isNew } = await queue.createQueue(project, body, source, log);
    return json(created, isNew ? 201 : 200);
  };

// Secret values are a few KB each; a full env is up to 1000 keys of 64 KB.
const SECRETS_BODY_BYTES = 8 * 1024 * 1024;

const secretsEnv = (req: BunRequest) => (req.params as { env?: string }).env ?? "";

/** A dashboard/CLI secrets route (`/projects/:name/secrets/…`). */
const adminSecrets = (handler: (req: BunRequest, log: Logger, project: string, auth: Auth) => Promise<Response>) =>
  inProject((req, log, project, ctx) => handler(req, log, project, ctx.auth!));

/** A revision number from the path. */
function revisionParam(req: BunRequest): number {
  const n = Number((req.params as { rev?: string }).rev);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestError("revision must be a non-negative integer");
  return n;
}

const wantsValues = (req: Request) => new URL(req.url).searchParams.get("values") === "1";

/** `:id` or `by-key/:key` in a task route. */
const taskRef = (req: BunRequest): TaskRef => {
  const params = req.params as { id?: string; key?: string };
  return params.key !== undefined ? { key: params.key } : { id: params.id ?? "" };
};

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
/** `headers` gets the stored type, so active types can be turned into downloads (security-headers.ts). */
async function sendObject(req: Request, obj: S3File, headers: (type: string) => Record<string, string>): Promise<Response> {
  const stat = await obj.stat();
  const etag = stat.etag;
  if (etag && req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(obj.stream(), {
    headers: {
      "Content-Type": stat.type || "application/octet-stream",
      "Content-Length": String(stat.size),
      "Last-Modified": stat.lastModified.toUTCString(),
      ...(etag ? { ETag: etag } : {}),
      ...headers(stat.type),
    },
  });
}

await loadDocs();
await waitForPostgres(log);
await migrate(log);
await bootstrapAdmin(log);
await waitForGarage(log);
// Connecting also restores the cache's ACL users (cache.ts).
await waitForValkey(log);
await startScheduler();
await startTaskRunner();
startAnalytics();
await startAudit();
await startAlerts();
queue.startQueues();
await secrets.startSecrets(log);
await startMfa(log);
// After secrets (it seals keys with MYBASE_SECRETS_KEY): pg_hba.conf, and the public Postgres cert + DNS.
await startDbPublic(log);
sandbox.startSandboxes();

// Buffered analytics events, audit events, queue stats, and realtime webhooks would be lost on a plain exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    realtime.closeAllSockets();
    void Promise.allSettled([flushAnalytics(), flushAudit(), queue.flushQueueStats(), flushWebhooks(), sandbox.stopSandboxes()]).finally(() => process.exit(0));
  });
}

const server = Bun.serve({
  port: Number(process.env.API_PORT ?? 4000),
  routes: {
    "/health": logged(open(() => json({ ok: true, version: MYBASE_VERSION }), { anonymous: true })),
    "/sandbox/:project": {
      GET: logged(handled(async (req) => { const { project } = req.params as { project: string }; await sandbox.requireSandbox(project); return json(await sandbox.listSandboxes(project)); })),
      POST: logged(handled(async (req) => { const { project } = req.params as { project: string }; await sandbox.requireSandbox(project); return json(await sandbox.createSandbox(project, await sandboxJson(req) as unknown as import("@mybase-dev/sdk/sandbox").CreateSandbox),202); })),
    },
    "/sandbox/:project/usage": {
      GET: logged(handled(async req => { const { project } = req.params as { project: string }; await sandbox.requireSandbox(project); return json(await sandbox.sandboxUsage(project)); })),
    },
    "/sandbox/:project/:id": {
      GET: logged(sandboxRoute(async (req,p,id) => json(await sandbox.getSandbox(p,id)))),
      DELETE: logged(sandboxRoute(async (req,p,id) => json(await sandbox.terminateSandbox(p,id),202))),
    },
    "/sandbox/:project/:id/executions": {
      GET: logged(sandboxRoute(async (req,p,id) => json(await sandbox.listExecutions(p,id)))),
      POST: logged(sandboxRoute(async (req,p,id) => json(await sandbox.executeSandbox(p,id,await sandboxJson(req) as unknown as import("@mybase-dev/sdk/sandbox").ExecuteSandbox),202))),
    },
    "/sandbox/:project/:id/executions/:run": {
      GET: logged(sandboxRoute(async (req,p,id) => json(await sandbox.getExecution(p,id,(req.params as { run: string }).run)))),
      DELETE: logged(sandboxRoute(async (req,p,id) => json(await sandbox.cancelExecution(p,id,(req.params as { run: string }).run),202))),
    },
    "/sandbox/:project/:id/files": {
      GET: logged(sandboxRoute(async (req,p,id) => sandbox.workspaceFile(p,id,new URL(req.url).searchParams.get("path")))),
      PUT: logged(sandboxRoute(async (req,p,id) => sandbox.workspaceFile(p,id,new URL(req.url).searchParams.get("path"),await sandbox.readBoundedBody(req)))),
    },
    "/sandbox/:project/:id/artifacts": {
      GET: logged(sandboxRoute(async (req,p,id) => json(await sandbox.listArtifacts(p,id)))),
      POST: logged(sandboxRoute(async (req,p,id) => { const body = await sandboxJson(req); return json(await sandbox.exportArtifact(p,id,body.path,body.type),201); })),
    },
    "/sandbox/:project/:id/artifacts/:artifact": {
      GET: logged(sandboxRoute(async (req,p,id) => sandbox.downloadArtifact(p,id,(req.params as { artifact: string }).artifact))),
    },
    "/sandbox/:project/:id/browser": {
      POST: logged(sandboxRoute(async (req,p,id) => json(await sandbox.browserConnection(p,id)))),
      GET: logged(handled(async (req,_log,{ server }) => {
        const { project,id } = req.params as { project: string; id: string };
        await sandbox.requireSandbox(project);
        return upgradeSandboxBrowser(req,server,project,id);
      })),
    },
    // Docs for people and agents (docs.ts). Public: nothing in them is secret.
    "/llms.txt": { GET: logged(open(() => text(llmsTxt(publicApiUrl)), { anonymous: true })) },
    "/llms-full.txt": { GET: logged(open(() => text(llmsFullTxt(publicApiUrl)), { anonymous: true })) },
    "/docs": { GET: logged(open(() => json(listPages(publicApiUrl)), { anonymous: true })) },
    "/docs/search": {
      GET: logged(
        open(
          handled(async (req) => {
            const url = new URL(req.url);
            const q = url.searchParams.get("q")?.trim();
            if (!q) throw new BadRequestError("q is required");
            return json(searchDocs(q, publicApiUrl, intParam(url, "limit", 5, 1, 20)));
          }),
          { anonymous: true },
        ),
      ),
    },
    "/docs/*": {
      GET: logged(
        open(
          (req) => {
            const slug = decodeURIComponent(new URL(req.url).pathname.slice("/docs/".length)).replace(/\.md$/, "");
            const page = getPage(slug);
            return page ? text(renderPage(page, publicApiUrl), "text/markdown") : json({ error: `no docs page "${slug}"; see ${publicApiUrl}/llms.txt` }, 404);
          },
          { anonymous: true },
        ),
      ),
    },
    // Remote MCP server (mcp.ts). Each tool calls a REST route with the caller's key, which checks it.
    "/mcp": {
      POST: logged(async (req, log, { auth, server }) => handleMcp(req, { grant: auth!, credentials: req.headers, port: server.port!, log: log.child({ via: "mcp" }) })),
      GET: logged(async () => new Response(null, { status: 405, headers: { Allow: "POST" } })),
      DELETE: logged(async () => new Response(null, { status: 405, headers: { Allow: "POST" } })),
    },
    "/auth/me": {
      GET: logged(
        open(async (_req, _log, { auth }) => {
          const status: AuthStatus = {
            setupNeeded: !(await adminExists()),
            authenticated: auth !== null,
            username: auth ? await adminUsername() : null,
            permissions: auth ? [...auth.permissions] : null,
            projects: auth?.projects ? [...auth.projects] : null,
            environments: auth?.environments ? [...auth.environments] : null,
            ...(auth ? { mfa: await mfaStatus() } : {}),
          };
          return json(status);
        }),
      ),
    },
    // First run only, and only from this machine or the LAN: a fresh public instance can't be claimed by a stranger.
    "/auth/setup": {
      POST: logged(
        open(
          handled(async (req, log, { ip }) => {
            if (await adminExists()) throw new ConflictError("the admin account already exists");
            if (viaCloudflare(req) || !isPrivateIp(ip)) {
              throw new ForbiddenError("Create the admin account from this machine or your local network, or set MYBASE_ADMIN_PASSWORD.");
            }
            const { username, password } = await readJson(req);
            await createAdmin(username, password, log);
            return withCookie(json({ username }, 201), sessionCookie(req, await createSession()));
          }),
        ),
      ),
    },
    "/auth/login": {
      POST: logged(
        open(
          handled(async (req, log, { ip }) => {
            const wait = throttle.retryAfter(ip);
            if (wait) throw new TooManyRequestsError(`Too many failed sign-ins. Try again in ${wait} seconds.`, wait);
            const { username, password, tokenName } = await readJson(req);
            let name: string;
            try {
              name = await verifyAdmin(username, password);
            } catch (err) {
              if (err instanceof UnauthorizedError) {
                throttle.fail(ip);
                log.warn("sign-in failed", { ip });
                audit({ action: "auth.login", outcome: "failed", meta: { step: "password" } });
              }
              throw err;
            }
            // With 2FA on, the password only earns a challenge, and the throttle isn't reset until
            // the code checks out too: wrong codes and wrong passwords count against the same IP.
            if (await mfaEnabled()) {
              log.info("password accepted, code needed", { ip });
              audit({ action: "auth.login_mfa_required", outcome: "ok", actor: { kind: "anonymous", id: null, name } });
              return json({ username: name, mfaRequired: true, challenge: createChallenge(tokenName === undefined ? undefined : String(tokenName)) });
            }
            throttle.succeed(ip);
            return signedIn(req, log, ip, name, tokenName, false);
          }),
        ),
      ),
    },
    "/auth/login/mfa": {
      POST: logged(
        open(
          handled(async (req, log, { ip }) => {
            const wait = throttle.retryAfter(ip);
            if (wait) throw new TooManyRequestsError(`Too many failed sign-ins. Try again in ${wait} seconds.`, wait);
            const { challenge, code } = await readJson(req);
            let tokenName: string | undefined;
            try {
              ({ tokenName } = await completeChallenge(challenge, code, log));
            } catch (err) {
              if (err instanceof UnauthorizedError) {
                throttle.fail(ip);
                log.warn("2fa failed", { ip });
                audit({ action: "auth.login", outcome: "failed", meta: { step: "mfa" } });
              }
              throw err;
            }
            throttle.succeed(ip);
            return signedIn(req, log, ip, (await adminUsername()) ?? "admin", tokenName, true);
          }),
        ),
      ),
    },
    // 2FA settings. Browser sessions only: an API key (even an admin one) can't turn 2FA off or read new recovery codes.
    "/auth/mfa": {
      GET: logged(sessionOnly(async () => json(await mfaStatus()))),
    },
    "/auth/mfa/totp": {
      POST: logged(
        sessionOnly(async (req) => {
          const { password } = await readJson(req);
          return json(await startTotpSetup(password, req.headers.get("X-Forwarded-Host") ?? req.headers.get("Host") ?? "mybase"));
        }),
      ),
      DELETE: logged(
        sessionOnly(async (req, log) => {
          const { password, code } = await readJson(req);
          await disableTotp(password, code, log);
          return noContent();
        }),
      ),
    },
    "/auth/mfa/totp/confirm": {
      POST: logged(
        sessionOnly(async (req, log, { auth }) => {
          const { code } = await readJson(req);
          return json(await confirmTotpSetup(code, auth?.kind === "session" ? auth.sessionHash : null, log));
        }),
      ),
    },
    "/auth/mfa/recovery-codes": {
      POST: logged(
        sessionOnly(async (req, log) => {
          const { code } = await readJson(req);
          return json(await regenerateRecoveryCodes(code, log));
        }),
      ),
    },
    // Ends whatever the request signed in with: this browser's session, or the CLI's token.
    "/auth/logout": {
      POST: logged(async (req, log, { auth }) => {
        if (auth?.kind === "token") {
          await deleteToken(auth.tokenId, log);
          return noContent();
        }
        if (auth?.kind === "session") await deleteSession(auth.sessionHash);
        log.info("signed out");
        return withCookie(noContent(), sessionCookie(req, null));
      }),
    },
    "/auth/sessions": {
      // Sign out everywhere, this browser included.
      DELETE: logged(async (req, log) => {
        await deleteAllSessions();
        log.info("signed out all sessions");
        return withCookie(noContent(), sessionCookie(req, null));
      }),
    },
    "/auth/password": {
      PUT: logged(
        handled(async (req, log, { auth }) => {
          const { currentPassword, newPassword } = await readJson(req);
          await changePassword(currentPassword, newPassword, auth?.kind === "session" ? auth.sessionHash : null, log);
          return noContent();
        }),
      ),
    },
    "/auth/tokens": {
      GET: logged(async () => json(await listTokens())),
      POST: logged(
        handled(async (req, log) => {
          const { name, permissions, projects, environments } = await readJson(req);
          const created = await createToken({ name, permissions, projects, environments }, log);
          audit({
            action: "token.created",
            target: created.id,
            meta: { name: created.name, perms: created.permissions.join(","), projects: created.projects?.join(",") ?? null, admin: created.permissions.includes("admin") },
          });
          return json(created, 201);
        }),
      ),
    },
    "/auth/tokens/:id": {
      PATCH: logged(
        handled(async (req, log) => {
          const token = await updateToken((req.params as { id: string }).id, await readJson(req), log);
          return token ? json(token) : json({ error: "token not found" }, 404);
        }),
      ),
      DELETE: logged(async (req, log) => {
        if (!(await deleteToken((req.params as { id: string }).id, log))) return json({ error: "token not found" }, 404);
        return noContent();
      }),
    },
    // Postgres over WebSocket. Postgres itself checks the password; the proxy only lets project roles through.
    "/db": logged(open((req, log, { ip, server }) => upgradeDb(req, server, ip, log), { anonymous: true })),
    "/projects": {
      // A key limited to some projects sees only those.
      GET: logged(async (_req, _log, { auth }) => json((await listProjects()).filter((p) => canSeeProject(auth!, p.name)))),
      POST: logged(async (req, log) => {
        const { name } = (await req.json()) as CreateProjectRequest;
        if (!name) return json({ error: "name is required" }, 400);
        if (!PROJECT_NAME_PATTERN.test(name)) return json({ error: PROJECT_NAME_RULES }, 400);
        try {
          const project = await createProject(name, log);
          log.info("project created", { project: name, bucket: project.credentials.storage.bucket });
          audit({ action: "project.created", project: name });
          return json(project, 201);
        } catch (err) {
          if (err instanceof ProjectExistsError) return json({ error: err.message }, 409);
          throw err;
        }
      }),
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
        return noContent();
      }),
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
          return sendObject(req, file(project, key), (type) => ({ ...objectHeaders(type, name), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }));
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
          return noContent();
        }),
      ),
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
    },
    "/projects/:name/database/schema": {
      GET: logged(inProject(async (_req, _log, project) => json(await schemaOverview(project)))),
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
    },
    // Any key that can see the project; sections it may not read are left out.
    "/projects/:name/context": {
      GET: logged(async (req, log, ctx) => {
        // Checked before inProject's existence check, so a project-limited key can't learn
        // which other projects exist from 404 vs 403.
        const { name: project = "" } = req.params as { name?: string };
        if (!canSeeProject(ctx.auth!, project)) return json({ error: `this API key can't access project "${project}"` }, 403);
        return inProject(async (_req, _log, name, { auth }) => json(await projectContext(name, auth!)))(req, log, ctx);
      }),
    },
    // Audit log (audit.ts). A project-limited key sees only its projects' events.
    "/audit": {
      GET: logged(
        handled(async (req, _log, { auth }) => {
          const q = new URL(req.url).searchParams;
          return json(
            await listAudit({
              projects: auth!.projects,
              project: q.get("project"),
              action: q.get("action"),
              actor: q.get("actor"),
              outcome: q.get("outcome"),
              since: q.get("since"),
              before: q.get("before"),
              limit: q.has("limit") ? Number(q.get("limit")) : undefined,
            }),
          );
        }),
      ),
    },
    "/audit/settings": {
      GET: logged(async () => json(await getAuditSettings())),
      PUT: logged(handled(async (req) => json(await updateAuditSettings(await readJson(req))))),
    },
    // Security alerts (alerts.ts). Admin only: channel URLs get called by this server.
    "/alerts": {
      GET: logged(async () => json(await alertsOverview())),
    },
    "/alerts/channels": {
      POST: logged(handled(async (req, log) => json(await createChannel(await readJson(req), log), 201))),
    },
    "/alerts/channels/:id": {
      PATCH: logged(handled(async (req, log) => json(await updateChannel((req.params as { id: string }).id, await readJson(req), log)))),
      DELETE: logged(
        handled(async (req, log) => {
          await deleteChannel((req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
    },
    "/alerts/channels/:id/test": {
      POST: logged(handled(async (req) => json(await testChannel((req.params as { id: string }).id)))),
    },
    "/alerts/channels/:id/secret/rotate": {
      POST: logged(handled(async (req, log) => json(await rotateChannelSecret((req.params as { id: string }).id, log)))),
    },
    "/alerts/rules/:rule": {
      PUT: logged(
        handled(async (req, log) => {
          await setRule((req.params as { rule: string }).rule, await readJson(req), log);
          return json(await alertsOverview());
        }),
      ),
    },
    // Security advisor (advisor.ts): read-only checks. The instance report is admin-only (it
    // names API keys); one project's needs projects:read.
    "/advisor": {
      GET: logged(async (_req, log) => json(await fullReport(log))),
    },
    // Public Postgres (db-public.ts): certificate and DNS status. Admin only.
    "/database/public": {
      GET: logged(async () => json(dbPublicStatus())),
    },
    "/projects/:name/advisor": {
      GET: logged(inProject(async (_req, log, project) => json(await projectReport(project, log)))),
    },
    "/projects/:name/services/:id": {
      // Answers with the service's credentials (shown once) when it has any.
      PUT: logged(
        inProject(async (req, log, project) => {
          // Optional body: `{ link: true }` adds the service's keys to the linked secrets envs.
          const body = req.headers.get("Content-Type")?.includes("json") ? await readJson(req) : {};
          const result = await enableService(project, (req.params as { id: string }).id, log, { link: body.link === true });
          return result ? json(result) : noContent();
        }),
      ),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await disableService(project, (req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
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
    },
    "/projects/:name/cron/jobs/:job/run": {
      POST: logged(inProject(async (req, log, project) => json({ runId: await runNow(project, (req.params as { job: string }).job, log) }, 202))),
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
      POST: logged(
        inProject(async (_req, log, project) => {
          const secret = await rotateSecret(project, log);
          await relinkService(project, "cron", log);
          return json(secret);
        }),
      ),
    },
    "/projects/:name/cron/tasks": {
      GET: logged(
        inProject(async (req, _log, project) => {
          await requireEnabled(project);
          const url = new URL(req.url);
          const status = url.searchParams.get("status");
          if (status !== null && !(CRON_TASK_STATUSES as readonly string[]).includes(status)) {
            return json({ error: `status must be one of ${CRON_TASK_STATUSES.join(", ")}` }, 400);
          }
          return json(await listTasks(project, status as CronTaskStatus | null, intParam(url, "limit", 100, 1, 500)));
        }),
      ),
      POST: logged(
        inProject(async (req, log, project) => {
          await requireEnabled(project);
          const { task, created } = await createTask(project, await readJson(req), log);
          return json(task, created ? 201 : 200);
        }),
      ),
    },
    "/projects/:name/cron/tasks/:id": {
      GET: logged(inProject(async (req, _log, project) => json(await getTask(project, taskRef(req))))),
      // Cancels; the row stays (as cancelled) until pruned.
      DELETE: logged(inProject(async (req, log, project) => json(await cancelTask(project, taskRef(req), log)))),
    },
    // Apps schedule one-off tasks here, with an API key (`cron:write`).
    "/cron/:project/tasks": {
      POST: logged(
        appCron(async (_req, log, project, body) => {
          const { task, created } = await createTask(project, parseBody(body), log);
          return json(task, created ? 201 : 200);
        }),
      ),
    },
    "/cron/:project/tasks/:id": {
      GET: logged(appCron(async (req, _log, project) => json(await getTask(project, taskRef(req))))),
      DELETE: logged(appCron(async (req, log, project) => json(await cancelTask(project, taskRef(req), log)))),
    },
    "/cron/:project/tasks/by-key/:key": {
      GET: logged(appCron(async (req, _log, project) => json(await getTask(project, taskRef(req))))),
      DELETE: logged(appCron(async (req, log, project) => json(await cancelTask(project, taskRef(req), log)))),
    },
    "/projects/:name/analytics": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const url = new URL(req.url);
          return json(await analyticsOverview(project, readRange(url.searchParams.get("range")), readTimeZone(url.searchParams.get("tz"))));
        }),
      ),
    },
    "/projects/:name/analytics/events": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const url = new URL(req.url);
          const type = url.searchParams.get("type");
          if (type !== null && !(ANALYTICS_EVENT_TYPES as readonly string[]).includes(type)) {
            return json({ error: `type must be one of ${ANALYTICS_EVENT_TYPES.join(", ")}` }, 400);
          }
          return json(
            await listEvents(project, {
              type: type as (typeof ANALYTICS_EVENT_TYPES)[number] | null,
              name: url.searchParams.get("name"),
              fingerprint: url.searchParams.get("fingerprint"),
              limit: intParam(url, "limit", 50, 1, 200),
            }),
          );
        }),
      ),
      // Deletes every event; the key and settings stay.
      DELETE: logged(
        inProject(async (_req, log, project) => {
          await clearEvents(project, log);
          return noContent();
        }),
      ),
    },
    "/projects/:name/analytics/settings": {
      GET: logged(inProject(async (_req, _log, project) => json(await getSettings(project)))),
      PATCH: logged(inProject(async (req, log, project) => json(await updateSettings(project, await readJson(req), log)))),
    },
    "/projects/:name/analytics/key/rotate": {
      POST: logged(
        inProject(async (_req, log, project) => {
          const settings = await rotateKey(project, log);
          await relinkService(project, "analytics", log);
          return json(settings);
        }),
      ),
    },
    // Apps send events here from browsers and servers, with the project's public write key.
    "/analytics/:project/events": {
      OPTIONS: logged(fromBrowser(async () => noContent())),
      POST: logged(
        fromBrowser(async (req, _log, { ip }) => {
          const { project = "" } = req.params as { project?: string };
          if (!PROJECT_NAME_PATTERN.test(project)) throw new UnauthorizedError("invalid write key for this project");
          if (Number(req.headers.get("content-length") ?? 0) > ANALYTICS_LIMITS.bodyBytes) return json({ error: "body too large" }, 413);
          const body = await req.text();
          if (body.length > ANALYTICS_LIMITS.bodyBytes) return json({ error: "body too large" }, 413);
          const accepted = await ingest(project, body, {
            ip,
            userAgent: req.headers.get("User-Agent"),
            origin: req.headers.get("Origin"),
            country: trustedCountry(req),
          });
          return json({ accepted }, 202);
        }),
      ),
    },
    // The script-tag build of the analytics client.
    "/analytics.js": {
      GET: logged(
        open(
          async () =>
            new Response(await analyticsScript(), {
              headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", ...publicCors },
            }),
          { anonymous: true },
        ),
      ),
    },
    "/projects/:name/cache": {
      GET: logged(inProject(async (_req, _log, project) => json(await cacheOverview(project)))),
    },
    "/projects/:name/cache/password/rotate": {
      POST: logged(
        inProject(async (_req, log, project) => {
          const credentials = await rotatePassword(project, log);
          await relinkService(project, "cache", log, credentials.url);
          return json(credentials);
        }),
      ),
    },
    "/projects/:name/cache/keys": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const url = new URL(req.url);
          return json(await listKeys(project, url.searchParams.get("cursor") ?? "0", url.searchParams.get("match"), intParam(url, "count", 100, 1, 500)));
        }),
      ),
    },
    // One key, as `?key=` (keys can hold any character, `/` included).
    "/projects/:name/cache/key": {
      GET: logged(inProject(async (req, _log, project) => json(await getKey(project, new URL(req.url).searchParams.get("key"))))),
      PUT: logged(inProject(async (req, log, project) => json(await putKey(project, new URL(req.url).searchParams.get("key"), await readJson(req), log)))),
      PATCH: logged(inProject(async (req, _log, project) => json(await setKeyTtl(project, new URL(req.url).searchParams.get("key"), await readJson(req))))),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await deleteKey(project, new URL(req.url).searchParams.get("key"), log);
          return noContent();
        }),
      ),
    },
    // Apps run cache commands over HTTP (Upstash REST format), with an API key (`cache:write`).
    "/cache/:project": {
      POST: logged(
        appRoute(CACHE_BODY_BYTES, requireCache, async (_req, _log, project, body) => {
          const reply = await httpCommand(project, parseAny(body));
          return json(reply, "error" in reply ? 400 : 200);
        }),
      ),
    },
    "/cache/:project/pipeline": {
      POST: logged(appRoute(CACHE_BODY_BYTES, requireCache, async (_req, _log, project, body) => json(await httpPipeline(project, parseAny(body))))),
    },
    "/cache/:project/multi-exec": {
      POST: logged(appRoute(CACHE_BODY_BYTES, requireCache, async (_req, _log, project, body) => json(await httpMultiExec(project, parseAny(body))))),
    },
    "/projects/:name/ratelimit": {
      GET: logged(inProject(async (_req, _log, project) => json(await ratelimit.getSettings(project)))),
    },
    "/projects/:name/ratelimit/rules": {
      GET: logged(inProject(async (_req, _log, project) => json(await ratelimit.listRules(project)))),
      POST: logged(inProject(async (req, log, project) => json(await ratelimit.createRule(project, await readJson(req), log), 201))),
      // Replaces the code-defined rules (`mybase ratelimit sync`).
      PUT: logged(
        inProject(async (req, log, project) => {
          const { rules, dryRun = false } = await readJson(req);
          if (typeof dryRun !== "boolean") return json({ error: "dryRun must be true or false" }, 400);
          return json(await ratelimit.syncRules(project, rules, dryRun, log));
        }),
      ),
    },
    "/projects/:name/ratelimit/rules/:rule": {
      PATCH: logged(inProject(async (req, log, project) => json(await ratelimit.updateRule(project, (req.params as { rule: string }).rule, await readJson(req), log)))),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await ratelimit.deleteRule(project, (req.params as { rule: string }).rule, log);
          return noContent();
        }),
      ),
    },
    "/projects/:name/ratelimit/stats": {
      GET: logged(inProject(async (req, _log, project) => json(await ratelimit.stats(project, ratelimit.readStatsRange(new URL(req.url).searchParams.get("range")))))),
    },
    // The dashboard's "try it": a real check, counted like an app's.
    "/projects/:name/ratelimit/test": {
      POST: logged(
        inProject(async (req, _log, project) => {
          await ratelimit.requireEnabled(project);
          return json(await ratelimit.check(project, await readJson(req)));
        }),
      ),
    },
    // Apps check limits here (`createRateLimiter` in the SDK), with an API key (`ratelimit:write`).
    "/ratelimit/:project/limit": {
      POST: logged(appRoute(4096, ratelimit.requireEnabled, async (_req, _log, project, body) => json(await ratelimit.check(project, parseBody(body))))),
    },
    // The dashboard's Try it panel: the same searches and page reads, signed in as the admin.
    "/projects/:name/search": {
      GET: logged(
        handled(
          inProject(async (req, log, project, { server }) => {
            await search.requireEnabled(project);
            server.timeout(req, 30);
            return json(await search.search(project, search.parseSearchParams(new URL(req.url).searchParams), log));
          }),
        ),
      ),
    },
    "/projects/:name/search/fetch": {
      GET: logged(
        handled(
          inProject(async (req, log, project, { server }) => {
            await search.requireEnabled(project);
            server.timeout(req, 30);
            return json(await search.fetchPage(project, search.parseFetchParams(new URL(req.url).searchParams), log));
          }),
        ),
      ),
    },
    // Apps (agents) search the web and read pages here (`createSearchClient` in the SDK), with an
    // API key (`search:read`). Both can outlast Bun's default 10 s idle timeout.
    "/search/:project": {
      GET: logged(
        appRoute(0, search.requireEnabled, async (req, log, project, _body, { server }) => {
          server.timeout(req, 30);
          return json(await search.search(project, search.parseSearchParams(new URL(req.url).searchParams), log));
        }),
      ),
    },
    "/search/:project/fetch": {
      GET: logged(
        appRoute(0, search.requireEnabled, async (req, log, project, _body, { server }) => {
          server.timeout(req, 30);
          return json(await search.fetchPage(project, search.parseFetchParams(new URL(req.url).searchParams), log));
        }),
      ),
    },
    "/projects/:name/queue": {
      GET: logged(inProject(async (_req, _log, project) => json(await queue.getSettings(project)))),
    },
    "/projects/:name/queue/stats": {
      GET: logged(inProject(async (req, _log, project) => json(await queue.stats(project, queue.readStatsRange(new URL(req.url).searchParams.get("range")))))),
    },
    "/projects/:name/queue/queues": {
      GET: logged(adminQueue(queueOps.list)),
      POST: logged(adminQueue(createQueueOp("dashboard"))),
      // Replaces the code-defined queues (`mybase queue sync`).
      PUT: logged(
        inProject(async (req, log, project) => {
          const { queues, dryRun = false } = await readJson(req);
          if (typeof dryRun !== "boolean") return json({ error: "dryRun must be true or false" }, 400);
          return json(await queue.syncQueues(project, queues, dryRun, log));
        }),
      ),
    },
    "/projects/:name/queue/queues/:queue": {
      GET: logged(adminQueue(queueOps.get)),
      PATCH: logged(adminQueue(queueOps.update)),
      DELETE: logged(adminQueue(queueOps.delete)),
    },
    "/projects/:name/queue/queues/:queue/messages": {
      // Peek: lists messages without receiving them.
      GET: logged(
        adminQueue(async (project, name, _body, _log, req) => json(await queue.peekMessages(project, name, intParam(new URL(req.url), "limit", 50, 1, 200)))),
      ),
      POST: logged(adminQueue(queueOps.send)),
    },
    "/projects/:name/queue/queues/:queue/messages/:id": {
      DELETE: logged(
        adminQueue(async (project, name, _body, log, req) => {
          await queue.deleteMessageById(project, name, (req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
    },
    "/projects/:name/queue/queues/:queue/receive": { POST: logged(adminQueue(queueOps.receive)) },
    "/projects/:name/queue/queues/:queue/delete": { POST: logged(adminQueue(queueOps.deleteMessages)) },
    "/projects/:name/queue/queues/:queue/visibility": { POST: logged(adminQueue(queueOps.visibility)) },
    "/projects/:name/queue/queues/:queue/purge": { POST: logged(adminQueue(queueOps.purge)) },
    "/projects/:name/queue/queues/:queue/redrive": { POST: logged(adminQueue(queueOps.redrive)) },
    // Apps use their queues here (`createQueueClient` in the SDK), with an API key (`queue:read|write`).
    "/queue/:project/queues": {
      GET: logged(appQueue(queueOps.list)),
      POST: logged(appQueue(createQueueOp("api"))),
    },
    "/queue/:project/queues/:queue": {
      GET: logged(appQueue(queueOps.get)),
      PATCH: logged(appQueue(queueOps.update)),
      DELETE: logged(appQueue(queueOps.delete)),
    },
    "/queue/:project/queues/:queue/messages": { POST: logged(appQueue(queueOps.send)) },
    "/queue/:project/queues/:queue/receive": { POST: logged(appQueue(queueOps.receive)) },
    "/queue/:project/queues/:queue/delete": { POST: logged(appQueue(queueOps.deleteMessages)) },
    "/queue/:project/queues/:queue/visibility": { POST: logged(appQueue(queueOps.visibility)) },
    "/queue/:project/queues/:queue/purge": { POST: logged(appQueue(queueOps.purge)) },
    "/queue/:project/queues/:queue/redrive": { POST: logged(appQueue(queueOps.redrive)) },
    "/projects/:name/vector": {
      GET: logged(inProject(async (_req, _log, project) => json(await vector.getSettings(project)))),
      // The embedding provider (admin only: the server calls its URL).
      PUT: logged(inProject(async (req, log, project) => json(await vector.updateSettings(project, await readJson(req), log)))),
    },
    "/projects/:name/vector/indexes": {
      GET: logged(adminVector(vectorOps.list)),
      POST: logged(adminVector(createVectorOp("dashboard"))),
      // Replaces the code-defined indexes (`mybase vector sync`).
      PUT: logged(
        inProject(async (req, log, project) => {
          const { indexes, dryRun = false } = await readJson(req);
          if (typeof dryRun !== "boolean") return json({ error: "dryRun must be true or false" }, 400);
          return json(await vector.syncIndexes(project, indexes, dryRun, log));
        }),
      ),
    },
    "/projects/:name/vector/indexes/:index": {
      GET: logged(adminVector(vectorOps.get)),
      PATCH: logged(adminVector(vectorOps.update)),
      DELETE: logged(adminVector(vectorOps.delete)),
    },
    "/projects/:name/vector/indexes/:index/documents": {
      GET: logged(adminVector(vectorOps.documents)),
      POST: logged(adminVector(vectorOps.upsert)),
    },
    "/projects/:name/vector/indexes/:index/documents/delete": { POST: logged(adminVector(vectorOps.deleteDocuments)) },
    "/projects/:name/vector/indexes/:index/documents/:id": { DELETE: logged(adminVector(vectorOps.deleteDocument)) },
    "/projects/:name/vector/indexes/:index/query": { POST: logged(adminVector(vectorOps.query)) },
    // Apps use their indexes here (`createVectorClient` in the SDK), with an API key (`vector:read|write`).
    "/vector/:project/indexes": {
      GET: logged(appVector(vectorOps.list)),
      POST: logged(appVector(createVectorOp("api"))),
    },
    "/vector/:project/indexes/:index": {
      GET: logged(appVector(vectorOps.get)),
      PATCH: logged(appVector(vectorOps.update)),
      DELETE: logged(appVector(vectorOps.delete)),
    },
    "/vector/:project/indexes/:index/documents": {
      GET: logged(appVector(vectorOps.documents)),
      POST: logged(appVector(vectorOps.upsert)),
    },
    "/vector/:project/indexes/:index/documents/delete": { POST: logged(appVector(vectorOps.deleteDocuments)) },
    "/vector/:project/indexes/:index/documents/:id": { DELETE: logged(appVector(vectorOps.deleteDocument)) },
    "/vector/:project/indexes/:index/query": { POST: logged(appVector(vectorOps.query)) },
    "/projects/:name/secrets": {
      GET: logged(adminSecrets(async (_req, _log, project, auth) => json(await secrets.overview(project, auth)))),
    },
    "/projects/:name/secrets/envs": {
      POST: logged(adminSecrets(async (req, log, project, auth) => json(await secrets.createEnv(project, await readJson(req), auth, log), 201))),
    },
    "/projects/:name/secrets/envs/:env": {
      GET: logged(adminSecrets(async (req, _log, project, auth) => json(await secrets.getEnv(project, secretsEnv(req), auth, wantsValues(req))))),
      // Renames.
      PATCH: logged(adminSecrets(async (req, log, project, auth) => json(await secrets.renameEnv(project, secretsEnv(req), await readJson(req), auth, log)))),
      DELETE: logged(
        adminSecrets(async (req, log, project, auth) => {
          await secrets.deleteEnv(project, secretsEnv(req), auth, log);
          return noContent();
        }),
      ),
    },
    "/projects/:name/secrets/envs/:env/secrets": {
      PATCH: logged(adminSecrets(async (req, log, project, auth) => json(await secrets.updateSecrets(project, secretsEnv(req), await readJson(req), auth, log)))),
    },
    "/projects/:name/secrets/envs/:env/revisions": {
      GET: logged(
        adminSecrets(async (req, _log, project, auth) => {
          const url = new URL(req.url);
          const before = url.searchParams.has("before") ? intParam(url, "before", 0, 1, 2 ** 31 - 1) : null;
          return json(await secrets.listRevisions(project, secretsEnv(req), auth, intParam(url, "limit", 50, 1, 200), before));
        }),
      ),
    },
    "/projects/:name/secrets/envs/:env/revisions/:rev": {
      GET: logged(adminSecrets(async (req, _log, project, auth) => json(await secrets.getRevision(project, secretsEnv(req), revisionParam(req), auth, wantsValues(req))))),
    },
    "/projects/:name/secrets/envs/:env/revisions/:rev/restore": {
      POST: logged(adminSecrets(async (req, log, project, auth) => json(await secrets.restoreRevision(project, secretsEnv(req), revisionParam(req), auth, log)))),
    },
    // Rotates the project's credentials and stores them in the given envs.
    "/projects/:name/secrets/link": {
      POST: logged(adminSecrets(async (req, log, project, auth) => json(await linkCredentials(project, await readJson(req), auth, log)))),
    },
    "/projects/:name/secrets/link/:env": {
      DELETE: logged(
        adminSecrets(async (req, log, project, auth) => {
          await unlinkEnv(project, secretsEnv(req), auth, log);
          return noContent();
        }),
      ),
    },
    // Apps and `mybase run` read an env here (`createSecretsClient` in the SDK), with an API key
    // (`secrets:read`, `secrets:write` to change values). ETag + If-None-Match make polling cheap.
    "/secrets/:project/:env": {
      GET: logged(
        appRoute(0, secrets.requireEnabled, async (req, _log, project, _body, { auth }) => {
          const { etag, body } = await secrets.resolve(project, secretsEnv(req), auth!, req.headers.get("If-None-Match"));
          const headers = { ETag: etag, "Cache-Control": "no-store" };
          return body ? Response.json(body, { headers }) : new Response(null, { status: 304, headers });
        }),
      ),
      PATCH: logged(
        appRoute(SECRETS_BODY_BYTES, secrets.requireEnabled, async (req, log, project, body, { auth }) =>
          json(await secrets.updateSecrets(project, secretsEnv(req), parseBody(body), auth!, log)),
        ),
      ),
    },
    "/secrets/:project/:env/:key": {
      GET: logged(
        appRoute(0, secrets.requireEnabled, async (req, _log, project, _body, { auth }) =>
          json(await secrets.getValue(project, secretsEnv(req), (req.params as { key: string }).key, auth!)),
        ),
      ),
    },
    // Users (users.ts): the app's own users, signed in by Better Auth in the app.
    "/projects/:name/users": {
      GET: logged(inProject(async (_req, _log, project) => json(await users.usersOverview(project)))),
    },
    "/projects/:name/users/accounts": {
      GET: logged(
        inProject(async (req, _log, project) => {
          const q = new URL(req.url).searchParams;
          return json(await users.listUsers(project, { search: q.get("search"), limit: Number(q.get("limit") ?? 50), offset: Number(q.get("offset") ?? 0) }));
        }),
      ),
    },
    "/projects/:name/users/accounts/:id": {
      GET: logged(inProject(async (req, _log, project) => json(await users.getUser(project, (req.params as { id: string }).id)))),
      PATCH: logged(inProject(async (req, log, project) => json(await users.setBanned(project, (req.params as { id: string }).id, await readJson(req), log)))),
      DELETE: logged(
        inProject(async (req, log, project) => {
          await users.deleteUser(project, (req.params as { id: string }).id, log);
          return noContent();
        }),
      ),
    },
    "/projects/:name/users/accounts/:id/sessions": {
      DELETE: logged(inProject(async (req, log, project) => json(await users.revokeAllSessions(project, (req.params as { id: string }).id, log)))),
    },
    "/projects/:name/users/accounts/:id/sessions/:session": {
      DELETE: logged(
        inProject(async (req, log, project) => {
          const { id, session } = req.params as { id: string; session: string };
          await users.revokeSession(project, id, session, log);
          return noContent();
        }),
      ),
    },
    // Sign-in events from the app's Better Auth (`mybaseAuth()` in the SDK), with `users:write`.
    "/users/:project/events": {
      POST: logged(appRoute(32 * 1024, users.requireEnabled, async (_req, _log, project, body) => json({ accepted: users.recordEvents(project, parseAny(body)) }, 202))),
    },
    // Captcha (captcha.ts). Challenges and the widget are public (browsers fetch them from the app's
    // pages); verify takes an API key; siteverify takes the captcha secret (Better Auth calls it).
    "/projects/:name/captcha": {
      GET: logged(inProject(async (_req, _log, project) => json(await captcha.getSettings(project)))),
      PATCH: logged(inProject(async (req, log, project) => json(await captcha.updateSettings(project, await readJson(req), log)))),
    },
    "/projects/:name/captcha/secret/rotate": {
      POST: logged(
        inProject(async (_req, log, project) => {
          const settings = await captcha.rotateSecret(project, log);
          await relinkService(project, "captcha", log);
          return json(settings);
        }),
      ),
    },
    "/captcha/:project/challenge": {
      GET: logged(
        open(
          handled(async (req, _log, { ip }) => {
            const { project = "" } = req.params as { project?: string };
            if (!PROJECT_NAME_PATTERN.test(project)) return json({ error: "not found" }, 404);
            if (!challengeLimit.take(ip)) return Response.json({ error: "too many challenges; try again in a minute" }, { status: 429, headers: { "Retry-After": "60", ...publicCors } });
            const challenge = await captcha.createChallenge(project);
            return Response.json(challenge, { headers: { "Cache-Control": "no-store", ...publicCors } });
          }),
          { anonymous: true },
        ),
      ),
    },
    "/captcha/:project/verify": {
      POST: logged(appRoute(4096, captcha.requireEnabled, async (_req, _log, project, body) => json(await captcha.verifyToken(project, (parseAny(body) as { token?: unknown })?.token)))),
    },
    "/captcha/:project/siteverify": {
      POST: logged(
        open(
          handled(async (req, _log, { ip }) => {
            const { project = "" } = req.params as { project?: string };
            if (!PROJECT_NAME_PATTERN.test(project)) return json({ error: "not found" }, 404);
            if (!siteVerifyLimit.take(ip)) return Response.json({ success: false, "error-codes": ["too-many-requests"] }, { status: 429, headers: { "Retry-After": "60" } });
            return captcha.siteVerify(project, req);
          }),
          { anonymous: true },
        ),
      ),
    },
    // Realtime (realtime.ts). The socket is public (browsers connect from the app's pages, then
    // send a token the app signed); publishing and channel lists take an API key.
    "/realtime/:project": {
      GET: logged(open((req, log, { ip, server }) => realtime.upgradeRealtime(req, server, ip, log), { anonymous: true, crossSite: true })),
    },
    "/realtime/:project/publish": {
      POST: logged(appRoute(REALTIME_PUBLISH_BYTES, realtime.requireEnabled, async (_req, _log, project, body) => json(realtime.publish(project, parseBody(body))))),
    },
    "/realtime/:project/channels": {
      GET: logged(appRoute(0, realtime.requireEnabled, async (req, _log, project) => json({ channels: realtime.listChannels(project, new URL(req.url).searchParams.get("prefix") ?? "") }))),
    },
    "/realtime/:project/channels/:channel/members": {
      GET: logged(appRoute(0, realtime.requireEnabled, async (req, _log, project) => json({ members: realtime.listMembers(project, (req.params as { channel: string }).channel) }))),
    },
    "/projects/:name/realtime": {
      GET: logged(inProject(async (_req, _log, project) => json(await realtime.getSettings(project)))),
      PATCH: logged(inProject(async (req, log, project) => json(await realtime.updateSettings(project, await readJson(req), log)))),
    },
    "/projects/:name/realtime/stats": {
      GET: logged(inProject(async (_req, _log, project) => {
        await realtime.requireEnabled(project);
        return json(realtime.getStats(project));
      })),
    },
    "/projects/:name/realtime/channels": {
      GET: logged(inProject(async (req, _log, project) => {
        await realtime.requireEnabled(project);
        return json({ channels: realtime.listChannels(project, new URL(req.url).searchParams.get("prefix") ?? "") });
      })),
    },
    "/projects/:name/realtime/channels/:channel/members": {
      GET: logged(inProject(async (req, _log, project) => {
        await realtime.requireEnabled(project);
        return json({ members: realtime.listMembers(project, (req.params as { channel: string }).channel) });
      })),
    },
    "/projects/:name/realtime/publish": {
      POST: logged(inProject(async (req, _log, project) => {
        await realtime.requireEnabled(project);
        return json(realtime.publish(project, await readJson(req)));
      })),
    },
    // A 5-minute token for the dashboard's try-it panel (any channel).
    "/projects/:name/realtime/token": {
      POST: logged(inProject(async (_req, _log, project) => json(await realtime.dashboardToken(project)))),
    },
    "/projects/:name/realtime/secret/rotate": {
      POST: logged(
        inProject(async (_req, log, project) => {
          const settings = await realtime.rotateSecret(project, log);
          await relinkService(project, "realtime", log);
          return json(settings);
        }),
      ),
    },
    "/captcha.js": {
      GET: logged(
        open(
          async () =>
            new Response(await captcha.captchaScript(), {
              headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", ...publicCors },
            }),
          { anonymous: true },
        ),
      ),
    },
    // Unauthenticated reads, limited to the `public/` prefix.
    "/storage/:name/public/*": {
      GET: logged(
        open(
          storage(async (req, _log, project) => {
            const rest = objectKey(req, `/storage/${project}/${PUBLIC_PREFIX}`);
            if (!rest) return json({ error: "not found" }, 404);
            const name = rest.slice(rest.lastIndexOf("/") + 1);
            return sendObject(req, file(project, PUBLIC_PREFIX + rest), (type) => ({ ...objectHeaders(type, name), "Cache-Control": "public, max-age=300", ...publicCors }));
          }),
          { anonymous: true },
        ),
      ),
    },
  },
  // The dashboard's files are public; the app itself asks the API who's signed in.
  fetch: logged(open(serveDashboard, { anonymous: true })),
  websocket,
  // Uploads stream through the API to storage.
  maxRequestBodySize: Number(process.env.MYBASE_MAX_UPLOAD ?? 1024 ** 3),
});

realtime.setRealtimeServer(server);

log.info("listening", { url: server.url.href, logLevel: process.env.LOG_LEVEL ?? "info", dashboard: dashboardDir ?? "off" });

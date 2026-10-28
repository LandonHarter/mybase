// The audit log: who did what. Every request that changes something is recorded automatically
// (`finishRequest`, called by `logged()` in index.ts) with an action derived from its route;
// handlers that know more call `audit()` to record their own event instead (sign-in results,
// secret reads). Events are buffered in memory and written as one insert every 10 s or 500
// events (SD card), like analytics. `onAudit` listeners (alerts.ts) see events before buffering.
//
// Never record secret values, passwords, SQL text, row values, or request bodies: `meta` is
// for counts, names, and flags, and keys that look like secrets are dropped (`cleanMeta`).
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActorKind, AuditEventList, AuditEventRecord, AuditOutcome, AuditSettings } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { BadRequestError } from "./errors";
import { sql } from "./postgres";

const log = createLogger("audit");

const FLUSH_EVERY_MS = 10_000;
const FLUSH_AT = 500;
const MAX_BUFFERED = 10_000;
const MAX_LIST = 200;

export type AuditMeta = Record<string, string | number | boolean | null>;

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  name: string | null;
}

/** What a handler (or any module during a request) reports. */
export interface AuditInput {
  action: string;
  /** Default: from the response status (< 400 ok, 401/403/429 denied, else failed). */
  outcome?: AuditOutcome;
  project?: string | null;
  target?: string | null;
  meta?: AuditMeta;
  /** Overrides the request's actor, e.g. the admin who just signed in. */
  actor?: AuditActor;
  /** For events outside a request (WebSocket messages). */
  ip?: string;
}

/** A finished event, as listeners see it and as it's stored. */
export interface AuditEvent {
  at: Date;
  actor: AuditActor;
  ip: string | null;
  action: string;
  outcome: AuditOutcome;
  project: string | null;
  target: string | null;
  meta: AuditMeta | null;
  requestId: string | null;
}

interface RequestScope {
  actor: AuditActor;
  ip: string;
  requestId: string;
  events: AuditInput[];
}

const scope = new AsyncLocalStorage<RequestScope>();

export const SYSTEM_ACTOR: AuditActor = { kind: "system", id: null, name: "mybase" };
export const ANONYMOUS: AuditActor = { kind: "anonymous", id: null, name: null };

// ---- recording --------------------------------------------------------------

const SECRET_KEY = /pass|secret|token|sql|query|value|body|cookie|authorization|credential/i;

/** Drops meta keys that could hold secrets, and anything that isn't a plain scalar. */
export function cleanMeta(meta: AuditMeta | undefined): AuditMeta | null {
  if (!meta) return null;
  const out: AuditMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY.test(key)) {
      log.warn("audit meta key dropped", { key });
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

export const outcomeFor = (status: number): AuditOutcome => (status < 400 ? "ok" : status === 401 || status === 403 || status === 429 ? "denied" : "failed");

/** Runs a request's handler with an audit scope, so `audit()` calls inside it know the actor. */
export function withAuditScope<T>(actor: AuditActor, ip: string, requestId: string, fn: () => T): T {
  return scope.run({ actor, ip, requestId, events: [] }, fn);
}

/** Runs `fn` outside any request's scope (background work started during a request). */
export const outsideRequest = <T>(fn: () => T): T => scope.exit(fn);

/** Sets the actor for the rest of the request (once `logged()` knows who's signed in). */
export function setAuditActor(actor: AuditActor) {
  const current = scope.getStore();
  if (current) current.actor = actor;
}

/**
 * Records an event. Inside a request it's written when the request ends (with the response's
 * outcome unless one is given), and replaces the automatic event for that request. Outside one
 * (timers, boot) it's recorded right away as mybase itself.
 */
export function audit(input: AuditInput) {
  const current = scope.getStore();
  if (current) current.events.push(input);
  else record(input, SYSTEM_ACTOR, null, null, input.outcome ?? "ok");
}

// Events recorded at most once per key per window (an app polling its secrets every minute).
const recent = new Map<string, number>();

/** `audit`, at most once per `key` per `windowMs` for the current actor. */
export function auditOnce(key: string, windowMs: number, input: AuditInput) {
  const actor = scope.getStore()?.actor;
  key = `${actor?.kind}:${actor?.id}:${key}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now) return;
  if (recent.size > 10_000) for (const [k, until] of recent) if (until <= now) recent.delete(k);
  recent.set(key, now + windowMs);
  audit(input);
}

type Listener = (event: AuditEvent) => void;
const listeners = new Set<Listener>();

/** Called with every event as it's recorded (alerts.ts). Listeners must not throw or block. */
export function onAudit(listener: Listener) {
  listeners.add(listener);
}

function record(input: AuditInput, actor: AuditActor, ip: string | null, requestId: string | null, outcome: AuditOutcome) {
  const event: AuditEvent = {
    at: new Date(),
    actor: input.actor ?? actor,
    ip: input.ip ?? ip,
    action: input.action,
    outcome: input.outcome ?? outcome,
    project: input.project ?? null,
    target: input.target?.slice(0, 300) ?? null,
    meta: cleanMeta(input.meta),
    requestId,
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.error("audit listener failed", { err });
    }
  }
  push(event);
}

// ---- automatic events -------------------------------------------------------

/** High-volume app calls and reads that only look like writes: not recorded automatically. */
const SKIP: RegExp[] = [
  /^\/analytics\/[^/]+\/events$/,
  /^\/cache\/[^/]+(\/.*)?$/,
  /^\/ratelimit\/[^/]+\/limit$/,
  /^\/queue\/[^/]+\/queues\/[^/]+\/(messages|receive|delete|visibility)$/,
  /^\/vector\/[^/]+\/indexes\/[^/]+\/(documents|documents\/delete|documents\/[^/]+|query)$/,
  /^\/projects\/[^/]+\/vector\/indexes\/[^/]+\/query$/,
  /^\/projects\/[^/]+\/ratelimit\/test$/,
  /^\/projects\/[^/]+\/cache\/key$/,
  /^\/cron\/[^/]+\/tasks(\/.*)?$/,
  /^\/captcha\/[^/]+\/.*$/,
  /^\/users\/[^/]+\/events$/,
  /^\/mcp$/,
];

/** [method, path, action, target from the match]. First match wins; methods `*` = any write. */
const RULES: [string, RegExp, string, ((m: RegExpExecArray) => string | null)?][] = [
  ["POST", /^\/auth\/setup$/, "auth.setup"],
  ["POST", /^\/auth\/login$/, "auth.login"],
  ["POST", /^\/auth\/login\/mfa$/, "auth.login"],
  ["POST", /^\/auth\/logout$/, "auth.logout"],
  ["DELETE", /^\/auth\/sessions$/, "auth.logout_all"],
  ["PUT", /^\/auth\/password$/, "auth.password_changed"],
  ["POST", /^\/auth\/mfa\/totp$/, "mfa.setup_started"],
  ["POST", /^\/auth\/mfa\/totp\/confirm$/, "mfa.enabled"],
  ["DELETE", /^\/auth\/mfa\/totp$/, "mfa.disabled"],
  ["POST", /^\/auth\/mfa\/recovery-codes$/, "mfa.recovery_regenerated"],
  ["POST", /^\/auth\/tokens$/, "token.created"],
  ["PATCH", /^\/auth\/tokens\/([^/]+)$/, "token.updated", (m) => m[1]!],
  ["DELETE", /^\/auth\/tokens\/([^/]+)$/, "token.deleted", (m) => m[1]!],
  ["DELETE", /^\/projects\/[^/]+$/, "project.deleted"],
  ["PUT", /^\/projects\/[^/]+\/services\/([^/]+)$/, "service.enabled", (m) => m[1]!],
  ["DELETE", /^\/projects\/[^/]+\/services\/([^/]+)$/, "service.disabled", (m) => m[1]!],
  ["PUT", /^\/projects\/[^/]+\/files\/(.+)$/, "storage.uploaded", (m) => decodeURIComponent(m[1]!)],
  ["DELETE", /^\/projects\/[^/]+\/files\/(.+)$/, "storage.deleted", (m) => decodeURIComponent(m[1]!)],
  ["POST", /^\/projects\/[^/]+\/database\/query$/, "database.sql"],
  ["*", /^\/projects\/[^/]+\/database\/tables\/([^/]+)\/([^/]+)\/rows$/, "database.rows_changed", (m) => `${decodeURIComponent(m[1]!)}.${decodeURIComponent(m[2]!)}`],
  ["PUT", /^\/projects\/[^/]+\/database\/extensions\/([^/]+)$/, "database.extension_enabled", (m) => m[1]!],
  ["DELETE", /^\/projects\/[^/]+\/database\/extensions\/([^/]+)$/, "database.extension_disabled", (m) => m[1]!],
  ["PATCH", /^\/projects\/[^/]+\/database$/, "database.settings_changed"],
  ["POST", /^\/projects\/[^/]+\/secrets\/envs$/, "secrets.env_created"],
  ["PATCH", /^\/projects\/[^/]+\/secrets\/envs\/([^/]+)$/, "secrets.env_renamed", (m) => m[1]!],
  ["DELETE", /^\/projects\/[^/]+\/secrets\/envs\/([^/]+)$/, "secrets.env_deleted", (m) => m[1]!],
  ["*", /^\/projects\/[^/]+\/secrets\/envs\/([^/]+)\/secrets$/, "secrets.changed", (m) => m[1]!],
  ["POST", /^\/projects\/[^/]+\/secrets\/envs\/([^/]+)\/revisions\/\d+\/restore$/, "secrets.restored", (m) => m[1]!],
  ["POST", /^\/projects\/[^/]+\/secrets\/link$/, "secrets.linked"],
  ["DELETE", /^\/projects\/[^/]+\/secrets\/link\/([^/]+)$/, "secrets.unlinked", (m) => m[1]!],
  ["*", /^\/secrets\/[^/]+\/([^/]+)(\/[^/]+)?$/, "secrets.changed", (m) => m[1]!],
  ["POST", /^\/projects\/[^/]+\/(cron|queue|ratelimit|vector)\/sync$/, "$1.synced"],
  ["POST", /^\/projects\/[^/]+\/cache\/password\/rotate$/, "cache.password_rotated"],
  ["POST", /^\/projects\/[^/]+\/cron\/secret\/rotate$/, "cron.secret_rotated"],
  ["POST", /^\/projects\/[^/]+\/analytics\/key\/rotate$/, "analytics.key_rotated"],
  ["PUT", /^\/projects\/[^/]+\/vector$/, "vector.embedding_changed"],
  ["*", /^\/(audit|alerts)\/settings$/, "settings.changed", (m) => m[1]!],
  ["*", /^\/alerts\/(.+)$/, "settings.changed", (m) => `alerts/${m[1]!}`],
];

const projectOf = (pathname: string) => /^\/(?:projects|secrets|queue|vector|cron|users)\/([a-z][a-z0-9_]{2,39})(?:\/|$)/.exec(pathname)?.[1] ?? null;

/** The automatic event for a request, or null when it isn't one worth recording. */
export function autoEvent(method: string, pathname: string): AuditInput | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (SKIP.some((re) => re.test(pathname))) return null;
  const project = projectOf(pathname);
  for (const [ruleMethod, re, action, target] of RULES) {
    if (ruleMethod !== "*" && ruleMethod !== method) continue;
    const m = re.exec(pathname);
    if (!m) continue;
    return { action: action.replace("$1", m[1] ?? ""), project, target: target?.(m) ?? null };
  }
  // Anything else under a project: `<segment>.changed`, so new routes are recorded from day one.
  const service = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname)?.[1] ?? (project ? /^\/([a-z]+)\//.exec(pathname)?.[1] : undefined);
  if (service) return { action: `${service}.changed`, project, target: `${method} ${pathname}` };
  if (pathname === "/projects" && method === "POST") return { action: "project.created", project };
  return { action: "api.request", project, target: `${method} ${pathname}` };
}

/** Called by `logged()` with the response: writes the request's events, or its automatic one. */
export function finishRequest(method: string, pathname: string, status: number) {
  const current = scope.getStore();
  if (!current) return;
  const outcome = outcomeFor(status);
  const events = current.events.length ? current.events : [autoEvent(method, pathname)].filter((e) => e !== null);
  for (const input of events) record(input, current.actor, current.ip, current.requestId, outcome);
}

// ---- buffer + storage -------------------------------------------------------

interface Row {
  at: Date;
  actor_kind: string;
  actor_id: string | null;
  actor_name: string | null;
  ip: string | null;
  action: string;
  outcome: string;
  project: string | null;
  target: string | null;
  meta: string | null;
  request_id: string | null;
}

let buffer: Row[] = [];
let flushing: Promise<void> | null = null;
let dropped = 0;

function push(e: AuditEvent) {
  if (buffer.length >= MAX_BUFFERED) {
    if (dropped++ === 0) log.warn("audit buffer full, dropping events");
    return;
  }
  buffer.push({
    at: e.at,
    actor_kind: e.actor.kind,
    actor_id: e.actor.id,
    actor_name: e.actor.name,
    ip: e.ip,
    action: e.action,
    outcome: e.outcome,
    project: e.project,
    target: e.target,
    meta: e.meta ? JSON.stringify(e.meta) : null,
    request_id: e.requestId,
  });
  if (buffer.length >= FLUSH_AT) void flushAudit();
}

/** Writes everything buffered. Safe to call any time. */
export async function flushAudit(): Promise<void> {
  while (flushing) await flushing;
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  if (dropped) {
    log.warn("audit events were dropped", { dropped });
    dropped = 0;
  }
  flushing = (async () => {
    try {
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        // meta goes in as text and is cast, so Bun doesn't double-encode it.
        await sql`
          insert into mybase.audit_events (at, actor_kind, actor_id, actor_name, ip, action, outcome, project, target, meta, request_id)
          select at, actor_kind, actor_id, actor_name, ip, action, outcome, project, target, meta::jsonb, request_id
          from jsonb_to_recordset(${JSON.stringify(chunk)}::text::jsonb) as r(
            at timestamptz, actor_kind text, actor_id text, actor_name text, ip text, action text,
            outcome text, project text, target text, meta text, request_id text)`;
      }
    } catch (err) {
      // Dropped rather than retried, so the buffer can't grow while Postgres is down.
      log.error("audit events not written", { events: rows.length, err });
    }
  })().finally(() => {
    flushing = null;
  });
  await flushing;
}

interface EventRow {
  id: string;
  at: Date;
  actor_kind: AuditActorKind;
  actor_id: string | null;
  actor_name: string | null;
  ip: string | null;
  action: string;
  outcome: AuditOutcome;
  project: string | null;
  target: string | null;
  meta: AuditEventRecord["meta"];
  request_id: string | null;
}

const toRecord = (r: EventRow): AuditEventRecord => ({
  id: r.id,
  at: r.at.toISOString(),
  actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name },
  ip: r.ip,
  action: r.action,
  outcome: r.outcome,
  project: r.project,
  target: r.target,
  meta: r.meta,
  requestId: r.request_id,
});

export interface AuditFilter {
  /** Only these projects' events (a project-limited key); null = everything, instance events too. */
  projects: readonly string[] | null;
  project?: string | null;
  /** `auth` (a group) or `auth.login` (one action). */
  action?: string | null;
  actor?: string | null;
  outcome?: string | null;
  since?: string | null;
  before?: string | null;
  limit?: number;
}

/** Newest first (by time: ids follow flush order, not event order), `limit` at a time; page with `next`. */
export async function listAudit(filter: AuditFilter): Promise<AuditEventList> {
  await flushAudit();
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), MAX_LIST);
  const since = filter.since ? new Date(filter.since) : null;
  if (since && Number.isNaN(since.getTime())) throw new BadRequestError("since must be an ISO date");
  if (filter.before && !/^\d+$/.test(filter.before)) throw new BadRequestError("before must be an event id");
  if (filter.outcome && !["ok", "denied", "failed"].includes(filter.outcome)) throw new BadRequestError("outcome must be ok, denied, or failed");
  const action = filter.action ?? null;
  const group = action && !action.includes(".") ? `${action}.%` : null;
  const rows: EventRow[] = await sql`
    select id::text, at, actor_kind, actor_id, actor_name, ip, action, outcome, project, target, meta, request_id
    from mybase.audit_events
    where (${filter.projects === null} or project in (select jsonb_array_elements_text(${JSON.stringify(filter.projects ?? [])}::text::jsonb)))
      and (${filter.project ?? null}::text is null or project = ${filter.project ?? null})
      and (${action}::text is null or action = ${action} or action like ${group ?? ""})
      and (${filter.actor ?? null}::text is null or actor_id = ${filter.actor ?? null} or actor_kind = ${filter.actor ?? null})
      and (${filter.outcome ?? null}::text is null or outcome = ${filter.outcome ?? null})
      and (${since}::timestamptz is null or at >= ${since})
      and (${filter.before ?? null}::bigint is null or (at, id) < (select at, id from mybase.audit_events where id = ${filter.before ?? null}::bigint))
    order by at desc, id desc
    limit ${limit + 1}`;
  const events = rows.slice(0, limit).map(toRecord);
  return { events, next: rows.length > limit ? events.at(-1)!.id : null };
}

/** Events since `since` matching `actions`, oldest first (alerts.ts rebuilds its memory from these at boot). */
export async function recentEvents(actions: string[], since: Date): Promise<AuditEvent[]> {
  const rows: EventRow[] = await sql`
    select id::text, at, actor_kind, actor_id, actor_name, ip, action, outcome, project, target, meta, request_id
    from mybase.audit_events where at >= ${since} and action in (select jsonb_array_elements_text(${JSON.stringify(actions)}::text::jsonb)) order by at, id`;
  return rows.map((r) => ({ ...toRecord(r), at: r.at, actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name } }));
}

// ---- settings + retention ---------------------------------------------------

let retentionDays = 90;

export async function getAuditSettings(): Promise<AuditSettings> {
  const [row]: { retention_days: number }[] = await sql`select retention_days from mybase.audit_settings where id = 1`;
  retentionDays = row?.retention_days ?? 90;
  return { retentionDays };
}

export async function updateAuditSettings(body: Record<string, unknown>): Promise<AuditSettings> {
  const days = body.retentionDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 7 || days > 365) throw new BadRequestError("retentionDays must be a whole number from 7 to 365");
  await sql`insert into mybase.audit_settings (id, retention_days) values (1, ${days}) on conflict (id) do update set retention_days = excluded.retention_days`;
  retentionDays = days;
  return { retentionDays };
}

async function prune(pruneLog: Logger) {
  try {
    const result = await sql`delete from mybase.audit_events where at < now() - make_interval(days => ${retentionDays})`;
    if (result.count > 0) pruneLog.info("old audit events pruned", { events: result.count });
  } catch (err) {
    pruneLog.error("audit prune failed", { err });
  }
}

/** Starts the flush and prune timers. Call once at boot, after migrations. */
export async function startAudit() {
  await getAuditSettings().catch((err) => log.error("audit settings not loaded", { err }));
  setInterval(() => void flushAudit(), FLUSH_EVERY_MS);
  void prune(log);
  setInterval(() => void prune(log), 3_600_000);
  log.info("audit log started", { retentionDays });
}

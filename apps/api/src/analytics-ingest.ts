// Analytics ingest: validates events from apps, enriches them (visitor hash, country, browser),
// and buffers them in memory so Postgres sees one multi-row insert every few seconds instead
// of a write per page view (SD cards). Also prunes events past each project's retention.
//
// Never log IPs, user agents, write keys, or event contents.
import { ANALYTICS_EVENT_NAME_PATTERN, ANALYTICS_LIMITS, type AnalyticsEvent, type AnalyticsProps } from "@mybase-dev/sdk/analytics";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { timingSafeEqual } from "node:crypto";
import { countryForTimeZone } from "./analytics-tz";
import { parseUserAgent } from "./analytics-ua";
import { RateLimit } from "./auth-http";
import { BadRequestError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from "./errors";
import { sql } from "./postgres";

const log = createLogger("analytics");

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// ---- project config (write key, origins), cached ----------------------------

interface IngestConfig {
  writeKey: string;
  allowedOrigins: string[];
}

const CONFIG_TTL_MS = 60_000;
const configs = new Map<string, { config: IngestConfig | null; expires: number }>();

/** The project's ingest config, or null when analytics is off. Cached so ingest rarely queries Postgres. */
async function ingestConfig(project: string): Promise<IngestConfig | null> {
  const cached = configs.get(project);
  if (cached && cached.expires > Date.now()) return cached.config;
  const [row]: { writeKey: string; allowedOrigins: string[] }[] = await sql`
    select write_key as "writeKey", allowed_origins as "allowedOrigins" from mybase.analytics_projects where project = ${project}`;
  const config = row ?? null;
  configs.set(project, { config, expires: Date.now() + CONFIG_TTL_MS });
  // Unknown names are cached too (so junk can't force a query per request); keep the map bounded.
  if (configs.size > 5_000) configs.clear();
  return config;
}

/** Drops the cached config after it changes (enable, disable, key rotation, settings). */
export function forgetIngestConfig(project: string) {
  configs.delete(project);
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- visitors ---------------------------------------------------------------
//
// visitor = hash(today's salt, project, ip, user agent). The salt changes every UTC day and
// old ones are deleted, so a visitor can't be followed across days or traced back to an IP.
// It's stored (not just kept in memory) so a restart doesn't double-count today's visitors.

let salt: { day: string; value: string } | null = null;

async function todaysSalt(): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  if (salt?.day === day) return salt.value;
  const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const [row]: { salt: string }[] = await sql`
    insert into mybase.analytics_salts (day, salt) values (${day}, ${fresh})
    on conflict (day) do update set salt = mybase.analytics_salts.salt
    returning salt`;
  await sql`delete from mybase.analytics_salts where day < ${day}::date`;
  salt = { day, value: row!.salt };
  return salt.value;
}

// ---- validation -------------------------------------------------------------

const TYPES = new Set(["pageview", "event", "error"]);

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequestError(`${field} must be a string`);
  if (value.length > max) throw new BadRequestError(`${field} must be at most ${max} characters`);
  return value;
}

function readProps(value: unknown, at: string): AnalyticsProps | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(`${at}props must be an object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > ANALYTICS_LIMITS.props) throw new BadRequestError(`${at}props can have at most ${ANALYTICS_LIMITS.props} keys`);
  for (const [k, v] of entries) {
    if (!k || k.length > ANALYTICS_LIMITS.propKey) throw new BadRequestError(`${at}prop names must be 1–${ANALYTICS_LIMITS.propKey} characters`);
    const ok = v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= ANALYTICS_LIMITS.propValue);
    if (!ok) throw new BadRequestError(`${at}prop "${k}" must be a string (up to ${ANALYTICS_LIMITS.propValue} characters), number, boolean, or null`);
  }
  return entries.length > 0 ? (value as AnalyticsProps) : null;
}

/** An event's time: what the client said, if it's from the last hour (queued while offline), else now. */
function eventTime(value: unknown, now: number): Date {
  if (typeof value !== "string") return new Date(now);
  const t = Date.parse(value);
  if (Number.isNaN(t) || t > now + 60_000 || t < now - 3_600_000) return new Date(now);
  return new Date(t);
}

/** The host of a referrer URL, unless it's the site itself. */
function referrerHost(value: string | null, origin: string | null): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).host;
    if (!host) return null;
    if (origin && new URL(origin).host === host) return null;
    return host.replace(/^www\./, "").slice(0, 255);
  } catch {
    return null;
  }
}

function normalizePath(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("/") ? value : `/${value}`;
}

/** Errors with the same message and top stack frame are one error in the dashboard. */
function fingerprint(message: string, stack: string | null): string {
  const frame = stack?.split("\n").find((line) => /^\s*at\s|@/.test(line))?.trim() ?? "";
  // Strip line:column, which shift on every deploy.
  return sha256(`${message}\n${frame.replace(/:\d+(:\d+)?\)?$/, "")}`).slice(0, 16);
}

// ---- buffer -----------------------------------------------------------------

interface Row {
  project: string;
  type: string;
  name: string | null;
  path: string | null;
  referrer: string | null;
  country: string | null;
  browser: string | null;
  os: string | null;
  device: string;
  visitor: string;
  fingerprint: string | null;
  props: AnalyticsProps | null;
  stack: string | null;
  ts: Date;
}

const FLUSH_EVERY_MS = 10_000;
const FLUSH_AT = 500;
const MAX_BUFFERED = 10_000;

let buffer: Row[] = [];
let flushing: Promise<void> | null = null;
let droppedSinceWarn = 0;

/** Writes everything buffered, in one insert per 1000 rows. Safe to call any time. */
export async function flushAnalytics(): Promise<void> {
  // One flush at a time; a caller during a flush waits for it, then flushes what came in since.
  while (flushing) await flushing;
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  flushing = writeRows(rows).finally(() => {
    flushing = null;
  });
  await flushing;
}

async function writeRows(rows: Row[]) {
  const start = performance.now();
  try {
    for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
    log.debug("events written", { events: rows.length, ms: Number((performance.now() - start).toFixed(1)) });
  } catch (err) {
    // Dropped rather than retried: the buffer must not grow without bound while Postgres is down.
    log.error("events not written", { events: rows.length, err });
  }
}

async function insert(rows: Row[]) {
  try {
    await sql`insert into mybase.analytics_events ${sql(rows)}`;
  } catch (err) {
    // A project turned analytics off (or was deleted) since its events were buffered.
    if ((err as { errno?: string }).errno !== "23503") throw err;
    const projects = [...new Set(rows.map((r) => r.project))];
    const live: { project: string }[] = await sql`select project from mybase.analytics_projects where project in ${sql(projects)}`;
    const keep = new Set(live.map((r) => r.project));
    const remaining = rows.filter((r) => keep.has(r.project));
    if (remaining.length > 0) await sql`insert into mybase.analytics_events ${sql(remaining)}`;
  }
}

/** Forgets buffered events for a project whose analytics was just turned off. */
export function dropBuffered(project: string) {
  buffer = buffer.filter((r) => r.project !== project);
}

// ---- ingest -----------------------------------------------------------------

/** Events per minute per IP. A busy single page sends a handful. */
const limiter = new RateLimit(300);

export interface IngestContext {
  ip: string;
  userAgent: string | null;
  origin: string | null;
  /** From Cloudflare, when the API trusts it. */
  country: string | null;
}

/**
 * Validates and buffers one request's events. Returns how many were accepted (0 for bots).
 * The whole batch is rejected if any event is invalid, so mistakes show up while developing.
 */
export async function ingest(project: string, raw: string, ctx: IngestContext): Promise<number> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new BadRequestError("expected a JSON object");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestError("expected a JSON object");
  const { key, events } = body as { key?: unknown; events?: unknown };
  if (typeof key !== "string" || !key) throw new UnauthorizedError("missing write key");
  if (!Array.isArray(events)) throw new BadRequestError("events must be an array");
  if (events.length > ANALYTICS_LIMITS.batch) throw new BadRequestError(`send at most ${ANALYTICS_LIMITS.batch} events per request`);

  // One message for every key problem, so project names can't be probed.
  const config = await ingestConfig(project);
  if (!config || !sameKey(key, config.writeKey)) throw new UnauthorizedError("invalid write key for this project");
  // Browsers always send Origin on cross-origin POSTs. Servers don't, and could fake it anyway.
  if (config.allowedOrigins.length > 0 && ctx.origin && !config.allowedOrigins.includes(ctx.origin)) {
    throw new ForbiddenError(`origin ${ctx.origin} is not allowed to send events to this project`);
  }
  if (events.length === 0) return 0;
  if (!limiter.take(ctx.ip, events.length)) throw new TooManyRequestsError("too many events from this address; slow down", 60);

  const ua = parseUserAgent(ctx.userAgent);
  const rows: Row[] = [];
  const now = Date.now();
  for (const [i, value] of (events as unknown[]).entries()) {
    const at = events.length > 1 ? `events[${i}]: ` : "";
    try {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestError("each event must be an object");
      const e = value as Record<keyof AnalyticsEvent, unknown>;
      if (typeof e.type !== "string" || !TYPES.has(e.type)) throw new BadRequestError('type must be "pageview", "event", or "error"');
      let name = optionalString(e.name, "name", e.type === "error" ? ANALYTICS_LIMITS.message : 64);
      if (e.type === "event" && (!name || !ANALYTICS_EVENT_NAME_PATTERN.test(name))) {
        throw new BadRequestError("custom events need a name of 1–64 letters, digits, spaces, or _ . : -");
      }
      if (e.type === "error" && !name) name = "Unknown error";
      if (e.type === "pageview") name = null;
      const path = normalizePath(optionalString(e.path, "path", ANALYTICS_LIMITS.path));
      if (e.type === "pageview" && !path) throw new BadRequestError("page views need a path");
      const stack = e.type === "error" ? optionalString(e.stack, "stack", ANALYTICS_LIMITS.stack) : null;
      const props = readProps(e.props, "");
      const tz = optionalString(e.tz, "tz", 64);
      rows.push({
        project,
        type: e.type,
        name,
        path,
        referrer: e.type === "pageview" ? referrerHost(optionalString(e.referrer, "referrer", ANALYTICS_LIMITS.referrer), ctx.origin) : null,
        country: ctx.country ?? countryForTimeZone(tz),
        browser: ua.browser,
        os: ua.os,
        device: ua.device,
        visitor: "",
        fingerprint: e.type === "error" ? fingerprint(name!, stack) : null,
        props,
        stack,
        ts: eventTime(e.ts, now),
      });
    } catch (err) {
      if (err instanceof BadRequestError) throw new BadRequestError(at + err.message);
      throw err;
    }
  }
  // Crawlers are answered like everyone else, but not counted.
  if (ua.bot) return 0;

  const visitor = sha256(`${await todaysSalt()}|${project}|${ctx.ip}|${ctx.userAgent ?? ""}`).slice(0, 16);
  for (const row of rows) row.visitor = visitor;

  const room = MAX_BUFFERED - buffer.length;
  if (room < rows.length) {
    droppedSinceWarn += rows.length - Math.max(room, 0);
    if (droppedSinceWarn >= 1000 || room <= 0) {
      log.warn("event buffer full, dropping events", { dropped: droppedSinceWarn });
      droppedSinceWarn = 0;
    }
  }
  buffer.push(...rows.slice(0, Math.max(room, 0)));
  if (buffer.length >= FLUSH_AT) void flushAnalytics();
  return rows.length;
}

// ---- lifecycle --------------------------------------------------------------

/** Deletes events past each project's retention. Hourly; the `ts` index keeps it cheap. */
async function prune(pruneLog: Logger) {
  try {
    const result = await sql`
      delete from mybase.analytics_events e using mybase.analytics_projects p
      where e.project = p.project and e.ts < now() - make_interval(days => p.retention_days)`;
    if (result.count > 0) pruneLog.info("old events pruned", { events: result.count });
  } catch (err) {
    pruneLog.error("prune failed", { err });
  }
}

/** Starts the flush and prune timers. Call once at boot. */
export function startAnalytics() {
  setInterval(() => void flushAnalytics(), FLUSH_EVERY_MS);
  void prune(log);
  setInterval(() => void prune(log), 3_600_000);
  log.info("analytics started", { flushEveryMs: FLUSH_EVERY_MS });
}

// Security alerts: built-in rules over the audit log (audit.ts `onAudit`), sent to webhooks
// (signed like cron calls, `signCronRequest`) and ntfy topics. Rules keep their counters and
// "seen" sets in memory, rebuilt from the audit log at boot. Each rule sends at most one alert
// per key every 15 minutes. Sends are audit events too (`alert.sent` / `alert.failed`), and
// rules ignore `alert.*`, so alerts can't trigger alerts.
import { ALERT_CHANNEL_KINDS, ALERT_RULES, type AlertChannel, type AlertChannelKind, type AlertPayload, type AlertRuleId, type AlertsOverview } from "@mybase/shared";
import { SIGNATURE_HEADER, signCronRequest } from "@mybase-dev/sdk/cron";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { audit, onAudit, outsideRequest, recentEvents, type AuditEvent } from "./audit";
import { BadRequestError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { secretsMaster } from "./secrets";
import { openBlob, sameId, sealBlob } from "./secrets-crypto";

const log = createLogger("alerts");

const MINUTE = 60_000;
const DAY = 86_400_000;
const THROTTLE_MS = 15 * MINUTE;
const BURST_WINDOW_MS = 10 * MINUTE;
const SEEN_DAYS = 30;
const SEND_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [10_000, 60_000];
const MAX_CHANNELS = 20;

const publicUrl = () => (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");
const newSecret = () => `mbalert_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;

// ---- rules (pure, testable) -----------------------------------------------

export interface Alert {
  rule: AlertRuleId;
  /** Throttle key within the rule (an IP, a key id). */
  key: string;
  title: string;
  detail: string;
}

const who = (e: AuditEvent) => (e.actor.kind === "token" ? `API key "${e.actor.name}"` : e.actor.kind === "session" ? (e.actor.name ?? "the admin") : (e.actor.name ?? "someone"));
const from = (e: AuditEvent) => (e.ip ? ` from ${e.ip}` : "");

/**
 * The rules' memory. `check` turns one audit event into the alerts it raises (before throttling).
 * Kept apart from delivery so tests can feed it events.
 */
export class RuleState {
  private bursts = new Map<string, number[]>();
  /** ip → last successful admin sign-in. */
  readonly loginIps = new Map<string, number>();
  /** `actorId project env` → last read. */
  readonly readers = new Map<string, number>();

  private burst(rule: string, at: number, threshold: number): boolean {
    const times = (this.bursts.get(rule) ?? []).filter((t) => t > at - BURST_WINDOW_MS);
    times.push(at);
    this.bursts.set(rule, times);
    if (times.length < threshold) return false;
    this.bursts.set(rule, []);
    return true;
  }

  /** Remembers what's normal, without alerting (boot, from the audit log). */
  learn(e: AuditEvent) {
    const at = e.at.getTime();
    if (e.action === "auth.login" && e.outcome === "ok" && e.ip) this.loginIps.set(e.ip, at);
    if (e.action === "secrets.read" && e.outcome === "ok" && e.actor.kind === "token") this.readers.set(`${e.actor.id} ${e.project} ${e.target}`, at);
  }

  check(e: AuditEvent): Alert[] {
    if (e.action.startsWith("alert.")) return [];
    const at = e.at.getTime();
    const out: Alert[] = [];
    switch (e.action) {
      case "auth.login":
        if (e.outcome === "failed" && this.burst("login.failed_burst", at, 10)) {
          out.push({ rule: "login.failed_burst", key: "all", title: "Many failed sign-ins", detail: `10 or more failed admin sign-ins in the last 10 minutes, the latest${from(e)}.` });
        }
        if (e.outcome === "ok" && e.ip) {
          const last = this.loginIps.get(e.ip);
          const known = this.loginIps.size > 0;
          if (known && (last === undefined || last < at - SEEN_DAYS * DAY)) {
            out.push({ rule: "login.new_ip", key: e.ip, title: "Sign-in from a new address", detail: `${who(e)} signed in${from(e)}, an address not seen in the last ${SEEN_DAYS} days.` });
          }
        }
        break;
      case "mfa.disabled":
        if (e.outcome === "ok") out.push({ rule: "mfa.disabled", key: "all", title: "Two-factor authentication was turned off", detail: `${who(e)} turned 2FA off${from(e)}.` });
        break;
      case "mfa.recovery_used": {
        const left = e.meta?.left;
        out.push({ rule: "mfa.recovery_used", key: "all", title: "A 2FA recovery code was used", detail: `A recovery code was used to sign in${from(e)}${typeof left === "number" ? `; ${left} left` : ""}.` });
        break;
      }
      case "auth.password_changed":
        if (e.outcome === "ok") out.push({ rule: "auth.password_changed", key: "all", title: "The admin password was changed", detail: `${who(e)} changed the password${from(e)}.` });
        break;
      case "token.created":
        if (e.outcome === "ok" && e.meta?.admin === true) {
          out.push({ rule: "token.admin_created", key: e.target ?? "all", title: "New admin API key", detail: `${who(e)} created the admin API key "${e.meta.name ?? "?"}"${from(e)}.` });
        }
        break;
      case "secrets.read":
        if (e.outcome === "ok" && e.actor.kind === "token") {
          const id = `${e.actor.id} ${e.project} ${e.target}`;
          const last = this.readers.get(id);
          if (last === undefined || last < at - SEEN_DAYS * DAY) {
            out.push({
              rule: "secrets.new_reader",
              key: id,
              title: "New secrets reader",
              detail: `${who(e)} read the "${e.target}" secrets of ${e.project}${from(e)}, for the first time in ${SEEN_DAYS} days.`,
            });
          }
        }
        break;
      case "key.rejected":
        if (this.burst("key.rejected_burst", at, 10)) out.push({ rule: "key.rejected_burst", key: "all", title: "Many wrong API keys", detail: `Wrong API keys from 10 or more address-minutes in the last 10 minutes, the latest${from(e)}.` });
        break;
      case "dbproxy.rejected":
        if (this.burst("dbproxy.rejected_burst", at, 10)) {
          out.push({ rule: "dbproxy.rejected_burst", key: "all", title: "Many rejected database connections", detail: `Rejected connections to /db from 10 or more address-minutes in the last 10 minutes, the latest${from(e)}.` });
        }
        break;
    }
    this.learn(e);
    return out;
  }
}

/** Per rule+key: the time until which further alerts are held back. */
export class Throttle {
  private until = new Map<string, number>();
  allow(rule: string, key: string, now = Date.now()): boolean {
    const id = `${rule} ${key}`;
    if ((this.until.get(id) ?? 0) > now) return false;
    this.until.set(id, now + THROTTLE_MS);
    if (this.until.size > 5000) for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
    return true;
  }
}

// ---- channels ---------------------------------------------------------------

interface ChannelRow {
  id: string;
  name: string;
  kind: AlertChannelKind;
  url: string;
  enabled: boolean;
  secret: string | null;
  token: Buffer | null;
  token_master: Buffer | null;
  created_at: Date;
  last_sent_at: Date | null;
  last_error: string | null;
}

const toChannel = (r: ChannelRow): AlertChannel => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  enabled: r.enabled,
  secret: r.secret,
  hasToken: r.token !== null,
  createdAt: r.created_at.toISOString(),
  lastSentAt: r.last_sent_at?.toISOString() ?? null,
  lastError: r.last_error,
});

const tokenAad = (id: string) => `alerts\0${id}\0token`;

/** Seals an ntfy token under MYBASE_SECRETS_KEY when it's set (plain otherwise, like the 2FA secret). */
async function sealToken(id: string, token: string): Promise<{ token: Buffer; master: Buffer | null }> {
  const master = secretsMaster();
  const plain = new TextEncoder().encode(token);
  if (!master) return { token: Buffer.from(plain), master: null };
  return { token: Buffer.from(await sealBlob(master, plain, tokenAad(id))), master: Buffer.from(master.id) };
}

async function readToken(r: ChannelRow): Promise<string | null> {
  if (!r.token) return null;
  if (!r.token_master) return new TextDecoder().decode(r.token);
  const master = secretsMaster();
  if (!master || !sameId(master.id, r.token_master)) throw new Error("the ntfy token was sealed with a different MYBASE_SECRETS_KEY; enter it again");
  return new TextDecoder().decode(await openBlob(master, r.token, tokenAad(r.id)));
}

function readUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2000) throw new BadRequestError("url must be an http(s) URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("url must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError("url must be an http(s) URL");
  if (url.username || url.password) throw new BadRequestError("put credentials in the token field, not the URL");
  return url.href;
}

function readName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || raw.trim().length > 100) throw new BadRequestError("name must be up to 100 characters");
  return raw.trim();
}

function readOptionalToken(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 500) throw new BadRequestError("token must be a string up to 500 characters");
  return raw;
}

async function channelRows(): Promise<ChannelRow[]> {
  return sql`select * from mybase.alert_channels order by created_at`;
}

async function channelRow(id: string): Promise<ChannelRow> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundError("alert channel not found");
  const [row]: ChannelRow[] = await sql`select * from mybase.alert_channels where id = ${id}`;
  if (!row) throw new NotFoundError("alert channel not found");
  return row;
}

export async function createChannel(body: Record<string, unknown>, opLog: Logger): Promise<AlertChannel> {
  const kind = body.kind as AlertChannelKind;
  if (!ALERT_CHANNEL_KINDS.includes(kind)) throw new BadRequestError(`kind must be one of ${ALERT_CHANNEL_KINDS.join(", ")}`);
  const url = readUrl(body.url);
  const name = readName(body.name, new URL(url).host);
  const token = kind === "ntfy" ? readOptionalToken(body.token) : null;
  if (kind === "webhook" && body.token) throw new BadRequestError("webhooks are signed with their secret; token is for ntfy");
  const [{ count }]: { count: number }[] = await sql`select count(*)::int as count from mybase.alert_channels`;
  if (count >= MAX_CHANNELS) throw new BadRequestError(`at most ${MAX_CHANNELS} alert channels`);
  const id = crypto.randomUUID();
  const sealed = token ? await sealToken(id, token) : { token: null, master: null };
  const [row]: ChannelRow[] = await sql`
    insert into mybase.alert_channels (id, name, kind, url, secret, token, token_master)
    values (${id}, ${name}, ${kind}, ${url}, ${kind === "webhook" ? newSecret() : null}, ${sealed.token}, ${sealed.master})
    returning *`;
  opLog.info("alert channel created", { kind });
  return toChannel(row!);
}

export async function updateChannel(id: string, body: Record<string, unknown>, opLog: Logger): Promise<AlertChannel> {
  const row = await channelRow(id);
  const name = body.name === undefined ? row.name : readName(body.name, row.name);
  const url = body.url === undefined ? row.url : readUrl(body.url);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadRequestError("enabled must be true or false");
  const enabled = body.enabled ?? row.enabled;
  let { token, token_master } = row;
  if (body.token !== undefined) {
    if (row.kind !== "ntfy") throw new BadRequestError("only ntfy channels have a token");
    const next = readOptionalToken(body.token);
    ({ token, master: token_master } = next ? await sealToken(id, next) : { token: null, master: null });
  }
  const [updated]: ChannelRow[] = await sql`
    update mybase.alert_channels set name = ${name}, url = ${url}, enabled = ${enabled}, token = ${token}, token_master = ${token_master}
    where id = ${id} returning *`;
  opLog.info("alert channel updated", { kind: row.kind });
  return toChannel(updated!);
}

export async function deleteChannel(id: string, opLog: Logger) {
  await channelRow(id);
  await sql`delete from mybase.alert_channels where id = ${id}`;
  opLog.info("alert channel deleted");
}

export async function rotateChannelSecret(id: string, opLog: Logger): Promise<AlertChannel> {
  const row = await channelRow(id);
  if (row.kind !== "webhook") throw new BadRequestError("only webhooks have a signing secret");
  const [updated]: ChannelRow[] = await sql`update mybase.alert_channels set secret = ${newSecret()} where id = ${id} returning *`;
  opLog.info("alert channel secret rotated");
  return toChannel(updated!);
}

// ---- rules toggles ------------------------------------------------------------

/** Rules turned off. Every rule is on unless listed. */
let disabledRules = new Set<string>();

async function loadRules() {
  const rows: { rule: string }[] = await sql`select rule from mybase.alert_rules where not enabled`;
  disabledRules = new Set(rows.map((r) => r.rule));
}

export async function setRule(rule: string, body: Record<string, unknown>, opLog: Logger) {
  if (!ALERT_RULES.some((r) => r.id === rule)) throw new NotFoundError(`no alert rule "${rule}"`);
  if (typeof body.enabled !== "boolean") throw new BadRequestError("enabled must be true or false");
  await sql`insert into mybase.alert_rules (rule, enabled) values (${rule}, ${body.enabled}) on conflict (rule) do update set enabled = excluded.enabled`;
  await loadRules();
  opLog.info("alert rule changed", { rule, enabled: body.enabled });
}

export async function alertsOverview(): Promise<AlertsOverview> {
  await loadRules();
  return {
    channels: (await channelRows()).map(toChannel),
    rules: ALERT_RULES.map((r) => ({ ...r, enabled: !disabledRules.has(r.id) })),
  };
}

// ---- delivery -----------------------------------------------------------------

async function post(row: ChannelRow, payload: AlertPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "User-Agent": "mybase-alerts" };
  let sent: string;
  if (row.kind === "webhook") {
    headers["Content-Type"] = "application/json";
    headers[SIGNATURE_HEADER] = await signCronRequest(row.secret ?? "", body);
    sent = body;
  } else {
    // ntfy: the message is the body; title and tags go in headers (ASCII only there).
    headers.Title = payload.title.replace(/[^\x20-\x7e]/g, "?");
    headers.Tags = payload.rule === "test" ? "white_check_mark" : "warning,lock";
    headers.Priority = payload.rule === "test" ? "default" : "high";
    if (payload.instance.startsWith("http")) headers.Click = payload.instance;
    const token = await readToken(row);
    if (token) headers.Authorization = `Bearer ${token}`;
    sent = payload.detail;
  }
  const res = await fetch(row.url, { method: "POST", headers, body: sent, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Sends to one channel, retrying network errors, 429, and 5xx. Records the result. */
async function deliver(row: ChannelRow, payload: AlertPayload): Promise<string | null> {
  let error: string | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await post(row, payload);
      error = null;
      break;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
      const retryable = !/^HTTP (4\d\d)$/.test(error) || error === "HTTP 429";
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
      await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
  await sql`update mybase.alert_channels set last_sent_at = case when ${error}::text is null then now() else last_sent_at end, last_error = ${error} where id = ${row.id}`.catch(
    (err) => log.error("alert status not saved", { err }),
  );
  audit({ action: error ? "alert.failed" : "alert.sent", outcome: error ? "failed" : "ok", target: row.name, meta: { rule: payload.rule, kind: row.kind, ...(error ? { error } : {}) } });
  if (error) log.warn("alert not delivered", { channel: row.id, kind: row.kind, rule: payload.rule, error });
  else log.info("alert sent", { channel: row.id, kind: row.kind, rule: payload.rule });
  return error;
}

async function broadcast(alert: Alert) {
  const rows = (await channelRows()).filter((r) => r.enabled);
  if (rows.length === 0) {
    log.info("alert raised, no channels", { rule: alert.rule });
    return;
  }
  const payload: AlertPayload = { rule: alert.rule, title: alert.title, detail: alert.detail, at: new Date().toISOString(), instance: publicUrl() };
  await Promise.all(rows.map((r) => deliver(r, payload)));
}

/** Sends a test alert to one channel and waits for the result. */
export async function testChannel(id: string): Promise<{ ok: boolean; error: string | null }> {
  const row = await channelRow(id);
  const error = await deliver(row, {
    rule: "test",
    title: "mybase test alert",
    detail: `This is a test from ${publicUrl()}. Security alerts will arrive like this.`,
    at: new Date().toISOString(),
    instance: publicUrl(),
  });
  return { ok: error === null, error };
}

// ---- wiring -------------------------------------------------------------------

const state = new RuleState();
const throttle = new Throttle();

function raise(alert: Alert) {
  if (disabledRules.has(alert.rule) || !throttle.allow(alert.rule, alert.key)) return;
  log.warn("security alert", { rule: alert.rule });
  // Raised while recording a request's events: send outside it, so the sends are their own events.
  outsideRequest(() => void broadcast(alert).catch((err) => log.error("alert broadcast failed", { err })));
}

/** Daily: new critical advisor findings (ids remembered in alert_state, so restarts don't repeat them). */
async function advisorRun(runLog: Logger) {
  try {
    const { fullReport } = await import("./advisor");
    const critical = (await fullReport(runLog)).findings.filter((f) => f.severity === "critical");
    const ids = critical.map((f) => `${f.project ?? ""}:${f.id}`);
    const [row]: { value: string[] }[] = await sql`select value from mybase.alert_state where key = 'advisor.critical'`;
    const before = new Set(row?.value ?? []);
    for (const f of critical.filter((f) => !before.has(`${f.project ?? ""}:${f.id}`))) {
      raise({ rule: "advisor.critical", key: `${f.project ?? ""}:${f.id}`, title: `Critical: ${f.title}`, detail: `${f.project ? `${f.project}: ` : ""}${f.detail} Fix: ${f.fix}` });
    }
    await sql`
      insert into mybase.alert_state (key, value) values ('advisor.critical', ${JSON.stringify(ids)}::text::jsonb)
      on conflict (key) do update set value = excluded.value`;
  } catch (err) {
    runLog.error("advisor alert run failed", { err });
  }
}

/** Loads rules, rebuilds the rules' memory from the audit log, and starts listening. After startAudit. */
export async function startAlerts() {
  await loadRules();
  try {
    for (const e of await recentEvents(["auth.login", "secrets.read"], new Date(Date.now() - SEEN_DAYS * DAY))) state.learn(e);
  } catch (err) {
    log.error("alert history not loaded", { err });
  }
  onAudit((e) => {
    for (const alert of state.check(e)) raise(alert);
  });
  setTimeout(() => void advisorRun(log), 5 * MINUTE);
  setInterval(() => void advisorRun(log), DAY);
  log.info("alerts started", { knownLoginIps: state.loginIps.size });
}

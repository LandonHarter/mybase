// The realtime service: WebSocket pub/sub channels, for apps whose own server can't hold sockets
// (Vercel, Netlify, …). Browsers connect to `/realtime/:project` and send `auth` with a token
// the app signed with the project's secret (`createRealtimeToken` in the SDK), or no token for
// `public:` channels. The app's backend publishes over HTTP with an API key.
//
// Fan-out is Bun's native pub/sub (topic per project + channel), so a message costs one encode
// whatever the subscriber count. Presence (`presence:` channels) is counted per user id: a user
// joins on their first socket and leaves with their last. Everything here is in memory, so run
// one API instance (as with cron and queues). Message data and tokens are never logged.
import { PROJECT_NAME_PATTERN, REALTIME_WEBHOOK_EVENTS, type RealtimeSettings, type RealtimeStats, type RealtimeWebhookEventType } from "@mybase/shared";
import {
  CHANNEL_PATTERN,
  CLOSE_CODES,
  EVENT_PATTERN,
  PRESENCE_PREFIX,
  PUBLIC_PREFIX,
  REALTIME_LIMITS,
  channelAllowed,
  createRealtimeToken,
  verifyRealtimeToken,
  type ChannelInfo,
  type ClientFrame,
  type RealtimeErrorCode,
  type RealtimeMember,
  type RealtimeWebhookEvent,
  type ServerFrame,
} from "@mybase-dev/sdk/realtime";
import type { Logger } from "@mybase/shared/logger";
import type { BunRequest, Server, ServerWebSocket, WebSocketHandler } from "bun";
import { auditOnce } from "./audit";
import { RateLimit } from "./auth-http";
import { BadRequestError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { configureWebhooks, dropWebhooks, queueWebhook, webhookStatus } from "./realtime-webhook";
import type { ServiceModule } from "./services";
import type { SocketData } from "./websocket";

const publicApiUrl = () => (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");
const newSecret = () => `mbrt_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;

// All realtime sockets on this instance, whatever the project.
const MAX_SOCKETS = Number(process.env.MYBASE_REALTIME_MAX ?? 5000);
// A socket whose unsent backlog passes this is too slow to keep.
const MAX_BUFFERED = 1024 * 1024;
// Frames over the rate for this long close the socket.
const RATE_GRACE_MS = 5000;
const SWEEP_MS = 15_000;

export interface RealtimeData {
  kind: "realtime";
  id: string;
  project: string;
  ip: string;
  log: Logger;
  /** Sent a good `auth` (anonymous counts). */
  authed: boolean;
  uid: string | null;
  info: unknown;
  sub: string[];
  pub: string[];
  /** Token expiry, unix seconds; null for anonymous sockets. */
  exp: number | null;
  channels: Set<string>;
  /** Token bucket for the frame rate. */
  bucket: number;
  refilledAt: number;
  limitedSince: number;
  lastSeen: number;
  start: number;
  framesIn: number;
  framesOut: number;
}

type RtSocket = ServerWebSocket<RealtimeData>;

interface Settings {
  secret: string;
  maxConnections: number;
  maxChannels: number;
  maxMessageBytes: number;
  maxRate: number;
  publicChannels: boolean;
  allowedOrigins: string[];
  webhookUrl: string | null;
  webhookEvents: Set<RealtimeWebhookEventType>;
}

// Per-project settings, cached: every frame needs them. Loaded at upgrade, reloaded on change.
const cache = new Map<string, Settings>();

interface ChannelLive {
  subscribers: number;
  /** Presence channels: user id → info and how many of their sockets are in. */
  members: Map<string, { info: unknown; sockets: number }> | null;
}

interface ProjectLive {
  sockets: Set<RtSocket>;
  channels: Map<string, ChannelLive>;
}

const live = new Map<string, ProjectLive>();
let totalSockets = 0;
let server: Server<SocketData> | null = null;

/** Set once Bun.serve is up: presence leaves and HTTP publishes go through it. */
export function setRealtimeServer(s: Server<SocketData>) {
  server = s;
}

const topic = (project: string, channel: string) => `rt\0${project}\0${channel}`;

// ---- stats (memory only: the SD card) -----------------------------------------------

interface Hour {
  hour: string;
  messagesIn: number;
  messagesOut: number;
  connects: number;
  webhookOk: number;
  webhookFailed: number;
}

const stats = new Map<string, { peak: number; hours: Hour[] }>();

function hourOf(project: string): Hour {
  let s = stats.get(project);
  if (!s) stats.set(project, (s = { peak: 0, hours: [] }));
  const hour = new Date().toISOString().slice(0, 13) + ":00:00Z";
  let last = s.hours.at(-1);
  if (last?.hour !== hour) {
    last = { hour, messagesIn: 0, messagesOut: 0, connects: 0, webhookOk: 0, webhookFailed: 0 };
    s.hours.push(last);
    if (s.hours.length > 24) s.hours.shift();
  }
  return last;
}

configureWebhooks({
  target: (project) => {
    const s = cache.get(project);
    return s?.webhookUrl ? { url: s.webhookUrl, secret: s.secret } : null;
  },
  result: (project, ok, events) => {
    if (ok) hourOf(project).webhookOk += events;
    else hourOf(project).webhookFailed += events;
  },
});

function notify(project: string, type: RealtimeWebhookEventType, event: RealtimeWebhookEvent) {
  const s = cache.get(project);
  if (s?.webhookUrl && s.webhookEvents.has(type)) queueWebhook(project, event);
}

// ---- service -------------------------------------------------------------------------

export const realtimeService: ServiceModule = {
  id: "realtime",
  async enable(project, log) {
    await sql`
      insert into mybase.realtime_projects (project, secret, max_connections, max_channels, max_message_bytes, max_rate)
      values (${project}, ${newSecret()}, ${REALTIME_LIMITS.maxConnections.default}, ${REALTIME_LIMITS.maxChannels.default},
              ${REALTIME_LIMITS.maxMessageBytes.default}, ${REALTIME_LIMITS.maxRate.default})
      on conflict do nothing`;
    log.info("realtime enabled");
  },
  async disable(project, log) {
    await sql`delete from mybase.realtime_projects where project = ${project}`;
    cache.delete(project);
    closeAll(project, CLOSE_CODES.disabled, "realtime was turned off");
    live.delete(project);
    stats.delete(project);
    dropWebhooks(project);
    log.info("realtime disabled");
  },
};

async function settingsFor(project: string): Promise<Settings> {
  const cached = cache.get(project);
  if (cached) return cached;
  const [row]: {
    secret: string;
    max_connections: number;
    max_channels: number;
    max_message_bytes: number;
    max_rate: number;
    public_channels: boolean;
    allowed_origins: string[];
    webhook_url: string | null;
    webhook_events: string[];
  }[] = await sql`select * from mybase.realtime_projects where project = ${project}`;
  if (!row) throw new NotFoundError("realtime is not enabled for this project");
  const loaded: Settings = {
    secret: row.secret,
    maxConnections: row.max_connections,
    maxChannels: row.max_channels,
    maxMessageBytes: row.max_message_bytes,
    maxRate: row.max_rate,
    publicChannels: row.public_channels,
    allowedOrigins: row.allowed_origins,
    webhookUrl: row.webhook_url,
    webhookEvents: new Set(row.webhook_events.filter((e): e is RealtimeWebhookEventType => (REALTIME_WEBHOOK_EVENTS as readonly string[]).includes(e))),
  };
  cache.set(project, loaded);
  return loaded;
}

export const requireEnabled = (project: string) => settingsFor(project);

async function reload(project: string) {
  cache.delete(project);
  return settingsFor(project);
}

export async function getSettings(project: string): Promise<RealtimeSettings> {
  const s = await settingsFor(project);
  const base = `${publicApiUrl()}/realtime/${project}`;
  return {
    secret: s.secret,
    maxConnections: s.maxConnections,
    maxChannels: s.maxChannels,
    maxMessageBytes: s.maxMessageBytes,
    maxRate: s.maxRate,
    publicChannels: s.publicChannels,
    allowedOrigins: s.allowedOrigins,
    webhookUrl: s.webhookUrl,
    webhookEvents: [...s.webhookEvents],
    socketUrl: base.replace(/^http/, "ws"),
    publishUrl: `${base}/publish`,
  };
}

function intSetting(body: Record<string, unknown>, key: "maxConnections" | "maxChannels" | "maxMessageBytes" | "maxRate"): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  const { min, max } = REALTIME_LIMITS[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new BadRequestError(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<RealtimeSettings> {
  const s = await settingsFor(project);
  const maxConnections = intSetting(body, "maxConnections") ?? s.maxConnections;
  const maxChannels = intSetting(body, "maxChannels") ?? s.maxChannels;
  const maxMessageBytes = intSetting(body, "maxMessageBytes") ?? s.maxMessageBytes;
  const maxRate = intSetting(body, "maxRate") ?? s.maxRate;
  let publicChannels = s.publicChannels;
  if (body.publicChannels !== undefined) {
    if (typeof body.publicChannels !== "boolean") throw new BadRequestError("publicChannels must be true or false");
    publicChannels = body.publicChannels;
  }
  let allowedOrigins = s.allowedOrigins;
  if (body.allowedOrigins !== undefined) {
    const list = body.allowedOrigins;
    if (!Array.isArray(list) || list.length > 50) throw new BadRequestError("allowedOrigins must be a list of up to 50 origins");
    allowedOrigins = [...new Set(list.map(origin))];
  }
  let webhookUrl = s.webhookUrl;
  if (body.webhookUrl !== undefined) {
    const url = body.webhookUrl;
    if (url === null || url === "") webhookUrl = null;
    else {
      let parsed: URL | null = null;
      try {
        parsed = typeof url === "string" && url.length <= 2048 ? new URL(url) : null;
      } catch {}
      if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) throw new BadRequestError("webhookUrl must be an http(s) URL");
      webhookUrl = parsed.href;
    }
  }
  let webhookEvents = [...s.webhookEvents];
  if (body.webhookEvents !== undefined) {
    const list = body.webhookEvents;
    if (!Array.isArray(list) || !list.every((e) => (REALTIME_WEBHOOK_EVENTS as readonly unknown[]).includes(e))) {
      throw new BadRequestError(`webhookEvents must be a list of: ${REALTIME_WEBHOOK_EVENTS.join(", ")}`);
    }
    webhookEvents = [...new Set(list as RealtimeWebhookEventType[])];
  }
  await sql`
    update mybase.realtime_projects set
      max_connections = ${maxConnections}, max_channels = ${maxChannels}, max_message_bytes = ${maxMessageBytes},
      max_rate = ${maxRate}, public_channels = ${publicChannels}, allowed_origins = ${sql.array(allowedOrigins, "text")},
      webhook_url = ${webhookUrl}, webhook_events = ${sql.array(webhookEvents, "text")}
    where project = ${project}`;
  if (!webhookUrl) dropWebhooks(project);
  await reload(project);
  log.info("realtime settings changed", { fields: Object.keys(body).filter((k) => k !== "secret") });
  return getSettings(project);
}

function origin(value: unknown): string {
  try {
    if (typeof value === "string") {
      const o = new URL(value).origin;
      if (o !== "null") return o;
    }
  } catch {}
  throw new BadRequestError(`${JSON.stringify(value)} is not an origin (like https://shop.example.com)`);
}

/** New secret: every socket is closed (4002) so clients come back with tokens signed by it. */
export async function rotateSecret(project: string, log: Logger): Promise<RealtimeSettings> {
  await settingsFor(project);
  await sql`update mybase.realtime_projects set secret = ${newSecret()} where project = ${project}`;
  await reload(project);
  closeAll(project, CLOSE_CODES.rotated, "secret rotated: get a new token");
  log.info("realtime secret rotated");
  return getSettings(project);
}

/** A 5-minute token for the dashboard's try-it panel: every channel. */
export async function dashboardToken(project: string): Promise<{ token: string }> {
  const s = await settingsFor(project);
  return { token: await createRealtimeToken(s.secret, { project, userId: "mybase-dashboard", userInfo: { name: "mybase dashboard" }, subscribe: ["*"], publish: ["*"], ttl: 300 }) };
}

export function getStats(project: string): RealtimeStats {
  const p = live.get(project);
  const s = stats.get(project);
  return {
    connections: p?.sockets.size ?? 0,
    peakConnections: s?.peak ?? 0,
    channels: p?.channels.size ?? 0,
    hours: s?.hours ?? [],
    webhook: webhookStatus(project),
  };
}

export function listChannels(project: string, prefix = ""): ChannelInfo[] {
  const p = live.get(project);
  if (!p) return [];
  const out: ChannelInfo[] = [];
  for (const [channel, ch] of p.channels) {
    if (!channel.startsWith(prefix)) continue;
    out.push(ch.members ? { channel, subscribers: ch.subscribers, members: ch.members.size } : { channel, subscribers: ch.subscribers });
  }
  return out.sort((a, b) => b.subscribers - a.subscribers || a.channel.localeCompare(b.channel)).slice(0, 1000);
}

export function listMembers(project: string, channel: string): RealtimeMember[] {
  if (!channel.startsWith(PRESENCE_PREFIX) || !CHANNEL_PATTERN.test(channel)) throw new BadRequestError(`only ${PRESENCE_PREFIX} channels have members`);
  const members = live.get(project)?.channels.get(channel)?.members;
  return members ? [...members].map(([uid, m]) => member(uid, m.info)) : [];
}

const member = (uid: string, info: unknown): RealtimeMember => (info === undefined ? { uid } : { uid, info });

// ---- publishing over HTTP --------------------------------------------------------------

function checkTarget(channel: unknown, event: unknown): asserts channel is string {
  if (typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) throw new BadRequestError("channel must be 1–128 letters, digits, or _-:.=@");
  if (typeof event !== "string" || !EVENT_PATTERN.test(event) || event.startsWith("mybase:")) {
    throw new BadRequestError("event must be 1–64 letters, digits, or _-:. (not starting with mybase:)");
  }
}

/** `{ channel, event, data }` or `{ messages: [...] }`, from the app's server. */
export function publish(project: string, body: Record<string, unknown>): { ids: string[] } {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [body];
  if (messages.length === 0 || messages.length > REALTIME_LIMITS.publishBatch) throw new BadRequestError(`send 1–${REALTIME_LIMITS.publishBatch} messages`);
  for (const m of messages) {
    if (typeof m !== "object" || m === null) throw new BadRequestError("each message must be an object");
    checkTarget(m.channel, m.event);
  }
  const ids: string[] = [];
  const hour = hourOf(project);
  for (const m of messages) {
    const id = crypto.randomUUID();
    const channel = m.channel as string;
    const frame: ServerFrame = { type: "message", channel, event: m.event as string, data: m.data ?? null, uid: null, id, at: new Date().toISOString() };
    server?.publish(topic(project, channel), JSON.stringify(frame));
    hour.messagesOut += live.get(project)?.channels.get(channel)?.subscribers ?? 0;
    ids.push(id);
  }
  return { ids };
}

// ---- sockets -----------------------------------------------------------------------------

const connectLimit = new RateLimit(30);

/** Upgrades `/realtime/:project`. Returns a response only when it can't. */
export async function upgradeRealtime(req: BunRequest, srv: Server<SocketData>, ip: string, log: Logger): Promise<Response | undefined> {
  const { project = "" } = req.params as { project?: string };
  const fail = (error: string, status: number) => Response.json({ error }, { status });
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail("connect with a WebSocket (connectRealtime in @mybase-dev/sdk/realtime)", 426);
  if (!PROJECT_NAME_PATTERN.test(project)) return fail("not found", 404);
  const settings = await settingsFor(project).catch(() => null);
  if (!settings) return fail("realtime is not enabled for this project", 404);
  const from = req.headers.get("Origin");
  if (settings.allowedOrigins.length && (!from || !settings.allowedOrigins.includes(from))) return fail("origin not allowed", 403);
  if (!connectLimit.take(ip)) return Response.json({ error: "too many new connections; try again in a minute" }, { status: 429, headers: { "Retry-After": "60" } });
  if (totalSockets >= MAX_SOCKETS || (live.get(project)?.sockets.size ?? 0) >= settings.maxConnections) return fail("too many realtime connections", 503);
  const now = Date.now();
  const data: RealtimeData = {
    kind: "realtime",
    id: crypto.randomUUID().slice(0, 12),
    project,
    ip,
    log: log.child({ project }),
    authed: false,
    uid: null,
    info: undefined,
    sub: [],
    pub: [],
    exp: null,
    channels: new Set(),
    bucket: settings.maxRate,
    refilledAt: now,
    limitedSince: 0,
    lastSeen: now,
    start: now,
    framesIn: 0,
    framesOut: 0,
  };
  if (srv.upgrade(req, { data })) return undefined;
  return fail("websocket upgrade failed", 400);
}

function send(ws: RtSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
  ws.data.framesOut++;
  if (ws.getBufferedAmount() > MAX_BUFFERED) {
    ws.data.log.warn("realtime socket closed: not reading fast enough", { conn: ws.data.id });
    ws.close(1013, "too slow");
  }
}

function sendError(ws: RtSocket, code: RealtimeErrorCode, message: string, ref?: string, channel?: string) {
  send(ws, { type: "error", code, message, ...(ref ? { ref } : {}), ...(channel ? { channel } : {}) });
}

function closeAll(project: string, code: number, reason: string) {
  const p = live.get(project);
  if (!p) return;
  for (const ws of [...p.sockets]) ws.close(code, reason);
}

function projectLive(project: string): ProjectLive {
  let p = live.get(project);
  if (!p) live.set(project, (p = { sockets: new Set(), channels: new Map() }));
  return p;
}

function join(ws: RtSocket, channel: string): RealtimeMember[] | undefined {
  const d = ws.data;
  const p = projectLive(d.project);
  ws.subscribe(topic(d.project, channel));
  d.channels.add(channel);
  const at = new Date().toISOString();
  let ch = p.channels.get(channel);
  if (!ch) {
    ch = { subscribers: 0, members: channel.startsWith(PRESENCE_PREFIX) ? new Map() : null };
    p.channels.set(channel, ch);
    notify(d.project, "channel", { type: "channel", channel, action: "occupied", at });
  }
  ch.subscribers++;
  if (!ch.members || !d.uid) return undefined;
  const existing = ch.members.get(d.uid);
  if (existing) existing.sockets++;
  else {
    ch.members.set(d.uid, { info: d.info, sockets: 1 });
    const m = member(d.uid, d.info);
    ws.publish(topic(d.project, channel), JSON.stringify({ type: "presence", channel, action: "join", member: m } satisfies ServerFrame));
    notify(d.project, "presence", { type: "presence", channel, action: "join", member: m, at });
  }
  return [...ch.members].map(([uid, x]) => member(uid, x.info));
}

/** `closing`: the socket is gone (Bun has already dropped its subscriptions). */
function leave(ws: RtSocket, channel: string, closing = false) {
  const d = ws.data;
  if (!d.channels.delete(channel)) return;
  if (!closing) ws.unsubscribe(topic(d.project, channel));
  const p = live.get(d.project);
  const ch = p?.channels.get(channel);
  if (!p || !ch) return;
  const at = new Date().toISOString();
  ch.subscribers--;
  if (ch.members && d.uid) {
    const m = ch.members.get(d.uid);
    if (m && --m.sockets <= 0) {
      ch.members.delete(d.uid);
      const gone = member(d.uid, m.info);
      server?.publish(topic(d.project, channel), JSON.stringify({ type: "presence", channel, action: "leave", member: gone } satisfies ServerFrame));
      notify(d.project, "presence", { type: "presence", channel, action: "leave", member: gone, at });
    }
  }
  if (ch.subscribers <= 0) {
    p.channels.delete(channel);
    notify(d.project, "channel", { type: "channel", channel, action: "vacated", at });
  }
}

/** Token bucket: `maxRate` frames per second. False when over. */
function takeFrame(ws: RtSocket, s: Settings, now: number): boolean {
  const d = ws.data;
  d.bucket = Math.min(s.maxRate, d.bucket + ((now - d.refilledAt) / 1000) * s.maxRate);
  d.refilledAt = now;
  if (d.bucket >= 1) {
    d.bucket--;
    d.limitedSince = 0;
    return true;
  }
  d.limitedSince ||= now;
  return false;
}

function rejectToken(ws: RtSocket, reason: string) {
  const d = ws.data;
  d.log.warn("realtime token rejected", { ip: d.ip, conn: d.id, reason });
  // Outside any request, so the IP is passed along; once a minute per IP.
  auditOnce(`realtime.rejected:${d.ip}`, 60_000, { action: "realtime.rejected", outcome: "denied", ip: d.ip, project: d.project, meta: { reason } });
}

async function authenticate(ws: RtSocket, s: Settings, frame: Extract<ClientFrame, { type: "auth" }>) {
  const d = ws.data;
  const ref = typeof frame.ref === "string" ? frame.ref : undefined;
  if (frame.token === undefined) {
    if (d.authed) return sendError(ws, "unauthorized", "send a token to change it", ref);
    if (!s.publicChannels) {
      rejectToken(ws, "missing");
      return ws.close(CLOSE_CODES.badToken, "a token is required");
    }
    d.authed = true;
    send(ws, { type: "ready", connectionId: d.id, uid: null, ...(ref ? { ref } : {}) });
    return;
  }
  const result = await verifyRealtimeToken(s.secret, frame.token, d.project);
  if (ws.readyState !== 1) return;
  if (!result.ok) {
    rejectToken(ws, result.error);
    const message = result.error === "expired" ? "token expired" : result.error === "project" ? "token is for another project" : "invalid token";
    if (d.authed) return sendError(ws, "unauthorized", message, ref);
    return ws.close(result.error === "expired" ? CLOSE_CODES.expired : CLOSE_CODES.badToken, message);
  }
  const t = result.payload;
  // Presence counts are per user: a socket keeps its user for life.
  if (d.authed && (t.uid ?? null) !== d.uid) return sendError(ws, "forbidden", "a refreshed token must be for the same user", ref);
  d.authed = true;
  d.uid = t.uid ?? null;
  d.info = t.info;
  d.sub = t.sub;
  d.pub = t.pub;
  d.exp = t.exp;
  // A narrower token drops channels it no longer covers.
  for (const channel of [...d.channels]) if (!maySubscribe(d, s, channel)) leave(ws, channel);
  send(ws, { type: "ready", connectionId: d.id, uid: d.uid, ...(ref ? { ref } : {}) });
}

const maySubscribe = (d: RealtimeData, s: Settings, channel: string) => channelAllowed(d.sub, channel) || (s.publicChannels && channel.startsWith(PUBLIC_PREFIX));

function subscribe(ws: RtSocket, s: Settings, channel: unknown, ref?: string) {
  const d = ws.data;
  if (typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) return sendError(ws, "bad_channel", "channel must be 1–128 letters, digits, or _-:.=@", ref);
  if (!maySubscribe(d, s, channel)) return sendError(ws, "forbidden", `not allowed to subscribe to ${channel}`, ref, channel);
  if (channel.startsWith(PRESENCE_PREFIX) && !d.uid) return sendError(ws, "forbidden", "presence channels need a token with a userId", ref, channel);
  if (d.channels.has(channel)) {
    const members = live.get(d.project)?.channels.get(channel)?.members;
    return send(ws, { type: "subscribed", channel, ...(members ? { members: [...members].map(([uid, m]) => member(uid, m.info)) } : {}), ...(ref ? { ref } : {}) });
  }
  if (d.channels.size >= s.maxChannels) return sendError(ws, "too_many_channels", `at most ${s.maxChannels} channels per connection`, ref, channel);
  const members = join(ws, channel);
  send(ws, { type: "subscribed", channel, ...(members ? { members } : {}), ...(ref ? { ref } : {}) });
}

function publishFromClient(ws: RtSocket, frame: Record<string, unknown>, ref?: string) {
  const d = ws.data;
  const { channel, event } = frame;
  if (typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) return sendError(ws, "bad_channel", "channel must be 1–128 letters, digits, or _-:.=@", ref);
  if (typeof event !== "string" || !EVENT_PATTERN.test(event) || event.startsWith("mybase:")) return sendError(ws, "bad_event", "event must be 1–64 letters, digits, or _-:.", ref, channel);
  if (!channelAllowed(d.pub, channel)) return sendError(ws, "forbidden", `not allowed to publish to ${channel}`, ref, channel);
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const data = frame.data ?? null;
  // To everyone subscribed but the sender.
  ws.publish(topic(d.project, channel), JSON.stringify({ type: "message", channel, event, data, uid: d.uid, id, at } satisfies ServerFrame));
  const subscribers = live.get(d.project)?.channels.get(channel)?.subscribers ?? 0;
  hourOf(d.project).messagesOut += Math.max(0, subscribers - (d.channels.has(channel) ? 1 : 0));
  notify(d.project, "message", { type: "message", channel, event, data, uid: d.uid, id, at });
  send(ws, { type: "ok", id, ...(ref ? { ref } : {}) });
}

function onMessage(ws: RtSocket, message: string | Buffer) {
  const d = ws.data;
  const now = Date.now();
  d.lastSeen = now;
  d.framesIn++;
  const s = cache.get(d.project);
  if (!s) return ws.close(CLOSE_CODES.disabled, "realtime is not enabled for this project");
  hourOf(d.project).messagesIn++;
  const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
  if (size > s.maxMessageBytes) return sendError(ws, "too_large", `frames are limited to ${s.maxMessageBytes} bytes`);
  if (!takeFrame(ws, s, now)) {
    if (now - d.limitedSince > RATE_GRACE_MS) return ws.close(CLOSE_CODES.rateLimited, "sending too fast");
    return sendError(ws, "rate_limited", `at most ${s.maxRate} frames per second`);
  }
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
  } catch {
    return sendError(ws, "bad_frame", "frames are JSON objects with a type");
  }
  if (typeof frame !== "object" || frame === null || typeof frame.type !== "string") return sendError(ws, "bad_frame", "frames are JSON objects with a type");
  const ref = typeof frame.ref === "string" && frame.ref.length <= 64 ? frame.ref : undefined;
  if (frame.type === "ping") return send(ws, { type: "pong", ...(ref ? { ref } : {}) });
  if (frame.type === "auth") {
    void authenticate(ws, s, frame as Extract<ClientFrame, { type: "auth" }>).catch((err) => {
      d.log.error("realtime auth failed", { conn: d.id, err });
      ws.close(1011, "internal error");
    });
    return;
  }
  if (!d.authed) return sendError(ws, "not_ready", "send auth first", ref);
  switch (frame.type) {
    case "subscribe":
      return subscribe(ws, s, frame.channel, ref);
    case "unsubscribe":
      if (typeof frame.channel === "string") leave(ws, frame.channel);
      return send(ws, { type: "unsubscribed", channel: String(frame.channel), ...(ref ? { ref } : {}) });
    case "publish":
      return publishFromClient(ws, frame, ref);
    default:
      return sendError(ws, "bad_frame", `unknown frame type ${JSON.stringify(frame.type).slice(0, 40)}`, ref);
  }
}

// Closes sockets that never sent auth, went silent, or outlived their token. One timer for all.
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep() {
  const now = Date.now();
  for (const p of live.values()) {
    for (const ws of p.sockets) {
      const d = ws.data;
      if (!d.authed && now - d.start > REALTIME_LIMITS.authTimeoutMs) ws.close(CLOSE_CODES.badToken, "send auth first");
      else if (now - d.lastSeen > REALTIME_LIMITS.idleMs) ws.close(1001, "idle");
      else if (d.exp !== null && d.exp * 1000 <= now) ws.close(CLOSE_CODES.expired, "token expired");
    }
  }
  if (totalSockets === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

export const realtimeWebsocket: WebSocketHandler<RealtimeData> = {
  open(ws) {
    const d = ws.data;
    const p = projectLive(d.project);
    p.sockets.add(ws);
    totalSockets++;
    hourOf(d.project).connects++;
    const s = stats.get(d.project)!;
    s.peak = Math.max(s.peak, p.sockets.size);
    sweeper ??= setInterval(sweep, SWEEP_MS);
  },
  message: onMessage,
  close(ws, code) {
    const d = ws.data;
    for (const channel of [...d.channels]) leave(ws, channel, true);
    const p = live.get(d.project);
    p?.sockets.delete(ws);
    if (p && p.sockets.size === 0 && p.channels.size === 0) live.delete(d.project);
    totalSockets--;
    d.log.info("realtime connection closed", { conn: d.id, user: d.uid ?? undefined, code, framesIn: d.framesIn, framesOut: d.framesOut, ms: Date.now() - d.start });
  },
};

/** On shutdown: tells clients to come back (they reconnect to the next process). */
export function closeAllSockets() {
  for (const project of live.keys()) closeAll(project, 1001, "server restarting");
}

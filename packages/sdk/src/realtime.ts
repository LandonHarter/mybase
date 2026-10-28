// mybase realtime: WebSocket pub/sub channels for apps whose server can't hold sockets
// (Vercel, Netlify, other serverless hosts). Browsers keep one socket open to mybase; your
// backend publishes over HTTP and hands browsers short-lived tokens it signs itself.
//
//   // Server (e.g. a Next.js route): sign a token for the signed-in user. No network call.
//   const token = await createRealtimeToken(process.env.MYBASE_REALTIME_SECRET!, {
//     project: "shop", userId: user.id, userInfo: { name: user.name },
//     subscribe: ["presence:room-1", `user:${user.id}`], publish: ["presence:room-1"],
//   });
//
//   // Browser
//   const rt = connectRealtime({ apiUrl, project: "shop", token: () => fetch("/api/rt-token").then((r) => r.text()) });
//   const room = rt.channel("presence:room-1");
//   room.on("chat", (data, meta) => show(meta.uid, data));
//   await room.publish("chat", { text: "hi" });
//
//   // Server: publish to everyone subscribed
//   const realtime = createRealtimeClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   await realtime.publish(`user:${id}`, "order.shipped", { orderId });
//
// Channels named `public:…` can be read without a token (if the project allows it).
// `presence:…` channels track who's in them (needs a token with a userId).
// Web Crypto + global WebSocket only: browsers, Bun, Node 22+, Deno, edge runtimes.
import { MybaseApiError, verifyCronSignature, SIGNATURE_HEADER, CronVerificationError } from "./cron";

export { MybaseApiError, SIGNATURE_HEADER };

export const REALTIME_LIMITS = {
  /** Longest a token may live. */
  maxTokenTtlSec: 24 * 3600,
  /** `userInfo`, as JSON. */
  infoBytes: 1024,
  tokenLength: 8 * 1024,
  /** Channel patterns per token (subscribe + publish). */
  tokenPatterns: 100,
  /** Messages per HTTP publish, and the request size. */
  publishBatch: 100,
  publishBytes: 64 * 1024,
  /** The client pings this often; the server drops sockets silent for `idleMs`. */
  pingMs: 25_000,
  idleMs: 75_000,
  /** A new socket must send `auth` within this. */
  authTimeoutMs: 10_000,
  /** Per-project settings: default, min, max. */
  maxConnections: { default: 500, min: 1, max: 10_000 },
  maxChannels: { default: 100, min: 1, max: 1_000 },
  maxMessageBytes: { default: 32 * 1024, min: 1024, max: 1024 * 1024 },
  /** Frames a socket may send per second. */
  maxRate: { default: 20, min: 1, max: 1_000 },
} as const;

/** `public:`, `presence:`, or plain. Letters, digits, `_-:.=@`, 1–128 chars. */
export const CHANNEL_PATTERN = /^[A-Za-z0-9_\-:.=@]{1,128}$/;
/** Event names. `mybase:` is reserved. */
export const EVENT_PATTERN = /^[A-Za-z0-9_\-:.]{1,64}$/;
export const PUBLIC_PREFIX = "public:";
export const PRESENCE_PREFIX = "presence:";

/** Close codes the server uses. The client reconnects on all but `badToken` with a fixed token. */
export const CLOSE_CODES = {
  /** No `auth` in time, or a token that doesn't verify. */
  badToken: 4001,
  /** The project's secret was rotated: get a new token. */
  rotated: 4002,
  /** The token expired without a refresh. */
  expired: 4003,
  /** Kept sending past the rate limit. */
  rateLimited: 4008,
  /** The service was turned off. */
  disabled: 4004,
} as const;

/** What a token grants. Patterns: exact names, `prefix*`, or `*`. */
export interface RealtimeTokenPayload {
  /** Project. */
  p: string;
  /** User id: who this is to presence members and in messages it sends. */
  uid?: string;
  /** Shown to presence members. */
  info?: unknown;
  /** Channels it may subscribe to. */
  sub: string[];
  /** Channels it may publish to (from the browser). */
  pub: string[];
  /** Unix seconds. */
  exp: number;
}

export interface RealtimeTokenOptions {
  project: string;
  userId?: string;
  /** Small JSON (≤ 1 KB) other presence members see, e.g. `{ name }`. */
  userInfo?: unknown;
  /** Channel patterns the browser may subscribe to: `"room-1"`, `"user:42:*"`, `"*"`. */
  subscribe?: string[];
  /** Channel patterns it may publish to. Default none (only your server publishes). */
  publish?: string[];
  /** Seconds. Default 3600, max 86400. Pass a function as `token` to refresh before it ends. */
  ttl?: number;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isPattern = (p: unknown): p is string => typeof p === "string" && (p === "*" || CHANNEL_PATTERN.test(p.endsWith("*") ? p.slice(0, -1) || "x" : p));

/** True when `channel` matches one of the patterns (exact, `prefix*`, or `*`). */
export function channelAllowed(patterns: readonly string[], channel: string): boolean {
  for (const p of patterns) {
    if (p === "*" || p === channel) return true;
    if (p.endsWith("*") && channel.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** Signs a token for a browser with the project's realtime secret. Server-side only. */
export async function createRealtimeToken(secret: string, options: RealtimeTokenOptions): Promise<string> {
  if (!secret) throw new Error("mybase realtime: no secret (MYBASE_REALTIME_SECRET)");
  const ttl = options.ttl ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > REALTIME_LIMITS.maxTokenTtlSec) throw new Error(`mybase realtime: ttl must be 1–${REALTIME_LIMITS.maxTokenTtlSec} seconds`);
  const sub = options.subscribe ?? [];
  const pub = options.publish ?? [];
  for (const p of [...sub, ...pub]) if (!isPattern(p)) throw new Error(`mybase realtime: bad channel pattern ${JSON.stringify(p)}`);
  if (sub.length + pub.length > REALTIME_LIMITS.tokenPatterns) throw new Error(`mybase realtime: at most ${REALTIME_LIMITS.tokenPatterns} channel patterns`);
  if (options.userInfo !== undefined && encoder.encode(JSON.stringify(options.userInfo)).length > REALTIME_LIMITS.infoBytes) {
    throw new Error(`mybase realtime: userInfo is over ${REALTIME_LIMITS.infoBytes} bytes`);
  }
  const payload: RealtimeTokenPayload = { p: options.project, sub, pub, exp: Math.floor(Date.now() / 1000) + ttl };
  if (options.userId !== undefined) {
    if (typeof options.userId !== "string" || !options.userId || options.userId.length > 128) throw new Error("mybase realtime: userId must be 1–128 characters");
    payload.uid = options.userId;
  }
  if (options.userInfo !== undefined) payload.info = options.userInfo;
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `mbrt.${body}.${await hmac(secret, body)}`;
}

/** Reads a token's payload without checking it (clients use it for `exp`). */
export function decodeRealtimeToken(token: string): RealtimeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "mbrt") return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as RealtimeTokenPayload;
  } catch {
    return null;
  }
}

export type TokenProblem = "invalid" | "expired" | "project";

/** Checks a token's signature, shape, project, and expiry. Used by the mybase server. */
export async function verifyRealtimeToken(secret: string, token: unknown, project: string, now = Date.now()): Promise<{ ok: true; payload: RealtimeTokenPayload } | { ok: false; error: TokenProblem }> {
  if (typeof token !== "string" || token.length > REALTIME_LIMITS.tokenLength) return { ok: false, error: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "mbrt") return { ok: false, error: "invalid" };
  if (!safeEqual(await hmac(secret, parts[1]!), parts[2]!)) return { ok: false, error: "invalid" };
  const p = decodeRealtimeToken(token);
  const ok =
    p &&
    typeof p.p === "string" &&
    Number.isInteger(p.exp) &&
    Array.isArray(p.sub) &&
    Array.isArray(p.pub) &&
    p.sub.length + p.pub.length <= REALTIME_LIMITS.tokenPatterns &&
    p.sub.every(isPattern) &&
    p.pub.every(isPattern) &&
    (p.uid === undefined || (typeof p.uid === "string" && p.uid.length > 0 && p.uid.length <= 128));
  if (!ok) return { ok: false, error: "invalid" };
  if (p.p !== project) return { ok: false, error: "project" };
  if (p.exp * 1000 <= now) return { ok: false, error: "expired" };
  return { ok: true, payload: p };
}

// ---- wire format --------------------------------------------------------------

export interface RealtimeMember {
  uid: string;
  info?: unknown;
}

/** Frames a client sends. `ref` comes back on the reply (`ok` or `error`). */
export type ClientFrame =
  | { type: "auth"; token?: string; ref?: string }
  | { type: "subscribe"; channel: string; ref?: string }
  | { type: "unsubscribe"; channel: string; ref?: string }
  | { type: "publish"; channel: string; event: string; data?: unknown; ref?: string }
  | { type: "ping"; ref?: string };

/** Frames the server sends. */
export type ServerFrame =
  | { type: "ready"; connectionId: string; uid: string | null; ref?: string }
  | { type: "subscribed"; channel: string; members?: RealtimeMember[]; ref?: string }
  | { type: "unsubscribed"; channel: string; ref?: string }
  | { type: "message"; channel: string; event: string; data: unknown; uid: string | null; id: string; at: string }
  | { type: "presence"; channel: string; action: "join" | "leave"; member: RealtimeMember }
  | { type: "ok"; ref?: string; id?: string }
  | { type: "error"; code: string; message: string; ref?: string; channel?: string }
  | { type: "pong"; ref?: string };

export type RealtimeErrorCode = "bad_frame" | "unauthorized" | "forbidden" | "bad_channel" | "bad_event" | "too_large" | "too_many_channels" | "rate_limited" | "not_ready";

// ---- browser / any client -------------------------------------------------------

export type ConnectionState = "connecting" | "open" | "closed";

export interface MessageMeta {
  channel: string;
  event: string;
  /** Who sent it from a browser; null when your server published it. */
  uid: string | null;
  id: string;
  at: string;
}

export interface PresenceChange {
  action: "join" | "leave";
  member: RealtimeMember;
}

export interface RealtimeChannel {
  readonly name: string;
  /** Resolves once subscribed (again after each reconnect). Rejects if refused. */
  ready(): Promise<void>;
  /** Listens for one event, or all with `"*"`. Returns a function that stops listening. */
  on<T = unknown>(event: string, listener: (data: T, meta: MessageMeta) => void): () => void;
  /** Sends to everyone else subscribed. Needs a token whose `publish` patterns cover the channel. */
  publish(event: string, data?: unknown): Promise<void>;
  /** Presence channels: who's here now (you included). */
  members(): RealtimeMember[];
  /** Presence channels: joins and leaves. */
  onPresence(listener: (change: PresenceChange) => void): () => void;
  unsubscribe(): void;
}

export interface RealtimeConnection {
  readonly state: ConnectionState;
  /** null until the first `ready`, and for anonymous connections. */
  readonly userId: string | null;
  channel(name: string): RealtimeChannel;
  on(event: "state", listener: (state: ConnectionState) => void): () => void;
  on(event: "error", listener: (err: RealtimeError) => void): () => void;
  /** Closes for good (no reconnect). */
  close(): void;
}

export class RealtimeError extends Error {
  override name = "RealtimeError";
  constructor(
    message: string,
    readonly code: string,
    readonly channel?: string,
  ) {
    super(message);
  }
}

export interface ConnectOptions {
  /** Where the mybase API is reachable from here (https:// or http://). */
  apiUrl: string;
  project: string;
  /** A token from `createRealtimeToken`, or a function that fetches a fresh one (called on each connect and before expiry). Omit for `public:` channels only. */
  token?: string | (() => string | Promise<string>);
  /** For runtimes without a global WebSocket. */
  WebSocket?: typeof WebSocket;
  /** ms to wait for a publish to be accepted. Default 10000. */
  timeoutMs?: number;
}

type Listener<T extends unknown[]> = (...args: T) => void;

function emitter<T extends unknown[]>() {
  const set = new Set<Listener<T>>();
  return {
    add(l: Listener<T>) {
      set.add(l);
      return () => void set.delete(l);
    },
    emit(...args: T) {
      for (const l of [...set]) {
        try {
          l(...args);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    },
  };
}

/** Opens a socket to mybase that reconnects by itself and resubscribes its channels. */
export function connectRealtime(options: ConnectOptions): RealtimeConnection {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  if (!WS) throw new Error("mybase realtime: no WebSocket here; pass options.WebSocket");
  const wsUrl = `${options.apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/realtime/${encodeURIComponent(options.project)}`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let state: ConnectionState = "connecting";
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let ready = false;
  let attempt = 0;
  let userId: string | null = null;
  let refSeq = 0;
  let lastFrame = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { resolve: (frame: ServerFrame) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stateEvents = emitter<[ConnectionState]>();
  const errorEvents = emitter<[RealtimeError]>();
  const channels = new Map<string, ChannelImpl>();

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    stateEvents.emit(next);
  };

  const getToken = async () => (typeof options.token === "function" ? await options.token() : options.token);

  function send(frame: ClientFrame) {
    if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(frame));
  }

  /** Sends a frame and waits for its `ok`/reply. */
  function request(frame: ClientFrame & { ref?: string }): Promise<ServerFrame> {
    const ref = String(++refSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(ref);
        reject(new RealtimeError("mybase realtime: no answer in time", "timeout"));
      }, timeoutMs);
      pending.set(ref, { resolve, reject, timer });
      send({ ...frame, ref });
    });
  }

  function failPending(err: RealtimeError) {
    for (const [ref, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
      pending.delete(ref);
    }
  }

  async function scheduleRefresh(token: string | undefined) {
    clearTimeout(refreshTimer);
    if (!token || typeof options.token !== "function") return;
    const exp = decodeRealtimeToken(token)?.exp;
    if (!exp) return;
    const inMs = Math.max(5_000, exp * 1000 - Date.now() - 60_000);
    refreshTimer = setTimeout(async () => {
      try {
        const fresh = await getToken();
        if (!ready || !fresh) return;
        await request({ type: "auth", token: fresh });
        void scheduleRefresh(fresh);
      } catch (err) {
        errorEvents.emit(err instanceof RealtimeError ? err : new RealtimeError(String((err as Error)?.message ?? err), "refresh_failed"));
      }
    }, inMs);
  }

  function connect() {
    if (closedByUser) return;
    setState("connecting");
    ready = false;
    let socket: WebSocket;
    try {
      socket = new WS(wsUrl);
    } catch (err) {
      errorEvents.emit(new RealtimeError(String((err as Error)?.message ?? err), "connect_failed"));
      return retry();
    }
    ws = socket;
    socket.onopen = async () => {
      lastFrame = Date.now();
      let token: string | undefined;
      try {
        token = await getToken();
      } catch (err) {
        errorEvents.emit(new RealtimeError(`mybase realtime: getting a token failed: ${(err as Error)?.message ?? err}`, "token_failed"));
        socket.close();
        return;
      }
      if (ws !== socket) return;
      try {
        const frame = await request(token ? { type: "auth", token } : { type: "auth" });
        if (frame.type !== "ready") return;
        userId = frame.uid;
        ready = true;
        attempt = 0;
        setState("open");
        void scheduleRefresh(token);
      } catch {
        // The close that follows a refused auth reconnects (or not).
      }
    };
    socket.onmessage = (event) => {
      lastFrame = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      handle(frame);
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      ready = false;
      clearTimeout(refreshTimer);
      failPending(new RealtimeError("mybase realtime: connection closed", "closed"));
      for (const ch of channels.values()) ch.disconnected();
      if (event.code === CLOSE_CODES.badToken || event.code === CLOSE_CODES.expired) {
        errorEvents.emit(new RealtimeError(event.reason || "token refused", event.code === CLOSE_CODES.expired ? "expired" : "unauthorized"));
        // A fixed token won't get better by retrying.
        if (typeof options.token !== "function") {
          closedByUser = true;
          return setState("closed");
        }
      }
      if (event.code === CLOSE_CODES.disabled) {
        errorEvents.emit(new RealtimeError(event.reason || "realtime is off for this project", "disabled"));
      }
      if (closedByUser) return setState("closed");
      // A rotated secret: reconnect now, with a new token.
      if (event.code === CLOSE_CODES.rotated) attempt = 0;
      retry();
    };
    socket.onerror = () => {
      // onclose follows.
    };
  }

  function retry() {
    if (closedByUser) return;
    setState("connecting");
    const base = Math.min(30_000, 1000 * 2 ** attempt);
    attempt++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, attempt === 1 ? Math.random() * 500 : base / 2 + Math.random() * (base / 2));
  }

  function handle(frame: ServerFrame) {
    const ref = "ref" in frame ? frame.ref : undefined;
    if (ref && pending.has(ref)) {
      const p = pending.get(ref)!;
      pending.delete(ref);
      clearTimeout(p.timer);
      if (frame.type === "error") p.reject(new RealtimeError(frame.message, frame.code, frame.channel));
      else p.resolve(frame);
      return;
    }
    switch (frame.type) {
      case "message":
        channels.get(frame.channel)?.message(frame);
        break;
      case "presence":
        channels.get(frame.channel)?.presence(frame.action, frame.member);
        break;
      case "error":
        errorEvents.emit(new RealtimeError(frame.message, frame.code, frame.channel));
        break;
    }
  }

  // Pings keep proxies (Cloudflare cuts idle sockets at ~100 s) from closing the socket, and
  // notice a dead connection the browser hasn't.
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WS.OPEN) return;
    if (Date.now() - lastFrame > REALTIME_LIMITS.pingMs * 2 + 10_000) {
      ws.close();
      return;
    }
    send({ type: "ping" });
  }, REALTIME_LIMITS.pingMs);
  (pingTimer as { unref?: () => void }).unref?.();

  class ChannelImpl implements RealtimeChannel {
    private listeners = new Map<string, Set<(data: unknown, meta: MessageMeta) => void>>();
    private presenceEvents = emitter<[PresenceChange]>();
    private memberMap = new Map<string, RealtimeMember>();
    private subscribed: Promise<void> | null = null;
    private active = true;

    constructor(readonly name: string) {}

    ready(): Promise<void> {
      return this.subscribed!;
    }

    resubscribe() {
      if (!this.active) return;
      const attempt = new Promise<void>((resolve, reject) => {
        const go = () =>
          request({ type: "subscribe", channel: this.name }).then((frame) => {
            if (frame.type === "subscribed" && frame.members) this.memberMap = new Map(frame.members.map((m) => [m.uid, m]));
            resolve();
          }, reject);
        if (ready) go();
        else {
          const off = stateEvents.add((s) => {
            if (s === "open") {
              off();
              go();
            } else if (s === "closed") {
              off();
              reject(new RealtimeError("mybase realtime: connection closed", "closed"));
            }
          });
        }
      });
      attempt.catch((err: RealtimeError) => {
        if (err.code !== "closed" && err.code !== "timeout") errorEvents.emit(err);
      });
      this.subscribed = attempt;
    }

    /** Subscribes again once the next connection is ready. */
    disconnected() {
      this.resubscribe();
    }

    message(frame: Extract<ServerFrame, { type: "message" }>) {
      const meta: MessageMeta = { channel: frame.channel, event: frame.event, uid: frame.uid, id: frame.id, at: frame.at };
      for (const key of [frame.event, "*"]) for (const l of this.listeners.get(key) ?? []) l(frame.data, meta);
    }

    presence(action: "join" | "leave", member: RealtimeMember) {
      if (action === "join") this.memberMap.set(member.uid, member);
      else this.memberMap.delete(member.uid);
      this.presenceEvents.emit({ action, member });
    }

    on<T = unknown>(event: string, listener: (data: T, meta: MessageMeta) => void): () => void {
      let set = this.listeners.get(event);
      if (!set) this.listeners.set(event, (set = new Set()));
      const l = listener as (data: unknown, meta: MessageMeta) => void;
      set.add(l);
      return () => void set.delete(l);
    }

    async publish(event: string, data?: unknown): Promise<void> {
      if (!this.active) throw new RealtimeError("mybase realtime: unsubscribed channel", "unsubscribed", this.name);
      if (!ready) await new Promise<void>((resolve, reject) => {
        const off = stateEvents.add((s) => {
          if (s === "open") (off(), resolve());
          else if (s === "closed") (off(), reject(new RealtimeError("mybase realtime: connection closed", "closed")));
        });
      });
      await request({ type: "publish", channel: this.name, event, data });
    }

    members(): RealtimeMember[] {
      return [...this.memberMap.values()];
    }

    onPresence(listener: (change: PresenceChange) => void): () => void {
      return this.presenceEvents.add(listener);
    }

    unsubscribe() {
      this.active = false;
      channels.delete(this.name);
      if (ready) send({ type: "unsubscribe", channel: this.name });
    }
  }

  connect();

  return {
    get state() {
      return state;
    },
    get userId() {
      return userId;
    },
    channel(name) {
      if (!CHANNEL_PATTERN.test(name)) throw new RealtimeError(`mybase realtime: bad channel name ${JSON.stringify(name)}`, "bad_channel", name);
      let ch = channels.get(name);
      if (!ch) {
        ch = new ChannelImpl(name);
        channels.set(name, ch);
        ch.resubscribe();
      }
      return ch;
    },
    on(event: "state" | "error", listener: (arg: never) => void) {
      return event === "state" ? stateEvents.add(listener as Listener<[ConnectionState]>) : errorEvents.add(listener as Listener<[RealtimeError]>);
    },
    close() {
      closedByUser = true;
      clearInterval(pingTimer);
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      ws?.close(1000, "closed by client");
      ws = null;
      failPending(new RealtimeError("mybase realtime: connection closed", "closed"));
      setState("closed");
    },
  } as RealtimeConnection;
}

// ---- server: publish over HTTP, webhooks -----------------------------------------

export interface PublishMessage {
  channel: string;
  event: string;
  data?: unknown;
}

export interface ChannelInfo {
  channel: string;
  subscribers: number;
  /** Presence channels only. */
  members?: number;
}

export interface RealtimeClientOptions {
  apiUrl: string;
  project: string;
  /** A mybase API key with `realtime:write` (publish) or `realtime:read` (channels, members). Server-side only. */
  apiKey: string;
  fetch?: typeof fetch;
}

export interface RealtimeClient {
  /** Sends to every socket subscribed to `channel`. Returns the message id. */
  publish(channel: string, event: string, data?: unknown): Promise<string>;
  /** Up to 100 messages (64 KB) in one request. */
  publishBatch(messages: PublishMessage[]): Promise<string[]>;
  /** Channels with at least one subscriber. */
  channels(options?: { prefix?: string }): Promise<ChannelInfo[]>;
  /** Who's in a presence channel. */
  members(channel: string): Promise<RealtimeMember[]>;
}

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/realtime/${encodeURIComponent(options.project)}`;
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await doFetch(base + path, {
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${options.apiKey}` },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new MybaseApiError(body.error ?? `mybase API answered ${res.status}`, res.status);
    return body;
  };
  return {
    async publish(channel, event, data) {
      const { ids } = await call<{ ids: string[] }>("/publish", { method: "POST", body: JSON.stringify({ channel, event, data }) });
      return ids[0]!;
    },
    async publishBatch(messages) {
      const { ids } = await call<{ ids: string[] }>("/publish", { method: "POST", body: JSON.stringify({ messages }) });
      return ids;
    },
    async channels(opts = {}) {
      const q = opts.prefix ? `?prefix=${encodeURIComponent(opts.prefix)}` : "";
      return (await call<{ channels: ChannelInfo[] }>(`/channels${q}`)).channels;
    },
    async members(channel) {
      return (await call<{ members: RealtimeMember[] }>(`/channels/${encodeURIComponent(channel)}/members`)).members;
    },
  };
}

/** One thing that happened, in a webhook call. */
export type RealtimeWebhookEvent =
  | { type: "message"; channel: string; event: string; data: unknown; uid: string | null; id: string; at: string }
  | { type: "presence"; channel: string; action: "join" | "leave"; member: RealtimeMember; at: string }
  | { type: "channel"; channel: string; action: "occupied" | "vacated"; at: string };

/** The body of a webhook call: up to 100 events, oldest first. */
export interface RealtimeWebhookBody {
  project: string;
  events: RealtimeWebhookEvent[];
}

/** Checks a webhook call's `X-Mybase-Signature` and returns its body. Consumes the body. Throws on a bad signature. */
export async function verifyRealtimeWebhook(req: Request, secret: string | readonly string[], options: { toleranceSec?: number } = {}): Promise<RealtimeWebhookBody> {
  const body = await req.text();
  await verifyCronSignature({ body, signature: req.headers.get(SIGNATURE_HEADER), secret, toleranceSec: options.toleranceSec });
  try {
    const parsed = JSON.parse(body) as RealtimeWebhookBody;
    if (!Array.isArray(parsed?.events)) throw new Error();
    return parsed;
  } catch {
    throw new CronVerificationError("body is not a realtime webhook");
  }
}

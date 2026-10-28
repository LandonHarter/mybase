// Postgres over WebSocket, for apps that can't open raw TCP to this machine (serverless hosts,
// anything behind the Cloudflare Tunnel). Speaks what Neon's serverless driver expects: the
// socket carries the plain Postgres protocol, TLS is the wss:// layer in front.
//
// The target is always our own Postgres, never a client-chosen address, and only project
// roles may log in through it: the startup message is checked before anything reaches Postgres.
import { PROJECT_NAME_PATTERN } from "@mybase/shared";
import { auditOnce } from "./audit";
import type { Logger } from "@mybase/shared/logger";
import type { Server, ServerWebSocket, Socket, WebSocketHandler } from "bun";
import { errorResponse, MAX_STARTUP_BYTES, parseFirstMessage } from "./pg-wire";
import { pgAddress, projectExists } from "./postgres";

const MAX_SOCKETS = Number(process.env.MYBASE_DB_PROXY_MAX ?? 200);
// Bytes waiting for a slow upstream before the client is cut off.
const MAX_QUEUED = 64 * 1024 * 1024;

export interface ProxyData {
  log: Logger;
  ip: string;
  /** Handshake bytes not yet parsed. */
  pending: Uint8Array;
  state: "startup" | "checking" | "open" | "closed";
  project: string | null;
  upstream: Socket<undefined> | null;
  /** Bytes for upstream it hasn't accepted yet (backpressure, or still connecting). */
  queue: Uint8Array[];
  queued: number;
  bytesIn: number;
  bytesOut: number;
  start: number;
}

let open = 0;

/** Upgrades `/db` to a WebSocket. Returns a response only when it can't. */
export function upgradeDb(req: Request, server: Server<ProxyData>, ip: string, log: Logger): Response | undefined {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "connect with a Postgres WebSocket driver, e.g. @neondatabase/serverless" }, { status: 426 });
  }
  if (open >= MAX_SOCKETS) return Response.json({ error: "too many database connections" }, { status: 503 });
  const data: ProxyData = {
    log,
    ip,
    pending: new Uint8Array(0),
    state: "startup",
    project: null,
    upstream: null,
    queue: [],
    queued: 0,
    bytesIn: 0,
    bytesOut: 0,
    start: performance.now(),
  };
  if (server.upgrade(req, { data })) return undefined;
  return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

function reject(ws: ServerWebSocket<ProxyData>, code: string, message: string) {
  ws.data.log.warn("db connection rejected", { ip: ws.data.ip, project: ws.data.project ?? undefined, reason: message });
  // Outside any request (WebSocket messages), so the IP is passed along; once a minute per IP.
  auditOnce(`dbproxy.rejected:${ws.data.ip}`, 60_000, { action: "dbproxy.rejected", outcome: "denied", ip: ws.data.ip, project: ws.data.project ?? null, meta: { reason: code } });
  ws.send(errorResponse(code, message));
  ws.close(1008, "rejected");
}

/** Writes what upstream will take now and queues the rest until `drain`. */
function flush(data: ProxyData) {
  const upstream = data.upstream;
  if (!upstream) return;
  while (data.queue.length) {
    const chunk = data.queue[0]!;
    const written = upstream.write(chunk);
    data.bytesIn += Math.max(written, 0);
    if (written < chunk.length) {
      data.queue[0] = chunk.subarray(Math.max(written, 0));
      data.queued -= Math.max(written, 0);
      return;
    }
    data.queue.shift();
    data.queued -= chunk.length;
  }
}

function enqueue(ws: ServerWebSocket<ProxyData>, chunk: Uint8Array) {
  const data = ws.data;
  data.queue.push(chunk);
  data.queued += chunk.length;
  if (data.queued > MAX_QUEUED) {
    data.log.warn("db connection closed: client sending faster than postgres reads", { project: data.project ?? undefined });
    ws.close(1013, "backpressure");
    return;
  }
  flush(data);
}

async function connectUpstream(ws: ServerWebSocket<ProxyData>, project: string, startup: Uint8Array) {
  const data = ws.data;
  data.state = "checking";
  data.project = project;
  if (!(await projectExists(project))) return reject(ws, "28000", `project "${project}" not found`);
  // The client may have gone away while the check ran.
  if (data.state !== "checking") return;
  // The startup message goes first, then whatever arrived meanwhile.
  data.queue.unshift(startup);
  data.queued += startup.length;
  try {
    data.upstream = await Bun.connect({
      hostname: pgAddress.host,
      port: pgAddress.port,
      socket: {
        data(_socket, chunk) {
          data.bytesOut += chunk.length;
          ws.send(chunk);
        },
        drain() {
          flush(data);
        },
        close() {
          ws.close(1000, "postgres closed the connection");
        },
        error(_socket, err) {
          data.log.warn("db upstream error", { project, err: err.message });
          ws.close(1011, "postgres connection error");
        },
      },
    });
  } catch (err) {
    data.log.error("db upstream connect failed", { project, err });
    return reject(ws, "08006", "can't reach postgres");
  }
  if (ws.data.state === "closed") {
    data.upstream.end();
    return;
  }
  data.state = "open";
  data.log.info("db connection opened", { project, ip: data.ip });
  flush(data);
}

/** Handles the handshake: answers encryption requests with `N`, then checks the startup message. */
function handshake(ws: ServerWebSocket<ProxyData>) {
  const data = ws.data;
  for (;;) {
    const msg = parseFirstMessage(data.pending);
    if (msg.kind === "partial") {
      if (data.pending.length > MAX_STARTUP_BYTES) reject(ws, "08P01", "startup message too long");
      return;
    }
    if (msg.kind === "invalid") return reject(ws, "08P01", msg.reason);
    if (msg.kind === "encryption") {
      // TLS is the wss:// layer; inside it the driver must use `ssl: false`.
      ws.send("N");
      data.pending = data.pending.subarray(msg.length);
      continue;
    }
    const user = msg.params.get("user") ?? "";
    const database = msg.params.get("database") ?? user;
    if (!PROJECT_NAME_PATTERN.test(user) || database !== user) {
      return reject(ws, "28000", "only project roles can connect here, to their own database");
    }
    const startup = data.pending.slice(0, msg.length);
    const rest = data.pending.subarray(msg.length);
    data.pending = new Uint8Array(0);
    if (rest.length) {
      data.queue.push(rest.slice());
      data.queued += rest.length;
    }
    void connectUpstream(ws, user, startup).catch((err) => {
      data.log.error("db proxy failed", { project: user, err });
      ws.close(1011, "internal error");
    });
    return;
  }
}

export const dbProxyWebsocket: WebSocketHandler<ProxyData> = {
  // Pooled connections sit idle for a while; pings keep the socket itself alive.
  idleTimeout: 960,
  maxPayloadLength: 16 * 1024 * 1024,
  open() {
    open++;
  },
  message(ws, message) {
    const chunk = typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
    const data = ws.data;
    if (data.state === "startup") {
      data.pending = concat(data.pending, chunk);
      handshake(ws);
    } else if (data.state !== "closed") {
      enqueue(ws, chunk);
    }
  },
  close(ws) {
    open--;
    const data = ws.data;
    const wasOpen = data.state === "open";
    data.state = "closed";
    data.upstream?.end();
    if (wasOpen) {
      data.log.info("db connection closed", {
        project: data.project ?? undefined,
        bytesIn: data.bytesIn,
        bytesOut: data.bytesOut,
        ms: Math.round(performance.now() - data.start),
      });
    }
  },
};

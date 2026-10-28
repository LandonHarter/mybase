// Bun.serve takes one WebSocket handler for the whole server; each socket's `data.kind` says
// which feature it belongs to: `db` (Postgres over WebSocket, db-proxy.ts) or `realtime`
// (pub/sub channels, realtime.ts).
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { dbProxyWebsocket, type ProxyData } from "./db-proxy";
import { realtimeWebsocket, type RealtimeData } from "./realtime";

export type SocketData = ProxyData | RealtimeData;

type AnyHandler = WebSocketHandler<SocketData>;
const handlerFor = (ws: ServerWebSocket<SocketData>) => (ws.data.kind === "realtime" ? realtimeWebsocket : dbProxyWebsocket) as unknown as AnyHandler;

export const websocket: AnyHandler = {
  // Pooled database connections sit idle for a while; realtime clients ping every 25 s and
  // realtime.ts drops silent ones itself.
  idleTimeout: 960,
  maxPayloadLength: 16 * 1024 * 1024,
  open: (ws) => handlerFor(ws).open?.(ws),
  message: (ws, message) => handlerFor(ws).message?.(ws, message),
  close: (ws, code, reason) => handlerFor(ws).close?.(ws, code, reason),
  drain: (ws) => handlerFor(ws).drain?.(ws),
};

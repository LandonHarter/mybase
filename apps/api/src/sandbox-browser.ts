// Authenticated CDP transport. No debug port is published. Credentials never enter URLs.
import type { BunRequest, Server, WebSocketHandler } from "bun";
import { consumeBrowserLease, workerBrowserUrl } from "./sandbox";
import type { SocketData } from "./websocket";
export interface SandboxSocketData { kind: "sandbox"; upstream: WebSocket; timer?: ReturnType<typeof setTimeout> }
export async function upgradeSandboxBrowser(req: BunRequest, server: Server<SocketData>, project: string, id: string) {
  await consumeBrowserLease(project, id, req.headers.get("X-Mybase-Browser-Token"));
  const target = workerBrowserUrl(id, project);
  // Bun's header extension is missing from the DOM constructor type used by this workspace.
  const WithHeaders = WebSocket as unknown as new (url: string, options: { headers: Record<string,string> }) => WebSocket;
  const upstream = new WithHeaders(target.url, { headers: target.headers });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { upstream.close(); reject(new Error("browser connection timed out")); }, 5000);
    upstream.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    upstream.addEventListener("error", () => { clearTimeout(timer); reject(new Error("browser connection failed")); }, { once: true });
  });
  if (server.upgrade(req, { data: { kind: "sandbox", upstream } })) return;
  upstream.close(); return new Response(null, { status: 400 });
}
export const sandboxWebsocket: WebSocketHandler<SandboxSocketData> = {
  open(ws) {
    ws.data.timer = setTimeout(() => ws.close(1000,"browser lease expired"),60_000);
    ws.data.upstream.addEventListener("message", e => { if (typeof e.data !== "string" || e.data.length > 1024*1024 || ws.send(e.data) === -1) ws.close(1009); });
    ws.data.upstream.addEventListener("close", () => ws.close());
    ws.data.upstream.addEventListener("error", () => ws.close(1011));
  },
  message(ws, message) { if (message.length > 1024*1024 || ws.data.upstream.bufferedAmount > 1024*1024) ws.close(1009); else ws.data.upstream.send(message); },
  close(ws) { clearTimeout(ws.data.timer); ws.data.upstream.close(); },
};

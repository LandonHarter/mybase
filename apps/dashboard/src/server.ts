// Dev server: Bun bundles the HTML import on the fly, and every other request is
// proxied to the API so the dashboard can call it same-origin, as in Docker.
// WebSockets (`/db`, Postgres for apps) are relayed too, so a dev tunnel can point here.
import { DEFAULT_API_URL } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import index from "./index.html";

const log = createLogger("dashboard");
const apiUrl = process.env.MYBASE_API_URL ?? DEFAULT_API_URL;

interface Relay {
  upstream: WebSocket;
  /** Client messages sent before the API side finished connecting. */
  pending: (string | Buffer)[];
}

const server = Bun.serve<Relay>({
  port: Number(process.env.DASHBOARD_PORT ?? 4001),
  routes: { "/": index },
  development: true,
  // Match the API's upload limit, since uploads pass through here in dev.
  maxRequestBodySize: Number(process.env.MYBASE_MAX_UPLOAD ?? 1024 ** 3),
  async fetch(req, server) {
    const { pathname, search } = new URL(req.url);
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const upstream = new WebSocket(`${apiUrl.replace(/^http/, "ws")}${pathname}${search}`);
      upstream.binaryType = "arraybuffer";
      if (server.upgrade(req, { data: { upstream, pending: [] } })) return;
      upstream.close();
      return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
    }
    try {
      return await fetch(`${apiUrl}${pathname}${search}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    } catch (err) {
      log.warn("api unreachable", { path: pathname, err: (err as Error).message });
      return Response.json({ error: "Can't reach the API. Check that it's running, then try again." }, { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      const { upstream } = ws.data;
      upstream.onopen = () => {
        for (const message of ws.data.pending) upstream.send(message);
        ws.data.pending = [];
      };
      upstream.onmessage = (e) => ws.send(e.data as ArrayBuffer | string);
      // Pass the API's close code on (realtime clients act on 4001–4008); 1005/1006 can't be sent.
      upstream.onclose = (e) => (e.code === 1000 || (e.code >= 3000 && e.code < 5000) || e.code === 1001 || e.code === 1011 || e.code === 1013 ? ws.close(e.code, e.reason) : ws.close());
      upstream.onerror = () => {
        log.warn("api websocket failed", { api: apiUrl });
        ws.close(1011, "api unreachable");
      };
    },
    message(ws, message) {
      const { upstream, pending } = ws.data;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else pending.push(message);
    },
    close(ws) {
      ws.data.upstream.close();
    },
  },
});

log.info("listening", { url: server.url.href, api: apiUrl });

// Dev server: Bun bundles the HTML import on the fly, and every other request is
// proxied to the API so the dashboard can call it same-origin, as in Docker.
import { DEFAULT_API_URL } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import index from "./index.html";

const log = createLogger("dashboard");
const apiUrl = process.env.MYBASE_API_URL ?? DEFAULT_API_URL;

const server = Bun.serve({
  port: Number(process.env.DASHBOARD_PORT ?? 4001),
  routes: { "/": index },
  development: true,
  async fetch(req) {
    const { pathname, search } = new URL(req.url);
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
});

log.info("listening", { url: server.url.href, api: apiUrl });

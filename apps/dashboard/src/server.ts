// Framework is TBD; for now Bun serves and bundles a plain HTML + TS page.
import { DEFAULT_API_URL } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import index from "./index.html";

const log = createLogger("dashboard");

const server = Bun.serve({
  port: Number(process.env.DASHBOARD_PORT ?? 4001),
  routes: { "/": index },
  development: true,
});

log.info("listening", { url: server.url.href, api: DEFAULT_API_URL });

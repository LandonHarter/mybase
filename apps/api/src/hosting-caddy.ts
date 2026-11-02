// Caddy routes requests for <site>.<domain> to the site's live container. mybase owns Caddy's
// whole config: it's rebuilt from the database and loaded in one `POST /load`, so a lost or
// stale config is fixed by the next push. Caddy's admin API is a unix socket on a volume only
// the API shares, because Caddy sits on every project network.
import { createHash } from "node:crypto";
import type { Logger } from "@mybase/shared/logger";

export interface CaddyRoute {
  /** Hostnames that reach this site. */
  hosts: string[];
  /** `container:port`. */
  dial: string;
}

// Where Caddy's admin API is, from the API's side, and what Caddy should listen on for it. Dev
// (API on the host) uses http://127.0.0.1:2019 and :2019.
const adminUrl = process.env.MYBASE_CADDY_ADMIN ?? "unix:/run/caddy/admin.sock";
const adminListen = process.env.MYBASE_CADDY_ADMIN_LISTEN ?? "unix//run/caddy/admin.sock|0666";

// cloudflared (and LAN proxies) are on private addresses; their X-Forwarded-* headers are kept.
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "fc00::/7", "::1/128"];

/** The whole Caddy config. Pure, for tests. */
export function caddyConfig(routes: CaddyRoute[]) {
  return {
    admin: { listen: adminListen },
    apps: {
      http: {
        servers: {
          sites: {
            listen: [":80"],
            // TLS ends at Cloudflare (or there is none, on a LAN).
            automatic_https: { disable: true },
            trusted_proxies: { source: "static", ranges: PRIVATE_RANGES },
            routes: [
              ...routes.map((r) => ({
                match: [{ host: r.hosts }],
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: r.dial }] }],
                terminal: true,
              })),
              {
                handle: [{ handler: "static_response", status_code: 404, headers: { "Content-Type": ["text/plain; charset=utf-8"] }, body: "No site is deployed at this address.\n" }],
              },
            ],
          },
        },
      },
    },
  };
}

let lastPushed: string | null = null;
let pushing: Promise<void> = Promise.resolve();

/** Loads the config unless it's the one Caddy already has. Serialized; `force` re-sends it. */
export function pushCaddy(routes: CaddyRoute[], log: Logger, force = false): Promise<void> {
  const next = pushing.then(async () => {
    const body = JSON.stringify(caddyConfig(routes));
    const hash = createHash("sha256").update(body).digest("hex");
    if (!force && hash === lastPushed) return;
    const unix = adminUrl.startsWith("unix:") ? adminUrl.slice(5) : undefined;
    const res = await fetch(unix ? "http://localhost/load" : `${adminUrl.replace(/\/$/, "")}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      unix,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`caddy rejected the config (${res.status}): ${(await res.text()).slice(0, 300)}`);
    lastPushed = hash;
    log.info("caddy config loaded", { sites: routes.length });
  });
  // A failed push doesn't block the next one.
  pushing = next.catch(() => {
    lastPushed = null;
  });
  return next;
}

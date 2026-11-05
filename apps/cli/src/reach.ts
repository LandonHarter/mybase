// Which way this machine reaches the server's services, for linked secrets (`secrets link
// --database` …). The server resolves links; this only says what's reachable from here: it asks
// for the candidate routes (`?describe=1`, no values), tries a TCP connect to each, and sends the
// winners back as hints (`?routes=database:lan,cache:none`). Nothing reachable for the database
// means the local proxy over the API's WebSocket (`mybase db proxy`).
import type { LinkService, SecretsDescribeResponse, ServiceRoute } from "@mybase/shared";
import { networkInterfaces } from "node:os";
import { api, API_URL } from "./api";

type Hint = ServiceRoute["route"] | "none";

/** Order tried from a client machine (internal names only work on the hosting network). */
const ORDER: ServiceRoute["route"][] = ["localhost", "lan", "tailscale", "public"];

/** Whether this CLI runs on the server itself: its API URL points at this machine. */
export function onServerHost(apiUrl = API_URL, interfaces = networkInterfaces()): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (/^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host)) return true;
  return Object.values(interfaces).some((list) => list?.some((i) => i.address === host));
}

/** Whether a TCP connection to host:port opens within `ms`. */
export async function canConnect(host: string, port: number, ms = 1200): Promise<boolean> {
  let socket: { end(): void } | null = null;
  const attempt = Bun.connect({ hostname: host, port, socket: { data() {}, error() {} } }).then(
    (s) => {
      socket = s;
      return true;
    },
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms));
  const ok = await Promise.race([attempt, timeout]);
  // A connect that lands after the timeout is closed too.
  void attempt.then(() => (socket as { end(): void } | null)?.end());
  return ok;
}

/**
 * The first route in ORDER that answers. Localhost only counts on the server itself (a laptop's
 * own Postgres on 5432 must not win). The database falls back to the proxy, others to `none`.
 */
export async function pickHint(service: LinkService, routes: ServiceRoute[], serverHost: boolean, connect = canConnect): Promise<Hint> {
  const candidates = ORDER.map((name) => routes.find((r) => r.route === name)).filter(
    (r): r is ServiceRoute => r !== undefined && r.on && Boolean(r.host) && (r.route !== "localhost" || serverHost),
  );
  const results = await Promise.all(candidates.map((r) => connect(r.host, r.port)));
  const winner = candidates.find((_, i) => results[i]);
  if (winner) return winner.route;
  return service === "database" ? "proxy" : "none";
}

export interface ReachPlan {
  /** `routes=…` for the secrets request; empty when the env has no links (or an old server). */
  hints: Partial<Record<LinkService, Hint>>;
  /** A database link resolves through the local proxy. */
  needsProxy: boolean;
}

/** Probes the routes an env's links need. Never throws: without hints the server picks. */
export async function planReach(project: string, env: string): Promise<ReachPlan> {
  let desc: SecretsDescribeResponse;
  try {
    desc = await api<SecretsDescribeResponse>(`/secrets/${encodeURIComponent(project)}/${encodeURIComponent(env)}?describe=1`);
  } catch {
    return { hints: {}, needsProxy: false };
  }
  // An older server ignores `describe` and answers with values: no links to plan for.
  if (!desc || typeof desc !== "object" || !("routes" in desc)) return { hints: {}, needsProxy: false };
  const refs = Object.values(desc.links);
  const serverHost = onServerHost();
  const hints: ReachPlan["hints"] = {};
  await Promise.all(
    (Object.keys(desc.routes) as LinkService[]).map(async (service) => {
      // Only keys left on `auto` follow the probe; explicit routes are the env's choice.
      if (!refs.some((r) => r.service === service && r.route === "auto")) return;
      hints[service] = await pickHint(service, desc.routes[service] ?? [], serverHost);
    }),
  );
  const needsProxy = hints.database === "proxy" || refs.some((r) => r.service === "database" && r.route === "proxy");
  return { hints, needsProxy };
}

/** Query string for `GET /secrets/:project/:env`. */
export function reachQuery(plan: ReachPlan, proxyPort: number | null): string {
  const q = new URLSearchParams();
  const routes = Object.entries(plan.hints).map(([s, r]) => `${s}:${r}`);
  if (routes.length) q.set("routes", routes.join(","));
  if (proxyPort) q.set("proxy", String(proxyPort));
  const s = q.toString();
  return s ? `?${s}` : "";
}

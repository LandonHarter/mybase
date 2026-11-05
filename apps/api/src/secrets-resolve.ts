// Linked secrets (`mybase secrets link --database` …): a linked key stores a reference to one of
// the project's own services, and its value is built here whenever the env is read, for whoever
// reads it. A hosted site gets the hosting network's Docker names; `mybase run` gets the best
// address its machine can reach (it probes first and sends hints); other readers (the SDK, old
// CLIs) get the server's default (public, then LAN, Tailscale, localhost).
//
// Pure: the env, db-public status, and credentials come in as arguments, so it's all testable.
import type { LinkField, LinkRef, LinkRoute, LinkService, LinkSslMode, ServiceRoute } from "@mybase/shared";
import { LINK_KEYS, LINK_ROUTES, LINK_SERVICES, LINK_SSLMODES } from "@mybase-dev/sdk/secrets";

export type ConcreteRoute = Exclude<LinkRoute, "auto">;

/** The project's own credentials, stored once per project (encrypted) and shared by every link. */
export interface LinkCredentials {
  database?: { password: string };
  storage?: { accessKeyId: string; secretAccessKey: string };
  cache?: { password: string };
  apiKey?: string;
}

/** What the server knows about reaching it, besides the env. */
export interface TopologyState {
  dbPublic: { enabled: boolean; tlsActive: boolean; host: string; port: number };
  hostingOn: boolean;
  /** `wss://…/db`, for the proxy route's note. */
  wsUrl: string;
}

export type Topology = Record<LinkService, ServiceRoute[]>;

/** Who's reading the env. */
export type ResolveContext =
  | { kind: "hosting" }
  | {
      kind: "client";
      /** What the reader found reachable, per service (`none`: nothing). Absent: server default. */
      hints: Partial<Record<LinkService, ConcreteRoute | "none">>;
      /** Port of the reader's `mybase db proxy`, for the proxy route. */
      proxyPort: number | null;
    };

export class LinkError extends Error {}

const loopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(host);

/** Tailscale MagicDNS names and the CGNAT range Tailscale hands out (100.64.0.0/10). */
export function isTailscale(host: string): boolean {
  if (/\.ts\.net\.?$/i.test(host)) return true;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

const portOf = (url: URL) => Number(url.port || (url.protocol === "https:" ? 443 : 80));

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Every route to every linkable service. `lan`/`tailscale` come from MYBASE_LAN_HOST (setup's
 * address for other machines; a Tailscale name counts as tailscale) and MYBASE_TAILSCALE_HOST;
 * they're off when the port is bound to loopback only.
 */
export function topology(env: Record<string, string | undefined>, state: TopologyState): Topology {
  const lanRaw = env.MYBASE_LAN_HOST?.trim() || null;
  const lanHost = lanRaw && !loopback(lanRaw) && !isTailscale(lanRaw) ? lanRaw : null;
  const tsHost = env.MYBASE_TAILSCALE_HOST?.trim() || (lanRaw && isTailscale(lanRaw) ? lanRaw : null);

  const hostRoutes = (port: number, bind: string | undefined, scheme?: string): ServiceRoute[] => {
    const exposed = !bind || !loopback(bind);
    const url = (host: string) => (scheme ? `${scheme}://${host}:${port}` : undefined);
    const offNote = "bound to 127.0.0.1 on the server";
    return [
      { route: "localhost", on: true, host: "127.0.0.1", port, url: url("localhost"), note: "on the server machine only" },
      lanHost
        ? { route: "lan", on: exposed, host: lanHost, port, url: url(lanHost), ...(exposed ? {} : { note: offNote }) }
        : { route: "lan", on: false, host: "", port, note: "no LAN address set (MYBASE_PUBLIC_HOST, `mybase server setup`)" },
      tsHost
        ? { route: "tailscale", on: exposed, host: tsHost, port, url: url(tsHost), ...(exposed ? {} : { note: offNote }) }
        : { route: "tailscale", on: false, host: "", port, note: "no Tailscale address set (MYBASE_TAILSCALE_HOST)" },
    ];
  };
  const internalNote = state.hostingOn ? "hosted sites (project network)" : "hosting isn't set up on this server";

  // Database
  const pgHost = env.POSTGRES_HOST ?? "localhost";
  const pgPort = Number(env.POSTGRES_PORT ?? 5432);
  const dbHostPort = Number(env.MYBASE_DB_PUBLIC_PORT ?? 5432);
  const pub = state.dbPublic;
  const database: ServiceRoute[] = [
    { route: "internal", on: state.hostingOn, host: pgHost, port: pgPort, note: internalNote },
    ...hostRoutes(dbHostPort, env.MYBASE_DB_HOST_BIND),
    pub.enabled && pub.tlsActive
      ? { route: "public", on: true, host: pub.host, port: pub.port, note: "TLS (Let's Encrypt); the owner role is exposed to the internet" }
      : { route: "public", on: false, host: pub.enabled ? pub.host : "", port: pub.port, note: pub.enabled ? "waiting for the certificate" : "off (`mybase database access <project> --public on`)" },
    { route: "proxy", on: true, host: "127.0.0.1", port: 0, note: `mybase db proxy, over ${state.wsUrl}` },
  ];

  // Cache
  const cache: ServiceRoute[] = [
    { route: "internal", on: state.hostingOn, host: env.VALKEY_HOST ?? "localhost", port: Number(env.VALKEY_PORT ?? 6379), note: internalNote },
    ...hostRoutes(Number(env.MYBASE_CACHE_PUBLIC_PORT ?? env.VALKEY_PORT ?? 6379), env.MYBASE_CACHE_HOST_BIND),
    { route: "public", on: false, host: "", port: 0, note: "the cache isn't offered on the internet (use the HTTP API)" },
  ];

  // Storage (S3) and the API: HTTP, public when their public URL is https (the tunnel).
  const httpService = (internal: URL, hostPort: number, bind: string | undefined, publicUrl: URL | null): ServiceRoute[] => [
    { route: "internal", on: state.hostingOn, host: internal.hostname, port: portOf(internal), url: internal.origin, note: internalNote },
    ...hostRoutes(hostPort, bind, "http"),
    publicUrl && publicUrl.protocol === "https:"
      ? { route: "public", on: true, host: publicUrl.hostname, port: portOf(publicUrl), url: publicUrl.origin }
      : { route: "public", on: false, host: "", port: 0, note: "no https public URL (Cloudflare Tunnel)" },
  ];
  const s3Internal = parseUrl(env.GARAGE_S3_URL) ?? new URL("http://localhost:3900");
  const storage = httpService(s3Internal, Number(env.MYBASE_S3_HOST_PORT ?? s3Internal.port ?? 3900), env.MYBASE_S3_HOST_BIND, parseUrl(env.MYBASE_S3_PUBLIC_URL));
  const apiInternal = new URL(`http://${env.MYBASE_INTERNAL_HOST ?? "mybase"}:${env.API_PORT ?? 4000}`);
  const publicApi = parseUrl(env.MYBASE_PUBLIC_URL);
  const api = httpService(apiInternal, Number(env.MYBASE_HOST_PORT ?? env.API_PORT ?? 4000), env.MYBASE_HOST_BIND, publicApi);
  // The API URL is used as-is, path included (behind a reverse proxy it may have one).
  const apiPublic = api.find((r) => r.route === "public");
  if (apiPublic?.on && publicApi) apiPublic.url = env.MYBASE_PUBLIC_URL!.replace(/\/$/, "");

  return { database, cache, storage, api };
}

/** Readers without hints (SDK, older CLIs) get the first of these that's on. */
const SERVER_DEFAULT: ConcreteRoute[] = ["public", "lan", "tailscale", "localhost"];

const accessHint = (project: string) => `see \`mybase database access ${project}\``;

/** The route a link resolves to for this reader, or a LinkError saying why there's none. */
export function pickRoute(project: string, ref: LinkRef, topo: Topology, ctx: ResolveContext): ServiceRoute {
  const routes = topo[ref.service];
  const find = (route: ConcreteRoute) => routes.find((r) => r.route === route);
  let want: ConcreteRoute | null;
  if (ctx.kind === "hosting") {
    // A site is on the project network: internal unless the env asks for something else.
    want = ref.route === "auto" || ref.route === "proxy" ? "internal" : ref.route;
    const r = find(want);
    // Sites reach the internal names even before `hostingOn` is known to this process.
    if (want === "internal" && r) return { ...r, on: true };
  } else if (ref.route !== "auto") {
    want = ref.route;
  } else {
    const hint = ctx.hints[ref.service];
    if (hint === "none") {
      throw new LinkError(`can't reach ${ref.service} from this machine on any route (${accessHint(project)})`);
    }
    want = hint ?? SERVER_DEFAULT.find((route) => find(route)?.on) ?? null;
    if (!want) throw new LinkError(`${ref.service} has no address reachable outside the server (${accessHint(project)})`);
  }
  const route = find(want);
  if (!route) throw new LinkError(`${ref.service} can't be reached by route "${want}"`);
  if (want === "proxy") {
    if (ctx.kind !== "client" || !ctx.proxyPort) {
      throw new LinkError(`${ref.service} is linked through the local proxy: read it with \`mybase run\` (which starts \`mybase db proxy\`)`);
    }
    return { ...route, port: ctx.proxyPort };
  }
  if (!route.on) throw new LinkError(`${ref.service} route "${want}" is off: ${route.note ?? "not available"} (${accessHint(project)})`);
  return route;
}

/** TLS for a Postgres URL: the public route has a real certificate, the others don't. */
export const defaultSslmode = (route: ConcreteRoute): LinkSslMode => (route === "public" ? "require" : "disable");

const query = (params: Record<string, string>) => {
  const q = new URLSearchParams(params).toString();
  return q ? `?${q}` : "";
};

const missing = (what: string) => new LinkError(`mybase doesn't hold the ${what} yet: run \`mybase secrets link\` for it again`);

/** The value of a linked key for this reader. Never logs; errors never contain secrets. */
export function resolveRef(
  project: string,
  ref: LinkRef,
  creds: LinkCredentials,
  topo: Topology,
  ctx: ResolveContext,
  storage: { bucket: string; region: string },
): { value: string; route: ConcreteRoute } {
  // Fields that don't depend on the route.
  if (ref.service === "storage" && (ref.field === "region" || ref.field === "bucket")) {
    return { value: storage[ref.field], route: ctx.kind === "hosting" ? "internal" : "public" };
  }
  if (ref.service === "storage" && (ref.field === "accessKeyId" || ref.field === "secretAccessKey")) {
    if (!creds.storage) throw missing("storage key");
    return { value: creds.storage[ref.field], route: ctx.kind === "hosting" ? "internal" : "public" };
  }
  if (ref.service === "api" && ref.field === "key") {
    if (!creds.apiKey) throw missing("API key");
    return { value: creds.apiKey, route: ctx.kind === "hosting" ? "internal" : "public" };
  }
  const r = pickRoute(project, ref, topo, ctx);
  const enc = encodeURIComponent;
  switch (ref.service) {
    case "database": {
      if (!creds.database) throw missing("database password");
      const sslmode = ref.sslmode ?? defaultSslmode(r.route);
      const q = query({ sslmode, ...ref.params });
      return { value: `postgres://${enc(project)}:${enc(creds.database.password)}@${hostPart(r.host)}:${r.port}/${enc(project)}${q}`, route: r.route };
    }
    case "cache": {
      if (!creds.cache) throw missing("cache password");
      return { value: `redis://${enc(project)}:${enc(creds.cache.password)}@${hostPart(r.host)}:${r.port}${query(ref.params ?? {})}`, route: r.route };
    }
    case "storage":
    case "api":
      return { value: r.url ?? `http://${hostPart(r.host)}:${r.port}`, route: r.route };
  }
}

/** IPv6 literals need brackets in a URL. */
const hostPart = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** `postgres://user:secret@host` → `postgres://user:***@host`, for anything shown or logged. */
export function maskSecrets(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, "$1***@");
}

// ---- reading requests ---------------------------------------------------------

/** The keys a service link writes, with their fields. `as` renames a single-key link. */
export function linkKeys(service: LinkService, as: string | undefined, api: { includeKey: boolean }): [string, LinkField][] {
  const entries = Object.entries(LINK_KEYS[service]) as [LinkField, string][];
  const fields = service === "api" && !api.includeKey ? entries.filter(([f]) => f !== "key") : entries;
  if (as !== undefined) {
    if (fields.length !== 1) throw new LinkError(`--as works for one key; ${service} links ${fields.map(([, k]) => k).join(", ")}`);
    return [[as, fields[0]![0]]];
  }
  return fields.map(([f, k]) => [k, f]);
}

export const isLinkService = (v: unknown): v is LinkService => (LINK_SERVICES as readonly unknown[]).includes(v);
export const isLinkRoute = (v: unknown): v is LinkRoute => (LINK_ROUTES as readonly unknown[]).includes(v);
export const isSslMode = (v: unknown): v is LinkSslMode => (LINK_SSLMODES as readonly unknown[]).includes(v);

/** `database:lan,cache:none` → hints. Unknown parts are ignored (newer CLIs). */
export function parseHints(raw: string | null): Partial<Record<LinkService, ConcreteRoute | "none">> {
  const hints: Partial<Record<LinkService, ConcreteRoute | "none">> = {};
  for (const part of (raw ?? "").split(",")) {
    const [service, route] = part.split(":");
    if (isLinkService(service) && (route === "none" || (isLinkRoute(route) && route !== "auto"))) hints[service] = route as ConcreteRoute | "none";
  }
  return hints;
}

/** A stored ref, checked (refs are written by us, but the column is plain JSON). */
export function readRef(raw: unknown): LinkRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<LinkRef>;
  if (!isLinkService(r.service) || typeof r.field !== "string" || !isLinkRoute(r.route)) return null;
  return { service: r.service, field: r.field, route: r.route, ...(isSslMode(r.sslmode) ? { sslmode: r.sslmode } : {}), ...(r.params ? { params: r.params } : {}) };
}

/** `secrets list`: `linked: database (auto)`. */
export const describeRef = (ref: LinkRef) =>
  `linked: ${ref.service}${ref.field !== "url" ? ` ${ref.field}` : ""}${ref.route !== "auto" ? ` (${ref.route})` : ""}`;

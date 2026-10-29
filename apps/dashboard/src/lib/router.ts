import { useSyncExternalStore } from "react";
import { ANALYTICS_RANGES, type AnalyticsRange } from "@mybase/shared";

export const DB_TABS = ["tables", "sql", "extensions", "settings"] as const;
export type DbTab = (typeof DB_TABS)[number];

/** Tabs of the instance-wide Security page. */
export const SECURITY_TABS = ["advisor", "audit", "alerts"] as const;
export type SecurityTab = (typeof SECURITY_TABS)[number];

export const ANALYTICS_TABS = ["overview", "events", "errors", "setup"] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export type SandboxAction = "create" | "execute" | "files" | "export" | "terminate" | "cancel" | "off" | "key";
export const SANDBOX_ACTIONS: SandboxAction[] = ["create", "execute", "files", "export", "terminate", "cancel", "off", "key"];

// Hash routes keep the dashboard a single static page: no server routing needed.
export type Route =
  | { page: "projects"; query: string }
  /** The documentation index: every service and guide. */
  | { page: "docs-home" }
  /** One guide, namespaced by service. `section` scrolls to a heading within it. */
  | { page: "docs"; service: string; slug: string; section: string | null }
  | { page: "project"; name: string }
  /** `table` is `schema.table`, for the Tables tab. */
  | { page: "database"; name: string; tab: DbTab; table: string | null }
  | { page: "storage"; name: string; prefix: string }
  /** `job` opens one job's page; `create` opens the New job dialog. */
  | { page: "cron"; name: string; job: string | null; create: boolean }
  /** `range` applies to every tab but Setup. */
  | { page: "analytics"; name: string; tab: AnalyticsTab; range: AnalyticsRange }
  /** `key` opens one key's page (full key, prefix included); `query` filters the key list. */
  | { page: "cache"; name: string; key: string | null; query: string }
  | { page: "ratelimit"; name: string }
  /** `queue` opens one queue's page. */
  | { page: "queue"; name: string; queue: string | null }
  | { page: "search"; name: string }
  /** `index` opens one index's page. */
  | { page: "vector"; name: string; index: string | null }
  /** `env` picks the environment (default: the first root env). */
  | { page: "secrets"; name: string; env: string | null }
  /** `user` opens one app user; `query` filters the list. */
  | { page: "users"; name: string; user: string | null; query: string }
  | { page: "captcha"; name: string }
  | { page: "realtime"; name: string }
  /** `sandbox` and `execution` select retained results; `action` opens an explicit action dialog. */
  | { page: "sandbox"; name: string; tab: "runs" | "setup"; sandbox: string | null; execution: string | null; query: string; action?: SandboxAction }
  /** `newToken` opens the Create API key dialog. */
  | { page: "settings"; newToken: boolean }
  /** `project` narrows the view to one project; `action` and `outcome` filter the audit log. */
  | { page: "security"; tab: SecurityTab; project: string | null; action?: string | null; outcome?: string | null };

/** Routes that belong to one project: its overview and each service's page. */
export type ProjectRoute = Extract<Route, { name: string }>;

export const isProjectRoute = (route: Route): route is ProjectRoute => "name" in route;

function parse(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(search);
  if (path === "docs") return { page: "docs-home" };
  const doc = /^docs\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (doc) {
    // Keep the original one-segment SDK guide URLs working after namespacing docs.
    const service = doc[2] ? doc[1]! : "sdk";
    const slug = doc[2] ?? doc[1]!;
    return { page: "docs", service: decodeURIComponent(service), slug: decodeURIComponent(slug), section: params.get("s") };
  }
  if (path === "settings") return { page: "settings", newToken: params.has("new-token") };
  const security = /^security(?:\/([a-z]+))?$/.exec(path);
  if (security) {
    const tab = SECURITY_TABS.find((t) => t === security[1]) ?? "advisor";
    return { page: "security", tab, project: params.get("p"), action: params.get("a"), outcome: params.get("o") };
  }
  const project = /^projects\/([^/]+)(?:\/(database|storage|cron|analytics|cache|ratelimit|queue|search|secrets|vector|users|captcha|realtime|sandbox)(?:\/([a-z]+))?)?$/.exec(path);
  if (project) {
    const name = decodeURIComponent(project[1]!);
    if (project[2] === "storage") return { page: "storage", name, prefix: params.get("p") ?? "" };
    if (project[2] === "analytics") {
      const tab = ANALYTICS_TABS.find((t) => t === project[3]) ?? "overview";
      const range = ANALYTICS_RANGES.find((r) => r === params.get("r")) ?? "7d";
      return { page: "analytics", name, tab, range };
    }
    if (project[2] === "cache") return { page: "cache", name, key: params.get("k"), query: params.get("q") ?? "" };
    if (project[2] === "ratelimit") return { page: "ratelimit", name };
    if (project[2] === "search") return { page: "search", name };
    if (project[2] === "vector") return { page: "vector", name, index: params.get("i") };
    if (project[2] === "secrets") return { page: "secrets", name, env: params.get("e") };
    if (project[2] === "users") return { page: "users", name, user: params.get("u"), query: params.get("q") ?? "" };
    if (project[2] === "captcha") return { page: "captcha", name };
    if (project[2] === "realtime") return { page: "realtime", name };
    if (project[2] === "sandbox") return {
      page: "sandbox", name, tab: project[3] === "setup" ? "setup" : "runs",
      sandbox: params.get("s"), execution: params.get("e"), query: params.get("q") ?? "",
      action: SANDBOX_ACTIONS.find((a) => a === params.get("action")),
    };
    if (project[2] === "queue") return { page: "queue", name, queue: params.get("q") };
    if (project[2] === "cron") return { page: "cron", name, job: params.get("j"), create: params.has("new") };
    if (project[2] === "database") {
      const tab = DB_TABS.find((t) => t === project[3]) ?? "tables";
      return { page: "database", name, tab, table: params.get("t") };
    }
    return { page: "project", name };
  }
  return { page: "projects", query: params.get("q") ?? "" };
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}

const withParam = (base: string, key: string, value: string | null) => (value ? `${base}?${key}=${encodeURIComponent(value)}` : base);

export function href(route: Route): string {
  if (route.page === "docs-home") return "#/docs";
  if (route.page === "docs") return withParam(`#/docs/${encodeURIComponent(route.service)}/${encodeURIComponent(route.slug)}`, "s", route.section);
  if (route.page === "settings") return route.newToken ? "#/settings?new-token" : "#/settings";
  if (route.page === "security") {
    const params = new URLSearchParams();
    if (route.project) params.set("p", route.project);
    if (route.action) params.set("a", route.action);
    if (route.outcome) params.set("o", route.outcome);
    const search = params.toString();
    return `#/security/${route.tab}${search ? `?${search}` : ""}`;
  }
  if (route.page === "projects") return withParam("#/projects", "q", route.query);
  const base = `#/projects/${encodeURIComponent(route.name)}`;
  if (route.page === "storage") return withParam(`${base}/storage`, "p", route.prefix);
  if (route.page === "database") return withParam(`${base}/database/${route.tab}`, "t", route.table);
  if (route.page === "analytics") return `${base}/analytics/${route.tab}${route.range === "7d" ? "" : `?r=${route.range}`}`;
  if (route.page === "cache") return route.key !== null ? withParam(`${base}/cache`, "k", route.key) : withParam(`${base}/cache`, "q", route.query);
  if (route.page === "ratelimit") return `${base}/ratelimit`;
  if (route.page === "search") return `${base}/search`;
  if (route.page === "vector") return withParam(`${base}/vector`, "i", route.index);
  if (route.page === "secrets") return withParam(`${base}/secrets`, "e", route.env);
  if (route.page === "users") return route.user !== null ? withParam(`${base}/users`, "u", route.user) : withParam(`${base}/users`, "q", route.query);
  if (route.page === "captcha") return `${base}/captcha`;
  if (route.page === "realtime") return `${base}/realtime`;
  if (route.page === "sandbox") {
    const params = new URLSearchParams();
    if (route.sandbox) params.set("s", route.sandbox);
    if (route.execution) params.set("e", route.execution);
    if (route.query) params.set("q", route.query);
    if (route.action) params.set("action", route.action);
    return `${base}/sandbox/${route.tab}${params.size ? `?${params}` : ""}`;
  }
  if (route.page === "queue") return withParam(`${base}/queue`, "q", route.queue);
  if (route.page === "cron") return route.create ? `${base}/cron?new` : withParam(`${base}/cron`, "j", route.job);
  return base;
}

/** `replace` swaps the current history entry, for state like a filter that shouldn't stack up Back presses. */
export function navigate(route: Route, { replace = false } = {}) {
  if (!replace) {
    window.location.hash = href(route);
    return;
  }
  history.replaceState(null, "", href(route));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

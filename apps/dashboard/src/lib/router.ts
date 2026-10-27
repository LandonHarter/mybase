import { useSyncExternalStore } from "react";
import { ANALYTICS_RANGES, type AnalyticsRange } from "@mybase/shared";

export const DB_TABS = ["tables", "sql", "extensions", "settings"] as const;
export type DbTab = (typeof DB_TABS)[number];

export const ANALYTICS_TABS = ["overview", "events", "errors", "setup"] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

// Hash routes keep the dashboard a single static page: no server routing needed.
export type Route =
  | { page: "projects"; query: string }
  /** Docs are namespaced by service. `section` scrolls to a heading within the guide. */
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
  /** `newToken` opens the Create API token dialog. */
  | { page: "settings"; newToken: boolean };

/** Routes that belong to one project: its overview and each service's page. */
export type ProjectRoute = Extract<Route, { name: string }>;

export const isProjectRoute = (route: Route): route is ProjectRoute => "name" in route;

function parse(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(search);
  if (path === "docs") return { page: "docs", service: "sdk", slug: "getting-started", section: null };
  const doc = /^docs\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (doc) {
    // Keep the original one-segment SDK guide URLs working after namespacing docs.
    const service = doc[2] ? doc[1]! : "sdk";
    const slug = doc[2] ?? doc[1]!;
    return { page: "docs", service: decodeURIComponent(service), slug: decodeURIComponent(slug), section: params.get("s") };
  }
  if (path === "settings") return { page: "settings", newToken: params.has("new-token") };
  const project = /^projects\/([^/]+)(?:\/(database|storage|cron|analytics|cache|ratelimit)(?:\/([a-z]+))?)?$/.exec(path);
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
  if (route.page === "docs") return withParam(`#/docs/${encodeURIComponent(route.service)}/${encodeURIComponent(route.slug)}`, "s", route.section);
  if (route.page === "settings") return route.newToken ? "#/settings?new-token" : "#/settings";
  if (route.page === "projects") return withParam("#/projects", "q", route.query);
  const base = `#/projects/${encodeURIComponent(route.name)}`;
  if (route.page === "storage") return withParam(`${base}/storage`, "p", route.prefix);
  if (route.page === "database") return withParam(`${base}/database/${route.tab}`, "t", route.table);
  if (route.page === "analytics") return `${base}/analytics/${route.tab}${route.range === "7d" ? "" : `?r=${route.range}`}`;
  if (route.page === "cache") return route.key !== null ? withParam(`${base}/cache`, "k", route.key) : withParam(`${base}/cache`, "q", route.query);
  if (route.page === "ratelimit") return `${base}/ratelimit`;
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

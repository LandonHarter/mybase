import { useSyncExternalStore } from "react";

// Hash routes keep the dashboard a single static page: no server routing needed.
export type Route =
  | { page: "projects"; query: string }
  | { page: "project"; name: string; prefix: string }
  | { page: "settings" };

function parse(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(search);
  if (path === "settings") return { page: "settings" };
  const project = /^projects\/([^/]+)$/.exec(path);
  if (project) return { page: "project", name: decodeURIComponent(project[1]!), prefix: params.get("p") ?? "" };
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

export function href(route: Route): string {
  if (route.page === "settings") return "#/settings";
  if (route.page === "project") {
    const base = `#/projects/${encodeURIComponent(route.name)}`;
    return route.prefix ? `${base}?p=${encodeURIComponent(route.prefix)}` : base;
  }
  return route.query ? `#/projects?q=${encodeURIComponent(route.query)}` : "#/projects";
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

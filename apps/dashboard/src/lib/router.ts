import { useSyncExternalStore } from "react";

// Hash routes keep the dashboard a single static page: no server routing needed.
export type Route = { page: "projects"; query: string } | { page: "settings" };

function parse(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  if (path === "settings") return { page: "settings" };
  return { page: "projects", query: new URLSearchParams(search).get("q") ?? "" };
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

import { isProjectRoute, navigate, type Route } from "./router";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Label for the command menu shortcut, matching the user's OS. */
export const SEARCH_SHORTCUT = isMac ? "⌘K" : "Ctrl K";

/** Label for Ctrl/⌘+Enter (run), matching the user's OS. */
export const RUN_SHORTCUT = isMac ? "⌘↵" : "Ctrl ↵";

/** The shortcut sheet's contents (`?`). No destructive action ever has a single-key shortcut. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: [SEARCH_SHORTCUT], label: "Search and commands" },
  { keys: [isMac ? "⌘P" : "Ctrl P"], label: "Switch project" },
  { keys: ["?"], label: "Show these shortcuts" },
  { keys: ["/"], label: "Filter the list on this page" },
  { keys: ["g", "p"], label: "Go to projects" },
  { keys: ["g", "o"], label: "Go to the project's overview" },
  { keys: ["g", "d"], label: "Go to the database" },
  { keys: ["g", "s"], label: "Go to settings" },
  { keys: ["c"], label: "Create (the page's main create action)" },
  { keys: ["r"], label: "Refresh" },
  { keys: ["[", "]"], label: "Previous / next tab" },
  { keys: ["j", "k"], label: "Move down / up a list" },
  { keys: ["↵"], label: "Open the selected item" },
  { keys: ["x"], label: "Select the focused row" },
  { keys: [RUN_SHORTCUT], label: "Run (SQL, send message)" },
];

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("[role=dialog],[role=alertdialog],[cmdk-root]") !== null;
};

const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

/** Rows a list exposes to j/k: elements marked `data-row` inside main. */
function moveRow(step: 1 | -1) {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("main [data-row]")).filter(visible);
  if (rows.length === 0) return;
  const current = rows.findIndex((r) => r.contains(document.activeElement));
  const next = rows[Math.max(0, Math.min(rows.length - 1, current < 0 ? (step === 1 ? 0 : rows.length - 1) : current + step))]!;
  const target = (next.querySelector("a[href], button, [tabindex]") as HTMLElement | null) ?? next;
  target.focus();
  target.scrollIntoView({ block: "nearest" });
}

/**
 * Global single-key shortcuts (DESIGN.md "Interaction patterns"). Ignored while typing or inside
 * dialogs. `onShortcuts` opens the `?` sheet; `onSwitchProject` opens the project switcher.
 */
export function installShortcuts(getRoute: () => Route, handlers: { onShortcuts: () => void; onSwitchProject: () => void }) {
  let pendingG = 0;
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      handlers.onSwitchProject();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
    const route = getRoute();
    const project = isProjectRoute(route) ? route.name : null;
    if (Date.now() - pendingG < 1200) {
      pendingG = 0;
      const to: Route | null =
        e.key === "p" ? { page: "projects", query: "" } : e.key === "s" ? { page: "settings", newToken: false } : project && e.key === "o" ? { page: "project", name: project } : project && e.key === "d" ? { page: "database", name: project, tab: "tables", table: null } : null;
      if (to) {
        e.preventDefault();
        navigate(to);
      }
      return;
    }
    switch (e.key) {
      case "g":
        pendingG = Date.now();
        return;
      case "?":
        e.preventDefault();
        handlers.onShortcuts();
        return;
      case "/": {
        const filter = Array.from(document.querySelectorAll<HTMLInputElement>("main [data-filter], main input[type=search]")).find(visible);
        if (filter) {
          e.preventDefault();
          filter.focus();
          filter.select();
        }
        return;
      }
      case "c": {
        const create = Array.from(document.querySelectorAll<HTMLElement>("main [data-shortcut=create]")).find(visible);
        if (create) {
          e.preventDefault();
          create.click();
        }
        return;
      }
      case "r": {
        const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>("main [data-refresh]")).find((b) => visible(b) && !b.disabled);
        if (refresh) {
          e.preventDefault();
          refresh.click();
        }
        return;
      }
      case "[":
      case "]": {
        const tabs = document.querySelector("main [data-routed-tabs]");
        const links = tabs ? Array.from(tabs.querySelectorAll<HTMLAnchorElement>("a")) : [];
        const at = links.findIndex((a) => a.getAttribute("aria-current") === "page");
        const next = links[at + (e.key === "]" ? 1 : -1)];
        if (next) {
          e.preventDefault();
          window.location.hash = next.getAttribute("href")!;
        }
        return;
      }
      case "j":
      case "ArrowDown":
        if (e.key === "ArrowDown" && !(document.activeElement as HTMLElement | null)?.closest("[data-row]")) return;
        e.preventDefault();
        moveRow(1);
        return;
      case "k":
      case "ArrowUp":
        if (e.key === "ArrowUp" && !(document.activeElement as HTMLElement | null)?.closest("[data-row]")) return;
        e.preventDefault();
        moveRow(-1);
        return;
      case "x": {
        const row = (document.activeElement as HTMLElement | null)?.closest("[data-row]");
        const box = row?.querySelector<HTMLInputElement | HTMLButtonElement>("input[type=checkbox], button[role=checkbox]");
        if (box) {
          e.preventDefault();
          box.click();
        }
        return;
      }
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

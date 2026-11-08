import { useEffect, useState } from "react";

const KEY = "mybase.recent";
const MAX = 5;

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Names of the projects opened most recently, newest first. Pass the open project
 * (if any) to record the visit. Kept per browser in localStorage.
 */
export function useRecentProjects(open: string | undefined) {
  const [recent, setRecent] = useState(read);

  useEffect(() => {
    if (!open) return;
    setRecent((prev) => {
      if (prev[0] === open) return prev;
      const next = [open, ...prev.filter((n) => n !== open)].slice(0, MAX);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: the list still updates for this visit.
      }
      return next;
    });
  }, [open]);

  return recent;
}

const PAGES_KEY = "mybase.recentPages";

export interface RecentPage {
  hash: string;
  title: string;
}

/** The last 5 pages visited (hash + document title), for ⌘K's empty state. */
export function recordPage(hash: string, title: string) {
  try {
    const list: RecentPage[] = JSON.parse(sessionStorage.getItem(PAGES_KEY) ?? "[]");
    const path = hash.split("?")[0];
    const next = [{ hash, title }, ...list.filter((p) => p.hash.split("?")[0] !== path)].slice(0, 6);
    sessionStorage.setItem(PAGES_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: no recent pages.
  }
}

export function recentPages(): RecentPage[] {
  try {
    const list = JSON.parse(sessionStorage.getItem(PAGES_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p) => p && typeof p.hash === "string" && typeof p.title === "string") : [];
  } catch {
    return [];
  }
}

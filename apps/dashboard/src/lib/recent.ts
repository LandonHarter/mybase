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

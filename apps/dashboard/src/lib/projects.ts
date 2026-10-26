import { useCallback, useEffect, useState } from "react";
import type { Project } from "@mybase/shared";
import { api } from "./api";

export type ProjectsState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "ready"; projects: Project[] };

// One shared list so the page and the command menu never disagree.
let state: ProjectsState = { status: "loading" };
const listeners = new Set<(s: ProjectsState) => void>();

function set(next: ProjectsState) {
  state = next;
  for (const l of listeners) l(state);
}

export async function refreshProjects() {
  try {
    set({ status: "ready", projects: await api.listProjects() });
  } catch {
    set({ status: "offline" });
  }
}

export function useProjects() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    if (state.status === "loading") void refreshProjects();
    return () => void listeners.delete(setCurrent);
  }, []);
  return { state: current, refresh: useCallback(refreshProjects, []) };
}

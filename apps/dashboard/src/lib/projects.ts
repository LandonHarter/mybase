import { useCallback, useEffect, useState } from "react";
import type { Project } from "@mybase/shared";
import { api } from "./api";

export type ProjectsState =
  | { status: "loading" }
  | { status: "offline" }
  /** `stale`: the last refresh failed; the list is the last good copy (L06: never blank the UI). */
  | { status: "ready"; projects: Project[]; stale?: boolean; updatedAt: number };

// One shared list so the page and the command menu never disagree.
let state: ProjectsState = { status: "loading" };
const listeners = new Set<(s: ProjectsState) => void>();

function set(next: ProjectsState) {
  state = next;
  for (const l of listeners) l(state);
}

// Every subscriber mounting at once shares one request.
let inflight: Promise<void> | null = null;

export function refreshProjects() {
  inflight ??= api
    .listProjects()
    .then(
      (projects) => set({ status: "ready", projects, updatedAt: Date.now() }),
      () => set(state.status === "ready" ? { ...state, stale: true } : { status: "offline" }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
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

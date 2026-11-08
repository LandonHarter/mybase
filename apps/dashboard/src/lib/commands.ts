import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * "This page" actions for ⌘K (N14): a page registers what you can do here (Insert row, Send
 * message, Run job). They call the same handlers as the page's buttons. Registered while mounted.
 */
export interface PageCommand {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Extra words to match ("add record"). */
  keywords?: string;
  /** Shown as a `<kbd>` hint. */
  shortcut?: string;
  run: () => void;
}

const registered = new Map<symbol, PageCommand[]>();
const listeners = new Set<() => void>();
let snapshot: PageCommand[] = [];
const emit = () => {
  snapshot = [...registered.values()].flat();
  for (const l of listeners) l();
};

/** Registers `commands` for as long as the calling component is mounted. */
export function useCommands(commands: PageCommand[]) {
  const id = useRef(Symbol("commands"));
  const latest = useRef(commands);
  latest.current = commands;
  const signature = commands.map((c) => `${c.id}:${c.label}`).join("|");
  useEffect(() => {
    const key = id.current;
    registered.set(
      key,
      latest.current.map((c) => ({ ...c, run: () => latest.current.find((x) => x.id === c.id)?.run() })),
    );
    emit();
    return () => {
      registered.delete(key);
      emit();
    };
  }, [signature]);
}

export function usePageCommands(): PageCommand[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

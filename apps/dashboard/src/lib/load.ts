import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import { errorMessage, isAbortError, withSignal } from "./api";

export { errorMessage } from "./api";

export type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/**
 * The dashboard's data layer (DESIGN.md "Live data"): one module cache of API reads keyed by a
 * string that identifies the request. Pages read the entry for their current key only, so a page
 * never shows another key's data (unless it opts into `keepPrevious`). In-flight requests are
 * shared, aborted when nothing reads them any more, and the last good data survives a failed
 * refresh. Polling is opt-in, per page, and pauses when the tab is hidden or the owner is idle:
 * mybase runs on a Raspberry Pi, so every request is a query on an SD card.
 */
interface Entry {
  data?: unknown;
  /** When `data` was fetched (ms). */
  at?: number;
  /** Message of the last failed load; kept next to older data as "Couldn't refresh". */
  error?: string;
  inflight?: Promise<void>;
  controller?: AbortController;
  /** Bumped by `invalidate`, so a response started before it doesn't count as fresh. */
  gen: number;
  /** Count of finished loads, so pollers re-arm even when nothing else changed. */
  done: number;
  listeners: Set<() => void>;
  /** The latest fetcher a mounted reader gave, used by invalidate/focus refetches. */
  fetcher?: () => Promise<unknown>;
}

const MAX_ENTRIES = 300;
const entries = new Map<string, Entry>();

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { gen: 0, done: 0, listeners: new Set() };
    entries.set(key, e);
    if (entries.size > MAX_ENTRIES) {
      // Oldest first (Map keeps insertion order); never drop one a page is reading.
      for (const [k, old] of entries) {
        if (entries.size <= MAX_ENTRIES) break;
        if (old.listeners.size === 0 && !old.inflight) entries.delete(k);
      }
    }
  }
  return e;
}

const notify = (e: Entry) => {
  for (const l of e.listeners) l();
};

/** Starts a load for `key` unless one is already running (deduped). */
function load(key: string, fetcher: () => Promise<unknown>): Promise<void> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  const controller = new AbortController();
  const gen = e.gen;
  e.controller = controller;
  const run = (async () => {
    try {
      const data = await withSignal(controller.signal, fetcher);
      if (controller.signal.aborted) return;
      e.data = data;
      e.at = Date.now();
      e.error = undefined;
      // Invalidated mid-flight: the answer may predate the change, so load again.
      if (e.gen !== gen && e.listeners.size > 0) queueMicrotask(() => void load(key, fetcher));
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      e.error = errorMessage(err);
    } finally {
      if (e.controller === controller) {
        e.inflight = undefined;
        e.controller = undefined;
      }
      e.done++;
      notify(e);
    }
  })();
  e.inflight = run;
  notify(e);
  return run;
}

/**
 * Marks every cached key matching `match` (a prefix or a predicate) as stale and reloads the ones
 * a page is showing. Call after a mutation: `invalidate(\`queues:${project}\`)`.
 */
export function invalidate(match: string | ((key: string) => boolean)) {
  const test = typeof match === "string" ? (k: string) => k.startsWith(match) : match;
  for (const [key, e] of entries) {
    if (!test(key)) continue;
    e.gen++;
    e.at = 0;
    if (e.listeners.size > 0 && e.fetcher && !e.inflight) void load(key, e.fetcher);
  }
}

/** Replaces cached data in place (optimistic updates); returns a function that restores it. */
export function mutate<T>(key: string, update: (data: T | undefined) => T): () => void {
  const e = entry(key);
  const before = e.data;
  e.data = update(e.data as T | undefined);
  notify(e);
  return () => {
    e.data = before;
    notify(e);
  };
}

/** Reads what's cached for a key without loading it (⌘K, rail badges: D1 says no extra polls). */
export function peek<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

/** All cached keys starting with `prefix`, with their data (⌘K object search). */
export function peekAll<T>(prefix: string): [string, T][] {
  const out: [string, T][] = [];
  for (const [k, e] of entries) if (k.startsWith(prefix) && e.data !== undefined) out.push([k, e.data as T]);
  return out;
}

/** Loads a key outside a component (⌘K lazily fetching lists on open). Reuses fresh data. */
export async function prefetch<T>(key: string, fetcher: () => Promise<T>, maxAge = 30_000): Promise<T | undefined> {
  const e = entry(key);
  if (e.data !== undefined && e.at && Date.now() - e.at < maxAge) return e.data as T;
  e.fetcher ??= fetcher;
  await load(key, fetcher);
  return e.data as T | undefined;
}

// --- Activity: polling pauses when the tab is hidden or after 5 minutes without input. ---

const IDLE_AFTER = 5 * 60_000;
let lastInput = Date.now();
let idle = false;
const activityListeners = new Set<() => void>();
const emitActivity = () => {
  for (const l of activityListeners) l();
};

if (typeof window !== "undefined") {
  const onInput = () => {
    lastInput = Date.now();
    if (idle) {
      idle = false;
      emitActivity();
    }
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) window.addEventListener(type, onInput, { passive: true });
  let lastMove = 0;
  window.addEventListener(
    "pointermove",
    () => {
      const now = Date.now();
      if (now - lastMove > 5_000) {
        lastMove = now;
        onInput();
      }
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) onInput();
    emitActivity();
  });
  window.addEventListener("focus", () => {
    onInput();
    emitActivity();
  });
  setInterval(() => {
    if (!idle && Date.now() - lastInput > IDLE_AFTER) {
      idle = true;
      emitActivity();
    }
  }, 30_000);
}

/** "hidden" (tab in the background), "idle" (no input for 5 min) or "active". */
export type Activity = "active" | "hidden" | "idle";
const activity = (): Activity => (typeof document !== "undefined" && document.hidden ? "hidden" : idle ? "idle" : "active");
const subscribeActivity = (l: () => void) => {
  activityListeners.add(l);
  return () => activityListeners.delete(l);
};

export function useActivity(): Activity {
  return useSyncExternalStore(subscribeActivity, activity, () => "active");
}

/** Marks the owner active again (the "Paused · Resume" button). */
export function markActive() {
  lastInput = Date.now();
  if (idle) {
    idle = false;
    emitActivity();
  }
}

/** Polling cadences from DESIGN.md "Live data" (D1). */
export const POLL = {
  /** Something is in progress (deploy, cron run, execution): until it reaches a terminal state. */
  progress: 2_000,
  /** Operational lists: queues, realtime, hosting, cron history. */
  list: 15_000,
  /** Analytics reports. */
  analytics: 60_000,
} as const;

export interface LoadOptions<T> {
  /**
   * Poll every N ms while the page is visible and the owner is active. A function decides from the
   * current data (`null` = stop, e.g. at a terminal state). Errors back off ×2, up to ×8.
   * Never set it on secrets or settings.
   */
  interval?: number | null | ((data: T | undefined) => number | null | undefined);
  /** Show the previous key's data while a new key loads (filters, ranges, pages). */
  keepPrevious?: boolean;
  /** Reuse cached data younger than this without a background refetch (default 5 s). */
  maxAge?: number;
  /** Refetch when the window regains focus (default true). */
  refetchOnFocus?: boolean;
}

export interface Load<T> {
  state: LoadState<T>;
  /** Reloads now; resolves when the load finishes (never rejects). */
  refresh: () => Promise<void>;
  /** The data on screen, if any (also while refreshing or after a failed refresh). */
  data: T | undefined;
  /** When the data on screen was fetched (ms since epoch). */
  updatedAt: number | undefined;
  /** A load is running for this key. */
  refreshing: boolean;
  /** The last refresh failed; `data` is the last good copy. */
  refreshError: string | undefined;
  /** The data on screen belongs to the previous key (`keepPrevious`). */
  previous: boolean;
  /** Polling is configured and running (not paused). */
  polling: number | null;
  /** Polling is configured but paused because the tab is hidden or the owner is idle. */
  paused: Activity | null;
}

/**
 * Loads `fetcher` for `key` and keeps it fresh. `key` identifies the request (`fetcher` is a new
 * closure each render): include everything the fetcher reads. Cached data shows instantly (Back is
 * instant) and is revalidated in the background when older than `maxAge`.
 */
export function useLoad<T>(key: string, fetcher: () => Promise<T>, options: LoadOptions<T> = {}): Load<T> {
  const { keepPrevious = false, maxAge = 5_000, refetchOnFocus = true } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stableFetcher = useCallback(() => fetcherRef.current(), []);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const e = entry(key);
  e.fetcher = stableFetcher;

  // Subscribe to this key; abort its request when the last reader leaves.
  useEffect(() => {
    const current = entry(key);
    current.listeners.add(rerender);
    current.fetcher = stableFetcher;
    if (current.data === undefined || !current.at || Date.now() - current.at > maxAge || current.error) void load(key, stableFetcher);
    rerender();
    return () => {
      current.listeners.delete(rerender);
      if (current.listeners.size === 0 && current.controller) {
        current.controller.abort();
        current.inflight = undefined;
        current.controller = undefined;
      }
    };
    // maxAge is read once per key on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stableFetcher]);

  // keepPrevious: remember the last key that had data.
  const shown = useRef<{ key: string; data: unknown; at?: number } | null>(null);
  if (e.data !== undefined) shown.current = { key, data: e.data, at: e.at };
  const usePrevious = keepPrevious && e.data === undefined && shown.current !== null && shown.current.key !== key;

  const data = (e.data !== undefined ? e.data : usePrevious ? shown.current!.data : undefined) as T | undefined;
  const refreshing = e.inflight !== undefined;
  // Stable while nothing changes: pages use `state` as an effect dependency.
  const firstError = data === undefined && !refreshing ? e.error : undefined;
  const state = useMemo<LoadState<T>>(
    () => (data !== undefined ? { status: "ready", data } : firstError !== undefined ? { status: "error", message: firstError } : { status: "loading" }),
    [data, firstError],
  );

  // Polling.
  const act = useActivity();
  const interval = typeof options.interval === "function" ? options.interval(e.data as T | undefined) : options.interval;
  const failures = useRef(0);
  const pollEvery = interval && interval > 0 ? interval : null;
  const running = pollEvery !== null && act === "active";
  const lastError = e.error;
  useEffect(() => {
    if (!running || pollEvery === null) return;
    failures.current = lastError ? Math.min(failures.current + 1, 3) : 0;
    const delay = pollEvery * 2 ** failures.current;
    const timer = setTimeout(() => void load(key, stableFetcher), delay);
    return () => clearTimeout(timer);
    // Re-armed after every finished load (`e.at`/error change).
  }, [running, pollEvery, key, stableFetcher, e.done, lastError]);

  // Refetch on focus / tab return, when the data is older than maxAge.
  useEffect(() => {
    if (!refetchOnFocus) return;
    const onFocus = () => {
      const current = entries.get(key);
      if (!document.hidden && current && (!current.at || Date.now() - current.at > Math.max(maxAge, 5_000))) void load(key, stableFetcher);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [key, stableFetcher, refetchOnFocus, maxAge]);

  const refresh = useCallback(() => {
    markActive();
    const current = entry(key);
    current.gen++;
    if (current.inflight) return current.inflight;
    return load(key, stableFetcher);
  }, [key, stableFetcher]);

  return {
    state,
    refresh,
    data,
    updatedAt: e.data !== undefined ? e.at : usePrevious ? shown.current!.at : undefined,
    refreshing,
    refreshError: data !== undefined ? e.error : undefined,
    previous: usePrevious,
    polling: running ? pollEvery : null,
    paused: pollEvery !== null && act !== "active" ? act : null,
  };
}

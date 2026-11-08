import { useSyncExternalStore } from "react";

/**
 * Shared clocks for relative times, so a page with 200 timestamps has one timer, not 200:
 * a 30 s tick for "3 hours ago", and a 1 s tick only while something under an hour away is shown
 * (cron next run, cache TTL, visibility timeouts).
 */
function clock(ms: number) {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const x of listeners) x();
        }, ms);
      }
      return () => {
        listeners.delete(l);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    get: () => now,
  };
}

const slow = clock(30_000);
const fast = clock(1_000);
const none = { subscribe: () => () => {}, get: () => 0 };

/** The current time, re-rendering every 30 s, or every second with `precise`. `false` = no timer. */
export function useNow(mode: "slow" | "precise" | false = "slow"): number {
  const c = mode === "precise" ? fast : mode === "slow" ? slow : none;
  const t = useSyncExternalStore(c.subscribe, c.get, c.get);
  return mode === false ? Date.now() : t;
}

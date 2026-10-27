import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** A message that's safe to show for any failed API call. */
export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.";

/**
 * Loads `fetcher` on mount and whenever `key` changes. `key` identifies the request
 * (`fetcher` is a new closure each render). `refresh` reloads in place, keeping the
 * current data on screen, after an edit.
 */
export function useLoad<T>(key: string, fetcher: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Drops responses for a key the page has already moved past.
  const currentKey = useRef(key);
  currentKey.current = key;

  const refresh = useCallback(async () => {
    try {
      const data = await fetcherRef.current();
      if (currentKey.current === key) setState({ status: "ready", data });
    } catch (err) {
      if (currentKey.current === key) setState({ status: "error", message: errorMessage(err) });
    }
  }, [key]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
  }, [refresh]);

  return { state, refresh };
}

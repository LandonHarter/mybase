// Page views, custom events, and errors, sent to a mybase project's analytics service.
//
// In a browser, `createAnalytics` records page views (including client-side route changes)
// and uncaught errors on its own, batches everything, and sends it with `sendBeacon` when
// the page is hidden. On a server it only sends what you `track` or `captureError`.
//
// The write key is public: it's meant to ship in browser code. It can only add events.
// No cookies or local storage are used; mybase counts visitors with a daily-rotating hash.

export type AnalyticsEventType = "pageview" | "event" | "error";

/** Custom properties: flat, small, JSON-safe values. */
export type AnalyticsProps = Record<string, string | number | boolean | null>;

/** One event on the wire. */
export interface AnalyticsEvent {
  type: AnalyticsEventType;
  /** Custom events: the event name. Errors: the message. Unused for page views. */
  name?: string;
  /** The route, e.g. `/pricing`. Query string stripped unless the client keeps it. */
  path?: string;
  /** Page views: the page that linked here. mybase keeps only its host. */
  referrer?: string;
  props?: AnalyticsProps;
  /** Errors: the stack trace. */
  stack?: string;
  /** The browser's IANA time zone, used to guess the country when the request doesn't say. */
  tz?: string;
  /** When it happened (ISO). Defaults to when mybase received it. */
  ts?: string;
}

/** The body of `POST /analytics/<project>/events`. */
export interface AnalyticsIngestRequest {
  key: string;
  events: AnalyticsEvent[];
}

/** What the ingest route accepts. Bigger values are rejected (strings are not truncated for you, except by this client). */
export const ANALYTICS_LIMITS = {
  /** Events per request. */
  batch: 50,
  /** Request body, in bytes. */
  bodyBytes: 64 * 1024,
  props: 20,
  propKey: 64,
  propValue: 256,
  path: 512,
  referrer: 512,
  /** Error messages. */
  message: 512,
  stack: 4096,
} as const;

/** Custom event names: letters, digits, space, and `_ . : -`, 1–64 chars. */
export const ANALYTICS_EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:\- ]{1,64}$/;

export interface AnalyticsOptions {
  /** Where the mybase API is reachable from the browser (or server), e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** The project's public write key (`mba_…`), from the Analytics page. */
  key: string;
  /** Browser: record a page view on load and on every client-side route change. Default true. */
  autoPageviews?: boolean;
  /** Browser: record uncaught errors and unhandled promise rejections. Default true. */
  captureErrors?: boolean;
  /** Keep the query string in paths. Default false (`/search?q=x` is recorded as `/search`). */
  keepQuery?: boolean;
  /** Send nothing when the browser's Do Not Track setting is on. Default false. */
  respectDoNotTrack?: boolean;
  /** How long to collect events before sending, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Send right away once this many events are queued. Default 20. */
  batchSize?: number;
  /** Called when a send fails. Analytics never throws into your app; failed events are dropped. */
  onError?: (err: unknown) => void;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface Analytics {
  /** Records a page view. `path` defaults to the current location (browser). */
  pageview(path?: string, props?: AnalyticsProps): void;
  /** Records a custom event, e.g. `track("signup", { plan: "pro" })`. */
  track(name: string, props?: AnalyticsProps): void;
  /** Records an error (an `Error`, or anything else, which is stringified). */
  captureError(error: unknown, props?: AnalyticsProps): void;
  /** Sends everything queued now. Call it before a server process exits. */
  flush(): Promise<void>;
  /** Sends what's queued and removes every listener this client added. */
  stop(): void;
}

/** `/a/b?x=1#h` → `/a/b` (or `/a/b?x=1` with `keepQuery`). Full URLs are reduced to their path. */
export function normalizePath(input: string, keepQuery = false): string {
  let path = input.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path);
  if (scheme) path = path.slice(scheme[0].length);
  path = path.split("#", 1)[0]!;
  if (!keepQuery) path = path.split("?", 1)[0]!;
  if (!path.startsWith("/")) path = `/${path}`;
  return path.slice(0, ANALYTICS_LIMITS.path);
}

/** Drops props that would be rejected, rather than losing the whole event. */
function cleanProps(props: AnalyticsProps | undefined): AnalyticsProps | undefined {
  if (!props) return undefined;
  const out: AnalyticsProps = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= ANALYTICS_LIMITS.props || !k || k.length > ANALYTICS_LIMITS.propKey) continue;
    if (typeof v === "string") out[k] = v.slice(0, ANALYTICS_LIMITS.propValue);
    else if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}

/** `"TypeError: x is undefined"` and its stack, from anything thrown. */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    const message = error.message ? `${error.name}: ${error.message}` : error.name;
    return { message: message.slice(0, ANALYTICS_LIMITS.message), stack: error.stack?.slice(0, ANALYTICS_LIMITS.stack) };
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { message: (message || "Unknown error").slice(0, ANALYTICS_LIMITS.message) };
}

// One patch of history.pushState/replaceState per page, shared by every client.
const NAVIGATE_EVENT = "mybase:navigate";
let historyPatched = false;
function patchHistory() {
  if (historyPatched || typeof history === "undefined") return;
  historyPatched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
      return result;
    };
  }
}

/** Most errors a page reports in one load, so a render loop can't flood the project. */
const MAX_ERRORS_PER_PAGE = 20;

/**
 *   const analytics = createAnalytics({ apiUrl: "https://mybase.example.com", project: "shop", key: "mba_…" });
 *   analytics.track("signup", { plan: "pro" });
 */
export function createAnalytics(options: AnalyticsOptions): Analytics {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/analytics/${encodeURIComponent(options.project)}/events`;
  const browser = typeof window !== "undefined" && typeof document !== "undefined";
  const keepQuery = options.keepQuery ?? false;
  const interval = options.flushIntervalMs ?? 5000;
  const batchSize = Math.min(options.batchSize ?? 20, ANALYTICS_LIMITS.batch);
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      return undefined;
    }
  })();
  const dnt = browser && options.respectDoNotTrack && (navigator.doNotTrack === "1" || (window as { doNotTrack?: string }).doNotTrack === "1");

  const queue: AnalyticsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const cleanups: (() => void)[] = [];
  const reportFailure = (err: unknown) => options.onError?.(err);

  function send(events: AnalyticsEvent[], beacon: boolean): Promise<void> {
    const body = JSON.stringify({ key: options.key, events } satisfies AnalyticsIngestRequest);
    // text/plain keeps it a "simple" request: no CORS preflight, and sendBeacon accepts it.
    if (beacon && browser && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return Promise.resolve();
    }
    return doFetch(url, { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: browser, credentials: "omit" }).then(
      async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          reportFailure(new Error(data.error ?? `mybase analytics answered ${res.status}`));
        }
      },
      reportFailure,
    );
  }

  function flushQueued(beacon: boolean): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const sends: Promise<void>[] = [];
    while (queue.length > 0) sends.push(send(queue.splice(0, batchSize), beacon));
    return Promise.all(sends).then(() => undefined);
  }

  function enqueue(event: AnalyticsEvent) {
    if (stopped || dnt) return;
    queue.push({ ...event, tz: event.tz ?? tz, ts: event.ts ?? new Date().toISOString() });
    if (queue.length >= batchSize) void flushQueued(false);
    else if (!timer) timer = setTimeout(() => void flushQueued(false), interval);
  }

  // Page views ------------------------------------------------------------------
  let lastPath: string | null = null;
  let firstView = true;

  function pageview(path?: string, props?: AnalyticsProps) {
    const raw = path ?? (browser ? location.pathname + location.search : undefined);
    if (raw === undefined) return;
    const normalized = normalizePath(raw, keepQuery);
    const event: AnalyticsEvent = { type: "pageview", path: normalized, props: cleanProps(props) };
    // The referrer only means something for the page the visitor landed on.
    if (firstView && browser && document.referrer) {
      try {
        if (new URL(document.referrer).host !== location.host) event.referrer = document.referrer.slice(0, ANALYTICS_LIMITS.referrer);
      } catch {
        // not a URL; skip it
      }
    }
    firstView = false;
    lastPath = normalized;
    enqueue(event);
  }

  if (browser && (options.autoPageviews ?? true)) {
    const onRoute = () => {
      const path = normalizePath(location.pathname + location.search, keepQuery);
      // replaceState is often used for scroll or filter state; only a new path counts.
      if (path !== lastPath) pageview();
    };
    patchHistory();
    window.addEventListener(NAVIGATE_EVENT, onRoute);
    window.addEventListener("popstate", onRoute);
    cleanups.push(() => {
      window.removeEventListener(NAVIGATE_EVENT, onRoute);
      window.removeEventListener("popstate", onRoute);
    });
    pageview();
  }

  // Errors ----------------------------------------------------------------------
  const seenErrors = new Set<string>();

  function captureError(error: unknown, props?: AnalyticsProps) {
    const { message, stack } = describeError(error);
    // The same error over and over is one error; count it once per page load.
    const id = `${message}\n${stack?.split("\n", 2)[1] ?? ""}`;
    if (seenErrors.has(id) || seenErrors.size >= MAX_ERRORS_PER_PAGE) return;
    seenErrors.add(id);
    enqueue({
      type: "error",
      name: message,
      stack,
      path: browser ? normalizePath(location.pathname + location.search, keepQuery) : undefined,
      props: cleanProps(props),
    });
  }

  if (browser && (options.captureErrors ?? true)) {
    const onError = (e: ErrorEvent) => captureError(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => captureError(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
  }

  // Leaving the page: send what's queued while the browser still lets us.
  if (browser) {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushQueued(true);
    };
    const onPageHide = () => void flushQueued(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    });
  }

  return {
    pageview,
    track(name, props) {
      if (typeof name !== "string" || !ANALYTICS_EVENT_NAME_PATTERN.test(name)) {
        reportFailure(new TypeError(`invalid event name "${String(name)}": use 1–64 letters, digits, spaces, or _ . : -`));
        return;
      }
      enqueue({ type: "event", name, path: browser ? normalizePath(location.pathname + location.search, keepQuery) : undefined, props: cleanProps(props) });
    },
    captureError,
    flush: () => flushQueued(false),
    stop() {
      void flushQueued(false);
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

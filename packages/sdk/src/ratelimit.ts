// Rate limiting through mybase. The API keeps the counters in its Valkey server, so every
// instance of your app (and every serverless invocation) shares one limit.
//
//   const limiter = createRateLimiter({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   const { success } = await limiter.limit("login", ip);
//
// Limits are either named rules (defined on the dashboard or in mybase.config.ts and synced with
// `mybase ratelimit sync`) or inline: `limiter.limit({ limit: 10, window: "1m" }, userId)`.
import { MybaseApiError, parseDelay } from "./cron";

export { MybaseApiError };

/**
 * `sliding`: smooth, a weighted count over the current and previous window (default).
 * `fixed`: a plain counter per window; allows bursts at window edges.
 * `token`: a bucket of `burst` tokens (default `limit`), refilled at `limit` per `window`.
 */
export const RATELIMIT_ALGORITHMS = ["sliding", "fixed", "token"] as const;
export type RateLimitAlgorithm = (typeof RATELIMIT_ALGORITHMS)[number];

export const RATELIMIT_LIMITS = {
  limit: { min: 1, max: 1_000_000 },
  windowMs: { min: 1000, max: 30 * 86_400_000 },
  idLength: 256,
  cost: { min: 1, max: 1_000_000 },
} as const;

/** A limit defined inline, per call. Same fields as a rule. */
export interface InlineLimit {
  limit: number;
  /** Milliseconds, or `"10s"`, `"1m"`, `"1h"`, `"1d"`. */
  window: number | string;
  algorithm?: RateLimitAlgorithm;
  /** Token bucket only: capacity. Default `limit`. */
  burst?: number;
}

/** Body of `POST /ratelimit/<project>/limit`. Give `rule` or the inline fields. */
export interface RateLimitRequest {
  /** What's being limited: a user id, an IP, an API key. Up to 256 chars. */
  id: string;
  rule?: string;
  limit?: number;
  /** In ms. */
  windowMs?: number;
  algorithm?: RateLimitAlgorithm;
  burst?: number;
  /** Units this request uses. Default 1. */
  cost?: number;
}

export interface RateLimitResult {
  /** Whether the request is within the limit. */
  success: boolean;
  limit: number;
  /** Units left in this window (or tokens left in the bucket). */
  remaining: number;
  /** When the limit fully resets, in unix ms. */
  reset: number;
  /** Set when mybase couldn't be reached and the limiter failed open or closed. */
  error?: unknown;
}

export interface RateLimiterOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `ratelimit:write` for this project. Server-side only. */
  apiKey: string;
  /**
   * What to answer when mybase can't be reached or times out. Default `false`: allow the request
   * (fail open), so an outage doesn't take your app down with it. Set `true` for routes where
   * letting traffic through is worse (sign-in, password reset).
   */
  failClosed?: boolean;
  /** How long to wait for mybase, in ms. Default 1000. */
  timeoutMs?: number;
  /** Called when mybase can't be reached, before failing open or closed. */
  onError?: (error: unknown) => void;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface LimitOptions {
  /** Units this request uses. Default 1. */
  cost?: number;
}

export interface RateLimiter {
  /** Counts one request (or `cost` units) for `id` against a named rule or an inline limit. */
  limit(rule: string | InlineLimit, id: string, options?: LimitOptions): Promise<RateLimitResult>;
}

/** `"10s"` / `"1m"` / ms → ms, checked against the allowed window range. */
export function parseWindow(value: number | string): number {
  const ms = parseDelay(value);
  const { min, max } = RATELIMIT_LIMITS.windowMs;
  if (ms < min || ms > max) throw new RangeError(`window must be from 1s to 30d, got "${value}"`);
  return ms;
}

/** Headers to send with a 429 (or any response): `RateLimit-*` and `Retry-After`. */
export function rateLimitHeaders(result: RateLimitResult, now = Date.now()): Record<string, string> {
  const resetSec = Math.max(0, Math.ceil((result.reset - now) / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSec),
  };
  if (!result.success) headers["Retry-After"] = String(resetSec);
  return headers;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/ratelimit/${encodeURIComponent(options.project)}/limit`;
  const timeoutMs = options.timeoutMs ?? 1000;

  return {
    async limit(rule, id, { cost } = {}) {
      // Bad arguments are bugs in the caller: throw, don't fail open.
      const body: RateLimitRequest =
        typeof rule === "string"
          ? { id, rule, cost }
          : { id, limit: rule.limit, windowMs: parseWindow(rule.window), algorithm: rule.algorithm, burst: rule.burst, cost };
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return unavailable(error);
      }
      const data = (await res.json().catch(() => ({}))) as RateLimitResult & { error?: string };
      if (res.ok) return { success: data.success, limit: data.limit, remaining: data.remaining, reset: data.reset };
      const error = new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
      // 5xx (Valkey down, API restarting): an outage. 4xx: a wrong key, an unknown rule, bad input.
      if (res.status >= 500) return unavailable(error);
      throw error;
    },
  };

  function unavailable(error: unknown): RateLimitResult {
    options.onError?.(error);
    return { success: !options.failClosed, limit: 0, remaining: 0, reset: Date.now(), error };
  }
}

// The HTTP side of admin auth: cookies, client IPs, the CSRF check, and login throttling.
// No database access, so it's easy to test (auth-http.test.ts).
import type { Server } from "bun";

export const SESSION_COOKIE = "mybase_session";
export const SESSION_DAYS = 30;

/**
 * `MYBASE_TRUST_PROXY=cloudflare` means requests arrive through a Cloudflare Tunnel, so
 * `CF-Connecting-IP` is the real client. Without it the header is ignored: anyone could set it.
 */
const trustCloudflare = () => process.env.MYBASE_TRUST_PROXY === "cloudflare";

export function clientIp(req: Request, server: Server<unknown>): string {
  if (trustCloudflare()) {
    const ip = req.headers.get("CF-Connecting-IP");
    if (ip) return ip;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

/** The visitor's country (ISO alpha-2) from Cloudflare's `CF-IPCountry`, when the API trusts it. */
export function trustedCountry(req: Request): string | null {
  if (!trustCloudflare()) return null;
  const cc = req.headers.get("CF-IPCountry")?.toUpperCase();
  // XX: unknown, T1: Tor.
  return cc && /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : null;
}

/** Whether the request passed through Cloudflare, trusted or not. Used to keep first-run setup local. */
export const viaCloudflare = (req: Request) => req.headers.has("CF-Ray") || req.headers.has("CF-Connecting-IP");

/** Loopback, RFC 1918, link-local, unique-local, and 100.64/10 (Tailscale). */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80:");
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** HTTPS as the browser saw it: directly, or at Cloudflare in front of the tunnel. */
function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return trustCloudflare() && (req.headers.get("X-Forwarded-Proto") === "https" || (req.headers.get("CF-Visitor") ?? "").includes('"https"'));
}

/** `token` null clears the cookie. Secure only over HTTPS, so LAN access over plain HTTP still works. */
export function sessionCookie(req: Request, token: string | null): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (isHttps(req)) attrs.push("Secure");
  return `${SESSION_COOKIE}=${token ?? ""}; ${attrs.join("; ")}`;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for cookie-authenticated requests. SameSite=Lax already keeps the cookie off
 * cross-site POSTs; this also rejects same-site but cross-origin ones (another subdomain).
 * Browsers send `Sec-Fetch-Site`; older ones fall back to comparing `Origin` with `Host`.
 * Requests with neither header aren't from a browser page, so there's nothing to forge.
 */
export function crossOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const site = req.headers.get("Sec-Fetch-Site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  const host = req.headers.get("X-Forwarded-Host") ?? req.headers.get("Host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** sha256 hex: tokens are random, so a fast hash is enough (unlike passwords). */
export const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

/** A random token, url-safe, with a prefix that says what it is. */
export const newToken = (prefix: string) => `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

/**
 * Per-IP login backoff, in memory: free failures, then a lockout that doubles each time,
 * up to an hour. A restart forgets it, which is fine for one admin on a home server.
 */
export class LoginThrottle {
  private entries = new Map<string, { failures: number; until: number }>();

  constructor(
    private readonly free = 5,
    private readonly baseMs = 30_000,
    private readonly maxMs = 3_600_000,
  ) {}

  /** Seconds until this IP may try again, or 0. */
  retryAfter(ip: string, now = Date.now()): number {
    const entry = this.entries.get(ip);
    return entry && entry.until > now ? Math.ceil((entry.until - now) / 1000) : 0;
  }

  fail(ip: string, now = Date.now()) {
    const entry = this.entries.get(ip) ?? { failures: 0, until: 0 };
    entry.failures++;
    if (entry.failures >= this.free) entry.until = now + Math.min(this.maxMs, this.baseMs * 2 ** (entry.failures - this.free));
    this.entries.set(ip, entry);
    // Keep memory bounded if something hammers the endpoint from many addresses.
    if (this.entries.size > 10_000) {
      for (const [key, value] of this.entries) if (value.until < now) this.entries.delete(key);
    }
  }

  succeed(ip: string) {
    this.entries.delete(ip);
  }
}

/**
 * Fixed-window rate limit per key (an IP), in memory: up to `limit` units per `windowMs`.
 * Used for public write routes (analytics ingest) where a login-style lockout would be wrong.
 */
export class RateLimit {
  private windows = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Takes `n` units for `key`. False (and nothing taken) when that would go over the limit. */
  take(key: string, n = 1, now = Date.now()): boolean {
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, used: 0 };
      this.windows.set(key, entry);
      // Keep memory bounded if many addresses send at once.
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) if (now - v.start >= this.windowMs) this.windows.delete(k);
      }
    }
    if (entry.used + n > this.limit) return false;
    entry.used += n;
    return true;
  }
}

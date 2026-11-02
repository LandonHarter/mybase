// The HTTP side of admin auth: cookies, client IPs, the CSRF check, and login throttling.
// No database access, so it's easy to test (auth-http.test.ts).
import type { Server } from "bun";

export const SESSION_COOKIE = "mybase_session";
export const SESSION_DAYS = 30;

/**
 * Which proxy in front of the API to believe about the client (`MYBASE_TRUST_PROXY`):
 *  - `cloudflare`: a Cloudflare Tunnel (or Cloudflare's proxy). `CF-Connecting-IP` is the client,
 *    but only when the request came from a private address (cloudflared next to the API) or from
 *    Cloudflare's own ranges. Sent straight to an exposed port, the header is ignored.
 *  - a list of IPs/CIDRs (`10.0.0.0/8,127.0.0.1`): any other reverse proxy (nginx, Caddy, a cloud
 *    load balancer). Requests from those addresses get the client from `X-Forwarded-For` (the last
 *    hop that isn't a trusted proxy) and the scheme from `X-Forwarded-Proto`.
 * Unset: no headers are believed; anyone could set them.
 */
type ProxyTrust = { kind: "none" } | { kind: "cloudflare" } | { kind: "list"; nets: Cidr[] };

let parsedTrust: { raw: string | undefined; trust: ProxyTrust } | null = null;
function proxyTrust(): ProxyTrust {
  const raw = process.env.MYBASE_TRUST_PROXY?.trim();
  if (parsedTrust && parsedTrust.raw === raw) return parsedTrust.trust;
  let trust: ProxyTrust = { kind: "none" };
  if (raw === "cloudflare") trust = { kind: "cloudflare" };
  else if (raw) {
    const nets = raw.split(",").map((s) => parseCidr(s.trim()));
    if (nets.every(Boolean)) trust = { kind: "list", nets: nets as Cidr[] };
  }
  parsedTrust = { raw, trust };
  return trust;
}

// Cloudflare's published ranges (https://www.cloudflare.com/ips/), for its proxy reaching an open port.
const CLOUDFLARE_NETS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
  "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
].map((n) => parseCidr(n)!);

/** Requests whose proxy headers this API believes (set by `clientIp`, read by `isHttps` and `trustedCountry`). */
const trustedRequests = new WeakSet<Request>();

/** Set once a request came through Cloudflare while the API doesn't trust it (security advisor). */
export const proxySeen = { untrustedCloudflare: false };

export function clientIp(req: Request, server: Server<unknown>): string {
  const peer = server.requestIP(req)?.address ?? "unknown";
  const trust = proxyTrust();
  if (trust.kind === "cloudflare") {
    const ip = req.headers.get("CF-Connecting-IP");
    if (isPrivateIp(peer) || inNets(peer, CLOUDFLARE_NETS)) {
      trustedRequests.add(req);
      if (ip) return ip;
    }
  } else if (trust.kind === "list") {
    if (inNets(peer, trust.nets)) {
      trustedRequests.add(req);
      const hops = (req.headers.get("X-Forwarded-For") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      // Right to left: the first address that isn't one of our proxies is the client.
      for (let i = hops.length - 1; i >= 0; i--) if (!inNets(hops[i]!, trust.nets)) return hops[i]!;
      return hops[0] ?? peer;
    }
  } else if (req.headers.has("CF-Ray")) {
    proxySeen.untrustedCloudflare = true;
  }
  return peer;
}

/** The visitor's country (ISO alpha-2) from Cloudflare's `CF-IPCountry`, when the API trusts it. */
export function trustedCountry(req: Request): string | null {
  if (proxyTrust().kind !== "cloudflare" || !trustedRequests.has(req)) return null;
  const cc = req.headers.get("CF-IPCountry")?.toUpperCase();
  // XX: unknown, T1: Tor.
  return cc && /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : null;
}

/**
 * Whether the request passed through a proxy, trusted or not. Used to keep first-run setup local:
 * behind a proxy the API isn't told about, every visitor would look like the proxy's private IP.
 */
export const viaProxy = (req: Request) =>
  req.headers.has("CF-Ray") || req.headers.has("CF-Connecting-IP") || req.headers.has("X-Forwarded-For") || req.headers.has("Forwarded") || req.headers.has("X-Real-IP");

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

interface Cidr {
  bytes: Uint8Array;
  bits: number;
}

/** An IP as bytes (4 or 16), IPv4-mapped IPv6 as IPv4. Null if it isn't one. */
function ipBytes(ip: string): Uint8Array | null {
  const v4 = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
  const parts = v4.split(".");
  if (parts.length === 4) {
    const n = parts.map(Number);
    return n.every((x, i) => /^\d{1,3}$/.test(parts[i]!) && x <= 255) ? new Uint8Array(n) : null;
  }
  if (!ip.includes(":")) return null;
  const halves = ip.toLowerCase().split("%")[0]!.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":") : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

/** `10.0.0.0/8`, `::1`, `203.0.113.7`. Null if it doesn't parse. */
export function parseCidr(text: string): Cidr | null {
  const [ip, len] = text.split("/");
  const bytes = ipBytes(ip ?? "");
  if (!bytes) return null;
  const max = bytes.length * 8;
  const bits = len === undefined ? max : Number(len);
  return Number.isInteger(bits) && bits >= 0 && bits <= max ? { bytes, bits } : null;
}

/** Whether `ip` falls in any of `nets`. */
export function inNets(ip: string, nets: Cidr[]): boolean {
  const bytes = ipBytes(ip);
  if (!bytes) return false;
  return nets.some((net) => {
    if (net.bytes.length !== bytes.length) return false;
    for (let bit = 0; bit < net.bits; bit += 8) {
      const take = Math.min(8, net.bits - bit);
      const mask = (0xff << (8 - take)) & 0xff;
      if ((bytes[bit / 8]! & mask) !== (net.bytes[bit / 8]! & mask)) return false;
    }
    return true;
  });
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** HTTPS as the browser saw it: directly, or at Cloudflare in front of the tunnel. */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return trustedRequests.has(req) && (req.headers.get("X-Forwarded-Proto") === "https" || (req.headers.get("CF-Visitor") ?? "").includes('"https"'));
}

/** `token` null clears the cookie. Secure only over HTTPS, so LAN access over plain HTTP still works. */
export function sessionCookie(req: Request, token: string | null): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (isHttps(req)) attrs.push("Secure");
  return `${SESSION_COOKIE}=${token ?? ""}; ${attrs.join("; ")}`;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  // `docker login` only speaks Basic: any username, the API key as the password.
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString();
    const key = decoded.slice(decoded.indexOf(":") + 1);
    return decoded.includes(":") && key.startsWith("mb_") ? key : null;
  }
  return null;
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

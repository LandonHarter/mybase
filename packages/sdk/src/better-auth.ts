// Sign-in for your app's users with Better Auth (https://better-auth.com), backed by mybase.
// Better Auth runs in your app and does the auth work; these helpers plug mybase in:
//
//   import { betterAuth } from "better-auth";
//   import { captcha } from "better-auth/plugins";
//   import { Pool } from "pg";
//   import { createCache } from "@mybase-dev/sdk/cache";
//   import { authDatabaseUrl, mybaseAuth, mybaseCaptcha, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";
//
//   const mybase = { apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! };
//   export const auth = betterAuth({
//     database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }),
//     secondaryStorage: mybaseSecondaryStorage(createCache(mybase)),
//     session: { storeSessionInDatabase: true },
//     emailAndPassword: { enabled: true },
//     plugins: [mybaseAuth(mybase), captcha(mybaseCaptcha({ ...mybase, secretKey: process.env.MYBASE_CAPTCHA_SECRET! }))],
//   });
//
// Nothing here imports better-auth, so this module adds no dependencies; the shapes below
// match Better Auth's `SecondaryStorage`, plugin, and captcha options (checked against 1.7).
import type { Cache } from "./cache";

/** Better Auth's tables live in this schema of the project's database (the `users` service creates it). */
export const AUTH_SCHEMA = "auth";

/**
 * The project's connection string with `search_path` set to the auth schema, so Better Auth's
 * tables (and its migrations) land there instead of next to your app's tables in `public`.
 * Pass `extra` schemas to also see them unqualified (e.g. `["public"]`).
 */
export function authDatabaseUrl(url: string, extra: string[] = []): string {
  const u = new URL(url);
  const path = [AUTH_SCHEMA, ...extra].join(",");
  u.searchParams.set("options", `-c search_path=${path}`);
  return u.toString();
}

/** What Better Auth's `secondaryStorage` option takes. TTLs are in seconds. */
export interface SecondaryStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttl: number): Promise<number>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Better Auth's `secondaryStorage` on the project's mybase cache (Valkey): sessions and rate
 * limit counters stay in memory instead of hitting Postgres (and the SD card) on every request.
 * Keys go under `<project>:auth:`, inside the project's cache ACL. Needs the cache service and an
 * API key with `cache:write`. The dashboard's Users page revokes sessions here too.
 */
export function mybaseSecondaryStorage(cache: Cache, { prefix = "auth:" }: { prefix?: string } = {}): SecondaryStorage {
  const k = (key: string) => cache.key(prefix + key);
  return {
    get: (key) => cache.command<string | null>(["GET", k(key)]),
    getAndDelete: (key) => cache.command<string | null>(["GETDEL", k(key)]),
    async increment(key, ttl) {
      // Created at 0 with the TTL (only if absent), then incremented: the window starts at the first hit.
      const [, incr] = await cache
        .pipeline()
        .command(["SET", k(key), 0, "EX", Math.max(1, Math.ceil(ttl)), "NX"])
        .command(["INCR", k(key)])
        .exec({ atomic: true });
      if (!incr || "error" in incr) throw new Error(`mybase cache: ${incr && "error" in incr ? incr.error : "no reply"}`);
      return Number(incr.result);
    },
    async set(key, value, ttl) {
      await cache.command(ttl && ttl > 0 ? ["SET", k(key), value, "EX", Math.ceil(ttl)] : ["SET", k(key), value]);
    },
    async delete(key) {
      await cache.command(["DEL", k(key)]);
    },
  };
}

export interface MybaseAuthOptions {
  /** Where the mybase API is reachable from your app. */
  apiUrl: string;
  project: string;
  /** A mybase API key with `users:write` for this project. Server-side only. */
  apiKey: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Called when an event can't be sent (it's dropped, never retried). Default: console.warn. */
  onError?: (err: unknown) => void;
}

/** What the app reports to mybase's audit log (`POST /users/:project/events`). */
export type UserEventType = "user.created" | "user.deleted" | "session.created" | "session.revoked";

export interface UserEvent {
  type: UserEventType;
  userId: string;
  /** The end user's IP and user agent, as Better Auth saw them. */
  ip?: string | null;
  userAgent?: string | null;
}

interface SessionLike {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * A Better Auth plugin that reports sign-ups, sign-ins, sign-outs, and deleted users to the
 * project's mybase audit log, where they show up next to everything else (and on the
 * dashboard's Users page). No passwords, emails, or tokens are sent: user ids, IPs, user agents.
 * Sending never blocks or fails a sign-in.
 */
export function mybaseAuth(options: MybaseAuthOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/users/${encodeURIComponent(options.project)}/events`;
  const onError = options.onError ?? ((err: unknown) => console.warn("mybase: auth event not sent:", err));

  const send = (event: UserEvent) => {
    void doFetch(url, {
      method: "POST",
      body: JSON.stringify({ events: [event] }),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    })
      .then(async (res) => {
        if (!res.ok) onError(new Error(`mybase API answered ${res.status}: ${await res.text().catch(() => "")}`));
      })
      .catch(onError);
  };
  const fromSession = (type: UserEventType, s: SessionLike) => send({ type, userId: s.userId, ip: s.ipAddress ?? null, userAgent: s.userAgent ?? null });

  return {
    id: "mybase" as const,
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: { after: async (user: { id: string }) => send({ type: "user.created", userId: user.id }) },
              delete: { after: async (user: { id: string }) => send({ type: "user.deleted", userId: user.id }) },
            },
            session: {
              create: { after: async (session: SessionLike) => fromSession("session.created", session) },
              delete: { after: async (session: SessionLike) => fromSession("session.revoked", session) },
            },
          },
        },
      };
    },
  };
}

export interface MybaseCaptchaOptions {
  apiUrl: string;
  project: string;
  /** The project's captcha secret (dashboard → Captcha, or `mybase captcha key`). Server-side only. */
  secretKey: string;
  /** Better Auth routes that need a solved captcha. Default: sign-up, sign-in, and password reset. */
  endpoints?: string[];
}

/**
 * Options for Better Auth's `captcha()` plugin that check tokens with mybase's self-hosted
 * captcha instead of Cloudflare's: mybase answers in Turnstile's siteverify format. Put the
 * widget (`<script src="<mybase>/captcha.js">`) on your forms and send its token in the
 * `x-captcha-response` header, as Better Auth expects.
 */
export function mybaseCaptcha(options: MybaseCaptchaOptions) {
  return {
    provider: "cloudflare-turnstile" as const,
    secretKey: options.secretKey,
    siteVerifyURLOverride: `${options.apiUrl.replace(/\/+$/, "")}/captcha/${encodeURIComponent(options.project)}/siteverify`,
    ...(options.endpoints ? { endpoints: options.endpoints } : {}),
  };
}

/**
 * The statement that tells Postgres who the signed-in user is, for row-level security policies
 * on `mybase_auth.uid()`. Run it inside the same transaction as your queries:
 *
 *   await sql.begin(async (tx) => {
 *     const q = userContextQuery(session.user.id);
 *     await tx.unsafe(q.text, q.values);
 *     return tx`select * from orders`; // policy: using (user_id = mybase_auth.uid())
 *   });
 *
 * Policies only apply to the table owner (your app's role) with `force row level security`.
 */
export function userContextQuery(userId: string): { text: string; values: [string] } {
  return { text: "select set_config('mybase.user_id', $1, true)", values: [userId] };
}

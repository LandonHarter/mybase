// The shared Valkey server (Redis-compatible), behind the cache and ratelimit services.
//
// The API holds one admin connection (the `default` user). Projects get their own ACL
// users (cache.ts); rate-limit state lives under `mybase:`, which no project user can reach.
import { RedisClient } from "bun";
import type { Logger } from "@mybase/shared/logger";
import { ServiceUnavailableError } from "./errors";

const env = process.env;
const host = env.VALKEY_HOST ?? "localhost";
const port = Number(env.VALKEY_PORT ?? 6379);
const password = env.VALKEY_PASSWORD ?? "change-me";

/** Where the API itself reaches Valkey. */
export const valkeyAddress = { host, port };

/** A connection as `user`. Valkey checks the password on connect. */
export function connectAs(user: string, pass: string, options: { idleTimeout?: number } = {}) {
  const url = `redis://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  // Fail fast instead of queueing: callers are HTTP requests that shouldn't hang on an outage.
  return new RedisClient(url, { connectionTimeout: 3000, enableOfflineQueue: false, maxRetries: 5, ...options });
}

let admin: RedisClient | undefined;
const connectHooks: (() => Promise<void>)[] = [];
let hooksDone: Promise<void> = Promise.resolve();

/**
 * Runs `hook` each time the admin connection (re)connects. Valkey keeps ACL users in memory
 * only, so after it restarts, cache.ts puts them back from here.
 */
export function onValkeyConnect(hook: () => Promise<void>) {
  connectHooks.push(hook);
}

function adminClient(): RedisClient {
  if (!admin) {
    admin = connectAs("default", password);
    admin.onconnect = () => {
      hooksDone = Promise.all(connectHooks.map((hook) => hook())).then(() => {});
    };
  }
  return admin;
}

/** Makes sure the admin connection is up and its connect hooks have finished. */
export async function ensureReady() {
  await send("PING");
  await hooksDone;
}

/**
 * An error reply from Valkey (e.g. NOPERM, WRONGTYPE), as opposed to a connection failure.
 * Bun reports some replies it doesn't recognize (NOPERM) as ERR_REDIS_INVALID_RESPONSE, so
 * this also goes by the reply's uppercase error prefix.
 */
export function isServerError(err: unknown): boolean {
  const { code, message } = err as { code?: string; message?: string };
  return code === "ERR_REDIS_SERVER_ERROR" || (code === "ERR_REDIS_INVALID_RESPONSE" && /^[A-Z][A-Z_]+ /.test(message ?? ""));
}

/**
 * Runs one command as the admin user. Connection failures become 503s; server error
 * replies are rethrown as they are, for the caller to map.
 */
export async function send<T = unknown>(command: string, args: (string | number)[] = []): Promise<T> {
  // Replace a client that lost its connection: they don't reliably reconnect.
  if (admin && !admin.connected) {
    admin.close();
    admin = undefined;
  }
  const client = adminClient();
  try {
    if (!client.connected) await client.connect();
    return (await client.send(command, args.map(String))) as T;
  } catch (err) {
    if (isServerError(err)) throw err;
    // A client that lost its connection doesn't always come back: start over next time.
    if (admin === client) admin = undefined;
    client.close();
    throw new ServiceUnavailableError("the cache server (Valkey) is unavailable");
  }
}

/** Deletes every key matching `pattern`, in batches. Returns how many went. */
export async function unlinkMatching(pattern: string): Promise<number> {
  let cursor = "0";
  let count = 0;
  do {
    const [next, keys] = await send<[string, string[]]>("SCAN", [cursor, "MATCH", pattern, "COUNT", 500]);
    cursor = next;
    if (keys.length > 0) count += await send<number>("UNLINK", keys);
  } while (cursor !== "0");
  return count;
}

/** Waits for Valkey on boot. Unlike Postgres, the API starts without it: only cache and ratelimit need it. */
export async function waitForValkey(log: Logger, attempts = 15): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await send("PING");
      log.info("valkey connected", { host, port });
      return true;
    } catch (err) {
      if (attempt >= attempts) {
        log.error("valkey unreachable, cache and ratelimit are unavailable", { host, port, err });
        return false;
      }
      log.warn("valkey not ready, retrying", { host, port, attempt });
      await Bun.sleep(2000);
    }
  }
}

/** `INFO memory` as numbers, for the dashboard. */
export async function memoryInfo(): Promise<{ usedBytes: number; maxBytes: number; policy: string }> {
  const info = await send<string>("INFO", ["memory"]);
  const field = (name: string) => /^(\S+):(.*)$/m.exec(info.split(/\r?\n/).find((l) => l.startsWith(`${name}:`)) ?? "")?.[2]?.trim() ?? "";
  return { usedBytes: Number(field("used_memory")), maxBytes: Number(field("maxmemory")), policy: field("maxmemory_policy") };
}

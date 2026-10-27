// The cache service: each project gets a Valkey ACL user that can only touch keys and
// channels starting with `<project>:`. Apps connect over TCP with any Redis client, or over
// HTTP through this API (Upstash's REST format) when they can't reach the Valkey port.
//
// Only a SHA-256 of each password is stored. Valkey accepts that form (`#<hash>`), so the
// API re-applies every project's ACL on boot without knowing the passwords. For HTTP, the API
// connects as the project's user with a second password of its own (`internalPassword`),
// derived from a secret made at boot and never stored; apps authenticate with an API key.
import type {
  CacheCredentials,
  CacheInfo,
  CacheKeyDetail,
  CacheKeyList,
  CacheKeySummary,
  CacheKeyType,
  CacheOverview,
  PutCacheKeyRequest,
} from "@mybase/shared";
import { CACHE_KEY_TYPES } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import type { RedisClient } from "bun";
import { hashToken } from "./auth-http";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";
import { connectAs, ensureReady, isServerError, memoryInfo, onValkeyConnect, send, unlinkMatching, valkeyAddress } from "./valkey";

const env = process.env;
const publicHost = env.MYBASE_CACHE_PUBLIC_HOST ?? "localhost";
const publicPort = Number(env.MYBASE_CACHE_PUBLIC_PORT ?? valkeyAddress.port);
const publicApiUrl = (env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const newPassword = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

/**
 * Everything but admin and dangerous commands, on the project's own keys and channels. Also
 * off: commands that list or count other projects' keys or channels (key patterns don't filter
 * them), switch databases, or change server-wide scripts.
 */
const ACL_RULES = [
  "+@all",
  "-@dangerous",
  "-@admin",
  "-scan",
  "-keys",
  "-randomkey",
  "-dbsize",
  "-select",
  "-swapdb",
  "-move",
  "-function",
  "-script|flush",
  "-wait",
  "-waitaof",
  "-object",
  "-debug",
  "-client|list",
  "-client|kill",
  "-client|info",
  "-pubsub|channels",
  "-pubsub|numsub",
  "-pubsub|shardchannels",
  "-pubsub|shardnumsub",
];

// New each boot: the ACLs are re-applied on every (re)connect anyway (`restoreCacheUsers`).
const bootSecret = crypto.getRandomValues(new Uint8Array(32));

/** The API's own password for a project's user, for HTTP commands. */
const internalPassword = (project: string) => new Bun.CryptoHasher("sha256", bootSecret).update(project).digest("hex");

async function applyAcl(project: string, passwordHash: string) {
  await send("ACL", ["SETUSER", project, "reset", "on", `#${passwordHash}`, `>${internalPassword(project)}`, `~${project}:*`, `&${project}:*`, ...ACL_RULES]);
}

/** Ends the user's open connections so a new password or a removed user takes effect at once. */
async function killClients(project: string) {
  await send("CLIENT", ["KILL", "USER", project]).catch((err) => {
    // "No such user" once the user is gone; nothing to kill.
    if (!isServerError(err)) throw err;
  });
}

// ---- service ----------------------------------------------------------------

interface CacheRow {
  passwordHash: string;
  createdAt: Date;
  rotatedAt: Date;
}

/** Projects with the cache on, so HTTP requests don't query Postgres. */
const enabled = new Set<string>();

async function cacheRow(project: string): Promise<CacheRow> {
  const [row]: CacheRow[] = await sql`
    select password_hash as "passwordHash", created_at as "createdAt", rotated_at as "rotatedAt"
    from mybase.cache_projects where project = ${project}`;
  if (!row) throw new NotFoundError("the cache is not enabled for this project");
  return row;
}

function info(project: string, row: CacheRow): CacheInfo {
  return {
    host: publicHost,
    port: publicPort,
    user: project,
    keyPrefix: `${project}:`,
    url: `redis://${project}@${publicHost}:${publicPort}`,
    httpUrl: `${publicApiUrl}/cache/${project}`,
    enabledAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt.toISOString(),
  };
}

/** Sets a new password (the first one, on enable) and returns it once. */
async function setPassword(project: string, log: Logger): Promise<CacheCredentials> {
  const password = newPassword();
  const passwordHash = hashToken(password);
  // Valkey first: if it's down, nothing changes in Postgres.
  await applyAcl(project, passwordHash);
  await killClients(project);
  dropClient(project);
  await sql`
    insert into mybase.cache_projects (project, password_hash) values (${project}, ${passwordHash})
    on conflict (project) do update set password_hash = excluded.password_hash, rotated_at = now()`;
  enabled.add(project);
  const base = info(project, await cacheRow(project));
  log.info("cache password set");
  return { ...base, password, url: `redis://${project}:${password}@${publicHost}:${publicPort}` };
}

export const cacheService: ServiceModule = {
  id: "cache",
  async enable(project, log) {
    // The one ACL user every Valkey has; a project can't take its name.
    if (project === "default") throw new BadRequestError(`a project named "default" can't use the cache`);
    // Enabling again (a retry) issues a new password: the old one was only shown once.
    return { service: "cache", credentials: await setPassword(project, log) };
  },
  async disable(project, log) {
    dropClient(project);
    const deleted = await unlinkMatching(`${project}:*`);
    await send("ACL", ["DELUSER", project]);
    await killClients(project);
    await sql`delete from mybase.cache_projects where project = ${project}`;
    enabled.delete(project);
    log.info("cache disabled", { keys: deleted });
  },
};

/** Re-creates every project's ACL user. Runs whenever the API (re)connects to Valkey. */
async function restoreCacheUsers(log: Logger) {
  const rows: { project: string; passwordHash: string }[] = await sql`select project, password_hash as "passwordHash" from mybase.cache_projects`;
  for (const { project, passwordHash } of rows) {
    await applyAcl(project, passwordHash);
    enabled.add(project);
  }
  if (rows.length > 0) log.info("cache users restored", { projects: rows.length });
}

const restoreLog = createLogger("cache");
onValkeyConnect(() => restoreCacheUsers(restoreLog).catch((err) => restoreLog.error("restoring cache users failed", { err })));

export const rotatePassword = async (project: string, log: Logger) => {
  await cacheRow(project);
  return setPassword(project, log);
};

// ---- HTTP access for apps ---------------------------------------------------

/**
 * Commands the HTTP endpoint refuses: ones that hold the shared connection (blocking pops,
 * subscriptions), change its state (auth, transactions: use /multi-exec), or close it.
 */
const HTTP_BLOCKED = new Set([
  "subscribe", "psubscribe", "ssubscribe", "unsubscribe", "punsubscribe", "sunsubscribe", "monitor",
  "blpop", "brpop", "blmove", "brpoplpush", "blmpop", "bzpopmin", "bzpopmax", "bzmpop", "xread", "xreadgroup",
  "multi", "exec", "discard", "watch", "unwatch", "auth", "hello", "reset", "quit", "select", "client",
]);

const MAX_COMMANDS = 1000;

/** One connection per project, as that project's user, closed after 5 idle minutes. */
const clients = new Map<string, { client: RedisClient; usedAt: number }>();

function dropClient(project: string) {
  clients.get(project)?.client.close();
  clients.delete(project);
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [project, entry] of clients) if (entry.usedAt < cutoff) dropClient(project);
}, 60_000).unref();

/** Throws NotFoundError unless the project has the cache on. Cached, for HTTP commands. */
export async function requireCache(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.cache_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("the cache is not enabled for this project");
  enabled.add(project);
}

async function projectClient(project: string): Promise<RedisClient> {
  const password = internalPassword(project);
  let entry = clients.get(project);
  // Replace a client that lost its connection (e.g. Valkey restarted): they don't reliably
  // reconnect. Done before sending, never as a retry after, which could run a command twice.
  if (entry && !entry.client.connected) {
    dropClient(project);
    entry = undefined;
  }
  if (!entry) {
    entry = { client: connectAs(project, password), usedAt: Date.now() };
    clients.set(project, entry);
  }
  entry.usedAt = Date.now();
  if (!entry.client.connected) {
    try {
      await entry.client.connect();
    } catch {
      // After a Valkey restart the project's user is back only once the admin connection has
      // reconnected and restored it. Nothing was sent yet, so connecting again is safe.
      dropClient(project);
      await ensureReady();
      entry = { client: connectAs(project, password), usedAt: Date.now() };
      clients.set(project, entry);
      await entry.client.connect().catch(() => Promise.reject(unavailable(entry!.client)));
    }
  }
  return entry.client;
}

/** A command from a request body: a non-empty array of strings and numbers. */
function readCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestError("a command is a non-empty JSON array, e.g. [\"GET\", \"shop:key\"]");
  const args = value.map((v) => {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "boolean") return v ? "1" : "0";
    throw new BadRequestError("command arguments must be strings or numbers");
  });
  if (HTTP_BLOCKED.has(args[0]!.toLowerCase())) throw new BadRequestError(`${args[0]!.toUpperCase()} isn't available over HTTP. Use a Redis client over TCP`);
  return args;
}

/** RESP3 replies as Upstash (RESP2) clients expect them: maps as flat arrays, booleans as 0/1. */
function toWire(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toWire);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, toWire(v)]);
  return String(value);
}

type Reply = { result: unknown } | { error: string };

async function run(client: RedisClient, args: string[]): Promise<Reply> {
  try {
    const [command, ...rest] = args;
    return { result: toWire(await client.send(command!, rest)) };
  } catch (err) {
    if (isServerError(err)) return { error: (err as Error).message };
    throw unavailable(client);
  }
}

/** Drops a client whose connection failed (it doesn't always recover) and says why. */
function unavailable(client: RedisClient) {
  for (const [project, entry] of clients) if (entry.client === client) dropClient(project);
  client.close();
  return new ServiceUnavailableError("the cache server (Valkey) is unavailable");
}

/** One command. A Valkey error (NOPERM, WRONGTYPE) is a reply, not an exception. */
export async function httpCommand(project: string, body: unknown): Promise<Reply> {
  const args = readCommand(body);
  return run(await projectClient(project), args);
}

function readCommands(body: unknown): string[][] {
  if (!Array.isArray(body) || body.length === 0) throw new BadRequestError("expected a JSON array of commands");
  if (body.length > MAX_COMMANDS) throw new BadRequestError(`at most ${MAX_COMMANDS} commands per request`);
  return body.map(readCommand);
}

/** Several commands in one round trip; each gets its own reply. */
export async function httpPipeline(project: string, body: unknown): Promise<Reply[]> {
  const commands = readCommands(body);
  // Bun pipelines these on the one connection and keeps their order.
  const client = await projectClient(project);
  return Promise.all(commands.map((args) => run(client, args)));
}

/**
 * Commands in MULTI/EXEC. On a connection of its own, since the shared one carries other
 * requests' commands, which would land inside this transaction.
 */
export async function httpMultiExec(project: string, body: unknown): Promise<Reply[]> {
  const commands = readCommands(body);
  await ensureReady();
  const client = connectAs(project, internalPassword(project));
  try {
    await client.connect().catch(() => Promise.reject(new ServiceUnavailableError("the cache server (Valkey) is unavailable")));
    await client.send("MULTI", []);
    const queued = await Promise.all(commands.map((args) => run(client, args)));
    const failed = queued.find((r) => "error" in r);
    if (failed) {
      await client.send("DISCARD", []);
      return queued.map((r) => ("error" in r ? r : { error: "EXECABORT transaction discarded because of a previous error" }));
    }
    const results = (await client.send("EXEC", [])) as unknown[] | null;
    if (results === null) return commands.map(() => ({ error: "EXECABORT transaction aborted" }));
    // A command that failed inside EXEC comes back as an Error in its slot.
    return results.map((r) => (r instanceof Error ? { error: r.message } : { result: toWire(r) }));
  } catch (err) {
    if (isServerError(err)) return [{ error: (err as Error).message }];
    throw err;
  } finally {
    client.close();
  }
}

// ---- dashboard --------------------------------------------------------------

/** The dashboard's search (a Valkey glob, default `*`), inside the project's prefix. */
const keyPattern = (project: string, match: string | null) => `${project}:${match && match.trim() ? match.trim() : "*"}`;

async function countKeys(project: string): Promise<number> {
  let cursor = "0";
  let count = 0;
  do {
    const [next, keys] = await send<[string, string[]]>("SCAN", [cursor, "MATCH", `${project}:*`, "COUNT", 1000]);
    cursor = next;
    count += keys.length;
  } while (cursor !== "0");
  return count;
}

/** Connection details without touching Valkey (project context). */
export async function cacheInfo(project: string): Promise<CacheInfo> {
  return info(project, await cacheRow(project));
}

export async function cacheOverview(project: string): Promise<CacheOverview> {
  const row = await cacheRow(project);
  const [keys, memory] = await Promise.all([countKeys(project), memoryInfo()]);
  return { info: info(project, row), keys, memory };
}

const toType = (t: string): CacheKeyType => ((CACHE_KEY_TYPES as readonly string[]).includes(t) ? (t as CacheKeyType) : "other");
const toTtl = (pttl: number) => (pttl >= 0 ? pttl : null);

async function summarize(keys: string[]): Promise<CacheKeySummary[]> {
  return Promise.all(
    keys.map(async (key) => {
      const [type, pttl] = await Promise.all([send<string>("TYPE", [key]), send<number>("PTTL", [key])]);
      return { key, type: toType(type), ttlMs: toTtl(pttl) };
    }),
  );
}

/**
 * One page of keys. SCAN pages can be short or empty before the end, so this keeps
 * scanning until it has `count` keys or the cursor wraps.
 */
export async function listKeys(project: string, cursor: string, match: string | null, count: number): Promise<CacheKeyList> {
  await cacheRow(project);
  if (!/^\d+$/.test(cursor)) throw new BadRequestError("invalid cursor");
  const pattern = keyPattern(project, match);
  const found: string[] = [];
  let next = cursor;
  do {
    const [c, keys] = await send<[string, string[]]>("SCAN", [next, "MATCH", pattern, "COUNT", Math.max(count, 100)]);
    next = c;
    found.push(...keys);
  } while (next !== "0" && found.length < count);
  return { keys: (await summarize(found)).sort((a, b) => a.key.localeCompare(b.key)), cursor: next === "0" ? null : next };
}

/** A key in this project, as given by the dashboard (prefix included). */
function projectKey(project: string, key: string | null): string {
  if (!key || !key.startsWith(`${project}:`)) throw new BadRequestError(`keys must start with "${project}:"`);
  if (key.length > 4096) throw new BadRequestError("key is too long");
  return key;
}

const MAX_ITEMS = 500;
const MAX_STRING = 256 * 1024;

export async function getKey(project: string, rawKey: string | null): Promise<CacheKeyDetail> {
  await cacheRow(project);
  const key = projectKey(project, rawKey);
  const [rawType, pttl] = await Promise.all([send<string>("TYPE", [key]), send<number>("PTTL", [key])]);
  if (rawType === "none") throw new NotFoundError(`no key "${key}"`);
  const base = { key, ttlMs: toTtl(pttl) };
  switch (toType(rawType)) {
    case "string": {
      const size = await send<number>("STRLEN", [key]);
      const value = await send<string>("GETRANGE", [key, 0, MAX_STRING - 1]);
      return { ...base, type: "string", value, size, truncated: size > MAX_STRING };
    }
    case "hash": {
      const size = await send<number>("HLEN", [key]);
      let value: Record<string, string>;
      if (size <= MAX_ITEMS) value = Object.fromEntries(Object.entries((await send<Record<string, string>>("HGETALL", [key])) ?? {}));
      else {
        const [, flat] = await send<[string, string[] | Record<string, string>]>("HSCAN", [key, 0, "COUNT", MAX_ITEMS]);
        value = Array.isArray(flat) ? Object.fromEntries(pairs(flat)) : { ...flat };
      }
      return { ...base, type: "hash", value, size, truncated: size > Object.keys(value).length };
    }
    case "list": {
      const size = await send<number>("LLEN", [key]);
      return { ...base, type: "list", value: await send<string[]>("LRANGE", [key, 0, MAX_ITEMS - 1]), size, truncated: size > MAX_ITEMS };
    }
    case "set": {
      const size = await send<number>("SCARD", [key]);
      const value = size <= MAX_ITEMS ? await send<string[]>("SMEMBERS", [key]) : (await send<[string, string[]]>("SSCAN", [key, 0, "COUNT", MAX_ITEMS]))[1];
      return { ...base, type: "set", value: [...value].sort(), size, truncated: size > value.length };
    }
    case "zset": {
      const size = await send<number>("ZCARD", [key]);
      const raw = await send<unknown[]>("ZRANGE", [key, 0, MAX_ITEMS - 1, "WITHSCORES"]);
      // RESP3: [[member, score], …]; RESP2: [member, score, …].
      const value = Array.isArray(raw[0])
        ? (raw as [string, number | string][]).map(([member, score]) => ({ member, score: Number(score) }))
        : pairs(raw as string[]).map(([member, score]) => ({ member, score: Number(score) }));
      return { ...base, type: "zset", value, size, truncated: size > MAX_ITEMS };
    }
    case "stream": {
      const size = await send<number>("XLEN", [key]);
      const raw = await send<[string, string[] | Record<string, string>][]>("XRANGE", [key, "-", "+", "COUNT", MAX_ITEMS]);
      const value = raw.map(([id, fields]) => ({ id, fields: Array.isArray(fields) ? Object.fromEntries(pairs(fields)) : { ...fields } }));
      return { ...base, type: "stream", value, size, truncated: size > MAX_ITEMS };
    }
    default:
      return { ...base, type: "other", value: null, size: 0, truncated: false };
  }
}

function pairs(flat: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

// Replaces a hash and keeps its expiry, in one step.
const REPLACE_HASH = `
local ttl = redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV))
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`;

function readTtl(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || (value as number) < 1) throw new BadRequestError("ttlMs must be a positive integer, or null for no expiry");
  return value as number;
}

async function applyTtl(key: string, ttlMs: number | null | undefined) {
  if (ttlMs === null) await send("PERSIST", [key]);
  else if (ttlMs !== undefined) await send("PEXPIRE", [key, ttlMs]);
}

/** Writes a string or replaces a hash. Other types are read-only in the dashboard. */
export async function putKey(project: string, rawKey: string | null, body: Record<string, unknown>, log: Logger) {
  await cacheRow(project);
  const key = projectKey(project, rawKey);
  const { type, value } = body as Partial<PutCacheKeyRequest>;
  const ttlMs = readTtl(body.ttlMs);
  if (type === "string") {
    if (typeof value !== "string") throw new BadRequestError("value must be a string");
    await send("SET", [key, value, "KEEPTTL"]);
  } else if (type === "hash") {
    const ok = typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
    if (!ok) throw new BadRequestError("value must map fields to strings");
    const fields = Object.entries(value as Record<string, string>).flat();
    if (fields.length === 0) throw new BadRequestError("a hash needs at least one field");
    // Lua's unpack() takes about 8000 values.
    if (fields.length > 2 * 3000) throw new BadRequestError("at most 3000 fields");
    const current = await send<string>("TYPE", [key]);
    if (current !== "none" && current !== "hash") throw new BadRequestError(`"${key}" is a ${current}, not a hash`);
    await send("EVAL", [REPLACE_HASH, 1, key, ...fields]);
  } else {
    throw new BadRequestError("type must be string or hash");
  }
  await applyTtl(key, ttlMs);
  log.info("cache key written", { type });
  return getKey(project, key);
}

export async function setKeyTtl(project: string, rawKey: string | null, body: Record<string, unknown>) {
  await cacheRow(project);
  const key = projectKey(project, rawKey);
  if (!("ttlMs" in body)) throw new BadRequestError("ttlMs is required (null for no expiry)");
  if ((await send<number>("EXISTS", [key])) === 0) throw new NotFoundError(`no key "${key}"`);
  await applyTtl(key, readTtl(body.ttlMs) ?? null);
  return getKey(project, key);
}

export async function deleteKey(project: string, rawKey: string | null, log: Logger) {
  await cacheRow(project);
  const key = projectKey(project, rawKey);
  if ((await send<number>("UNLINK", [key])) === 0) throw new NotFoundError(`no key "${key}"`);
  log.info("cache key deleted");
}

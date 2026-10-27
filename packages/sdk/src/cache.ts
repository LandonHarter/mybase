// A small HTTP client for a project's mybase cache (Valkey, Redis-compatible), for apps that
// can't open a TCP connection to the mybase machine: serverless hosts, or anything behind the
// Cloudflare Tunnel. On the LAN or Tailscale, any Redis client works directly:
//
//   new Redis("redis://shop:<password>@mybase.local:6379", { keyPrefix: "shop:" })   // ioredis
//
// Every key a project can touch starts with `<project>:`. The helpers here add that prefix
// for you; `command()` sends a raw command and doesn't (prefix keys yourself).
//
// The wire format matches Upstash's REST API, so `@upstash/redis` also works against
// `<apiUrl>/cache/<project>` with a mybase API key as its token (without the auto-prefix).
import { MybaseApiError } from "./cron";

export { MybaseApiError };

export type CacheArg = string | number;

/** One reply per command: Valkey errors don't fail the whole pipeline. */
export type PipelineResult = { result: unknown } | { error: string };

export interface CacheOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `cache:write` for this project. Server-side only. */
  apiKey: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface SetOptions {
  /** Expire after this many seconds. */
  ex?: number;
  /** Expire after this many milliseconds. */
  px?: number;
  /** Only set if the key doesn't exist. */
  nx?: boolean;
  /** Only set if the key exists. */
  xx?: boolean;
}

/** Builds a batch of commands sent in one request. Keys get the project prefix. */
export interface CachePipeline {
  command(args: CacheArg[]): CachePipeline;
  get(key: string): CachePipeline;
  set(key: string, value: CacheArg, options?: SetOptions): CachePipeline;
  del(...keys: string[]): CachePipeline;
  incr(key: string, by?: number): CachePipeline;
  expire(key: string, seconds: number): CachePipeline;
  /** Sends the batch. `atomic: true` wraps it in MULTI/EXEC. */
  exec(options?: { atomic?: boolean }): Promise<PipelineResult[]>;
}

export interface Cache {
  /** `key` with the project prefix, for raw commands. */
  key(key: string): string;
  /** A raw command, e.g. `["ZADD", cache.key("board"), 10, "ana"]`. Keys aren't prefixed. */
  command<T = unknown>(args: CacheArg[]): Promise<T>;
  get(key: string): Promise<string | null>;
  /** JSON.parse of `get`, or null. */
  getJson<T = unknown>(key: string): Promise<T | null>;
  /** `true` when set, `false` when `nx`/`xx` stopped it. */
  set(key: string, value: CacheArg, options?: SetOptions): Promise<boolean>;
  setJson(key: string, value: unknown, options?: SetOptions): Promise<boolean>;
  /** How many keys were deleted. */
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  incr(key: string, by?: number): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  /** Seconds left; -1 with no expiry, -2 when the key doesn't exist. */
  ttl(key: string): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, fields: Record<string, CacheArg>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  lpush(key: string, ...values: CacheArg[]): Promise<number>;
  rpush(key: string, ...values: CacheArg[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  sadd(key: string, ...members: CacheArg[]): Promise<number>;
  srem(key: string, ...members: CacheArg[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: CacheArg): Promise<boolean>;
  zadd(key: string, ...entries: { score: number; member: string }[]): Promise<number>;
  /** Members by rank, lowest score first. `withScores` adds the scores. */
  zrange(key: string, start: number, stop: number, options?: { withScores?: boolean; rev?: boolean }): Promise<string[]>;
  zincrby(key: string, by: number, member: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  pipeline(): CachePipeline;
}

function setArgs(key: string, value: CacheArg, o: SetOptions = {}): CacheArg[] {
  const args: CacheArg[] = ["SET", key, value];
  if (o.ex !== undefined) args.push("EX", o.ex);
  if (o.px !== undefined) args.push("PX", o.px);
  if (o.nx) args.push("NX");
  if (o.xx) args.push("XX");
  return args;
}

/**
 * A cache client over HTTP. Each call is one request; batch with `pipeline()`.
 *
 *   const cache = createCache({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
 *   await cache.set("session:abc", userId, { ex: 3600 });   // key is shop:session:abc
 */
export function createCache(options: CacheOptions): Cache {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/cache/${encodeURIComponent(options.project)}`;
  const prefix = `${options.project}:`;
  const k = (key: string) => (key.startsWith(prefix) ? key : prefix + key);

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data as T;
  }

  async function command<T>(args: CacheArg[]): Promise<T> {
    const data = await post<{ result?: T; error?: string }>("", args);
    if (data.error !== undefined) throw new MybaseApiError(data.error, 400);
    return data.result as T;
  }

  function pipeline(): CachePipeline {
    const commands: CacheArg[][] = [];
    const add = (args: CacheArg[]) => {
      commands.push(args);
      return p;
    };
    const p: CachePipeline = {
      command: add,
      get: (key) => add(["GET", k(key)]),
      set: (key, value, o) => add(setArgs(k(key), value, o)),
      del: (...keys) => add(["DEL", ...keys.map(k)]),
      incr: (key, by = 1) => add(by === 1 ? ["INCR", k(key)] : ["INCRBY", k(key), by]),
      expire: (key, seconds) => add(["EXPIRE", k(key), seconds]),
      exec: ({ atomic = false } = {}) => (commands.length === 0 ? Promise.resolve([]) : post(atomic ? "/multi-exec" : "/pipeline", commands)),
    };
    return p;
  }

  const pairs = (flat: string[]) => {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
    return out;
  };

  return {
    key: k,
    command,
    get: (key) => command(["GET", k(key)]),
    async getJson<T>(key: string) {
      const raw = await command<string | null>(["GET", k(key)]);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    set: async (key, value, o) => (await command<string | null>(setArgs(k(key), value, o))) === "OK",
    setJson: async (key, value, o) => (await command<string | null>(setArgs(k(key), JSON.stringify(value), o))) === "OK",
    del: (...keys) => command(["DEL", ...keys.map(k)]),
    exists: (...keys) => command(["EXISTS", ...keys.map(k)]),
    incr: (key, by = 1) => command(by === 1 ? ["INCR", k(key)] : ["INCRBY", k(key), by]),
    expire: async (key, seconds) => (await command<number>(["EXPIRE", k(key), seconds])) === 1,
    ttl: (key) => command(["TTL", k(key)]),
    mget: (...keys) => command(["MGET", ...keys.map(k)]),
    hget: (key, field) => command(["HGET", k(key), field]),
    hset: (key, fields) => command(["HSET", k(key), ...Object.entries(fields).flat()]),
    hgetall: async (key) => {
      // Upstash-style replies keep RESP2's flat array; the API may also answer with an object.
      const raw = await command<string[] | Record<string, string>>(["HGETALL", k(key)]);
      return Array.isArray(raw) ? pairs(raw) : raw;
    },
    hdel: (key, ...fields) => command(["HDEL", k(key), ...fields]),
    lpush: (key, ...values) => command(["LPUSH", k(key), ...values]),
    rpush: (key, ...values) => command(["RPUSH", k(key), ...values]),
    lrange: (key, start, stop) => command(["LRANGE", k(key), start, stop]),
    sadd: (key, ...members) => command(["SADD", k(key), ...members]),
    srem: (key, ...members) => command(["SREM", k(key), ...members]),
    smembers: (key) => command(["SMEMBERS", k(key)]),
    sismember: async (key, member) => (await command<number>(["SISMEMBER", k(key), member])) === 1,
    zadd: (key, ...entries) => command(["ZADD", k(key), ...entries.flatMap((e) => [e.score, e.member])]),
    zrange: (key, start, stop, o = {}) => command(["ZRANGE", k(key), start, stop, ...(o.rev ? ["REV"] : []), ...(o.withScores ? ["WITHSCORES"] : [])]),
    zincrby: async (key, by, member) => Number(await command<string | number>(["ZINCRBY", k(key), by, member])),
    publish: (channel, message) => command(["PUBLISH", k(channel), message]),
    pipeline,
  };
}

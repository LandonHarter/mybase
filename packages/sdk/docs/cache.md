# Cache

A project's cache is a Redis-compatible key-value store (Valkey), kept in memory. Use it for sessions, cached query results, counters, and locks: anything you can lose and rebuild. It isn't a database.

Turn it on from the project's page or with `mybase cache enable <project>`. You get a password for Redis clients over TCP once; it isn't stored. Lost it? Rotate it from the Cache page (`mybase cache password <project> --rotate`). Over HTTP, apps use a mybase API key with `cache:write` instead.

## Keys and isolation

Every project has its own Valkey user, which can only touch keys and channels starting with `<project>:`. A key outside the prefix fails with `NOPERM`. Commands that would see other projects (`SCAN`, `KEYS`, `FLUSHALL`, `CONFIG`, `SELECT`, …) are blocked, so keep track of your own keys, e.g. in a set.

## Over TCP (LAN or Tailscale)

The fastest way in, with any Redis client. Set the key prefix so the client adds it for you.

```ts
import Redis from "ioredis";

const redis = new Redis(process.env.MYBASE_CACHE_URL!, { keyPrefix: "shop:" });
// MYBASE_CACHE_URL=redis://shop:<password>@mybase.local:6379

await redis.set("session:abc", userId, "EX", 3600); // stored as shop:session:abc
```

Bun's built-in client works too: `new RedisClient(process.env.MYBASE_CACHE_URL)`. It has no prefix option, so write keys with the prefix yourself.

## Over HTTP (anywhere)

Serverless hosts and anything outside your network can't reach the Valkey port, but they can reach the mybase API (through a Cloudflare Tunnel, for example). `@mybase-dev/sdk/cache` talks to it and adds the prefix:

```ts
import { createCache } from "@mybase-dev/sdk/cache";

const cache = createCache({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!, // cache:write for this project; server-side only
});

await cache.set("session:abc", userId, { ex: 3600 });
const user = await cache.get("session:abc");
await cache.setJson("product:42", product, { ex: 300 });
const views = await cache.incr("views:home");

// Several commands in one request; atomic: true wraps them in MULTI/EXEC.
await cache.pipeline().incr("hits").expire("hits", 60).exec();

// Anything else, raw (prefix keys yourself):
await cache.command(["ZADD", cache.key("board"), 10, "ana"]);
```

Each call is one HTTP request, so it's slower than TCP: batch with `pipeline()`. Blocking commands (`BLPOP`, `XREAD … BLOCK`) and pub/sub subscriptions need TCP.

The endpoint speaks Upstash's REST format, so `@upstash/redis` works too: `new Redis({ url: "https://mybase.example.com/cache/shop", token: password })`. It doesn't add the prefix.

## Memory and persistence

- The cache server is shared by every project and capped at 64 MB by default (`CACHE_MAXMEMORY` in `.env`). When it's full, the least recently used keys are evicted, from any project. Set expiries on what you cache.
- Data is snapshotted to disk at most every 15 minutes and on shutdown, to spare SD cards. A crash can lose the last few minutes of writes.
- Turning the cache off deletes every key in the project.

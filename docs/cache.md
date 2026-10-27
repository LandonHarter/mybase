---
title: Cache
summary: A Redis-compatible keyspace per project, over TCP with any Redis client or over HTTP with an API key.
section: Services
order: 14
---

# Cache

Valkey (Redis-compatible), shared by all projects, with an ACL user per project limited to keys starting with `<project>:`.

```sh
mybase cache enable shop     # prints the password (TCP only) once
mybase cache info shop
```

- **TCP** (LAN/Tailscale), any Redis client: `new Redis("redis://shop:<password>@<host>:6379", { keyPrefix: "shop:" })`.
- **HTTP** (anywhere): `createCache` from `@mybase/sdk/cache` or `@upstash/redis`, with an API key that has `cache:write`, at `{{MYBASE_URL}}/cache/<project>`.

Memory is capped (64 MB by default, whole server) with LRU eviction, and snapshots are saved at most every 15 minutes: treat it as a cache, not a database. Guide: [SDK cache](sdk/cache.md).

## Agent notes

- Every key must start with `<project>:`; others get `NOPERM`.
- Commands that list or count other projects' keys (`KEYS`, `SCAN`, `DBSIZE`, `PUBSUB CHANNELS`) are refused. Over HTTP, blocking, subscribe, and `MULTI` are refused too (use `/multi-exec`).
- The password can't be shown again: `mybase cache password <project> --rotate` replaces it.

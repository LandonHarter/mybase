---
title: Rate limits
summary: Shared rate limits (sliding window, fixed window, token bucket) that every instance of your app checks.
section: Services
order: 15
---

# Rate limits

Named rules (or inline limits) that every instance of your app checks through mybase, so limits hold across servers.

```sh
mybase ratelimit enable shop
mybase ratelimit create shop login --limit 5 --window 1m
mybase ratelimit stats shop
```

In apps: `createRateLimiter` from `@mybase/sdk/ratelimit` with an API key that has `ratelimit:write`, then `await limiter.limit("login", ip)`. Algorithms: `sliding` (default), `fixed`, `token` (with `burst`). Rules can live in `mybase.config.ts` (`mybase ratelimit sync`). Guide: [SDK rate limits](sdk/rate-limits.md).

## Agent notes

- The SDK fails open (allows) on network errors unless `failClosed` is set.
- Counters live in the cache server; eviction under memory pressure can reset a count early.

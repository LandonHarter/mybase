# Rate limits

Limit how often a user, IP, or API key can do something: sign in, send an email, call your API. mybase keeps the counts, so every instance of your app (and every serverless invocation) shares one limit.

Turn rate limits on from the project's page or with `mybase ratelimit enable <project>`. Your server authenticates with a mybase API key that has `ratelimit:write` for the project. Create one in Settings → API keys (or from this service's page), or with `mybase token create shop-app --project shop --perm ratelimit:write`. Keep it server-side, as `MYBASE_API_KEY`. One key can cover several services: `--perm queue:write,ratelimit:write,cron:write`.

## Check a limit

```ts
import { createRateLimiter, rateLimitHeaders } from "@mybase-dev/sdk/ratelimit";

const limiter = createRateLimiter({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!,
});

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const result = await limiter.limit("login", ip);
  if (!result.success) {
    return new Response("Too many attempts", { status: 429, headers: rateLimitHeaders(result) });
  }
  // … sign in
}
```

`limit(rule, id)` counts one request for `id`. Pass `{ cost: 5 }` to count more. The result has `success`, `limit`, `remaining`, and `reset` (unix ms). `rateLimitHeaders` turns it into `RateLimit-*` and `Retry-After` headers.

## Rules

A rule is a named limit: 5 per minute, 100 per hour. Create rules on the project's Rate limits page, or declare them in code and sync them, like cron jobs:

```ts
// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  ratelimit: {
    rules: {
      login: { limit: 5, window: "1m" },
      api: { algorithm: "token", limit: 100, window: "1m", burst: 200 },
    },
  },
});
```

```sh
mybase ratelimit sync --dry-run   # show what would change
mybase ratelimit sync             # create, update, and delete code-defined rules to match
```

Changing a rule takes effect on the next check, with no redeploy. Rules made on the dashboard are never touched by a sync.

### Inline limits

For a one-off limit, skip the rule and pass it inline. Calls with the same settings share counts:

```ts
await limiter.limit({ limit: 10, window: "1h" }, `export:${userId}`);
```

## Algorithms

| Algorithm | Behaviour |
| --- | --- |
| `sliding` (default) | Counts requests over the last window as it moves. Smooth; a good default. |
| `fixed` | A counter that resets every window. Simplest; up to twice the limit can pass around a reset. |
| `token` | A bucket of `burst` tokens (default `limit`), refilled at `limit` per `window`. Allows short bursts. |

Windows are milliseconds or `"30s"`, `"1m"`, `"1h"`, `"1d"`, from 1 second to 30 days.

## When mybase is unreachable

If the API can't be reached, times out (1 s by default, `timeoutMs`), or answers 5xx, the limiter **allows** the request, so an outage doesn't take your app down too. Pass `failClosed: true` for routes where letting traffic through is worse, like sign-in. `onError` hears about each failure. A 4xx (wrong key, unknown rule, bad input) throws `MybaseApiError`: those are bugs, not outages.

## Other languages

`POST /ratelimit/<project>/limit` with `Authorization: Bearer <API key>` and a JSON body:

```json
{ "rule": "login", "id": "203.0.113.7" }
{ "limit": 10, "windowMs": 3600000, "algorithm": "sliding", "id": "user:42", "cost": 1 }
```

The answer is `{ "success": true, "limit": 5, "remaining": 4, "reset": 1767225600000 }`.

Counts live in mybase's cache server. Under memory pressure they can be evicted, which resets that count early.

# @mybase/sdk

Helpers for apps that run on [mybase](https://github.com/landonharter/mybase), a self-hosted backend.

```sh
npm install @mybase/sdk   # or bun add / pnpm add
```

No runtime dependencies. Uses Web Crypto, so it works in Node 20+, Bun, Deno, Next.js route handlers, Hono, and edge runtimes.

## Analytics (`@mybase/sdk/analytics`)

Page views, custom events, and errors, shown on the project's Analytics page. Turn analytics on for the project (dashboard, or `mybase analytics enable <project>`) to get its public write key, then:

```ts
import { createAnalytics } from "@mybase/sdk/analytics";

const analytics = createAnalytics({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  key: "mba_…", // public: fine in browser code, it can only add events
});

analytics.track("signup", { plan: "pro" });
analytics.captureError(err);
```

In a browser it records page views (including History API route changes) and uncaught errors on its own, batches events, and sends them with `sendBeacon` when the page is hidden. On a server, call `await analytics.flush()` before exiting. No cookies; visitors are counted with a daily-rotating hash and IPs are never stored.

Plain HTML sites can use the script tag mybase serves instead:

```html
<script defer src="https://mybase.example.com/analytics.js" data-project="shop" data-key="mba_…"></script>
<script>mybase.track("signup", { plan: "pro" })</script>
```

Full guide: [docs/analytics.md](docs/analytics.md). Wire format and admin routes: [docs/analytics-api.md](docs/analytics-api.md).

## Cache (`@mybase/sdk/cache`)

A Redis-compatible cache per project. Turn it on (dashboard, or `mybase cache enable <project>`) to get its password. On the LAN, use any Redis client with `keyPrefix: "<project>:"`. From anywhere else, over HTTP with an API key (`cache:write`):

```ts
import { createCache } from "@mybase/sdk/cache";

const cache = createCache({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
await cache.set("session:abc", userId, { ex: 3600 }); // key: shop:session:abc
```

Full guide: [docs/cache.md](docs/cache.md).

## Rate limits (`@mybase/sdk/ratelimit`)

Limits shared by every instance of your app. Turn them on (dashboard, or `mybase ratelimit enable <project>`), create an API key with `ratelimit:write`, define rules on the dashboard or in `mybase.config.ts`, then:

```ts
import { createRateLimiter, rateLimitHeaders } from "@mybase/sdk/ratelimit";

const limiter = createRateLimiter({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const result = await limiter.limit("login", ip); // or limiter.limit({ limit: 10, window: "1m" }, ip)
if (!result.success) return new Response("Too many requests", { status: 429, headers: rateLimitHeaders(result) });
```

If mybase can't be reached, it allows the request (pass `failClosed: true` to deny instead). Full guide: [docs/rate-limits.md](docs/rate-limits.md).

## Queues (`@mybase/sdk/queue`)

SQS-style standard and FIFO queues. Turn them on (dashboard, or `mybase queue enable <project>`), create an API key with `queue:write`, then:

```ts
import { createQueueClient } from "@mybase/sdk/queue";

const queue = createQueueClient({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
await queue.send("emails", { to: "ada@example.com" });
queue.consume("emails", async (message) => sendEmail(message.json()));
```

Delivery is at least once; failed messages are retried and can go to a dead-letter queue. Full guide: [docs/queues.md](docs/queues.md).

## Cron (`@mybase/sdk/cron`)

A mybase cron job POSTs to a URL in your app on a schedule. Each call is signed with your project's cron secret. You can find it on the project's Cron page, or get it with `mybase cron secret <project>`. Set it as `MYBASE_CRON_SECRET`, then use the handler, which checks the signature and runs the job by name:

```ts
// app/api/cron/route.ts (Next.js); any framework that takes (Request) => Response works the same
import { cronHandler } from "@mybase/sdk/cron";

export const POST = cronHandler({
  secret: process.env.MYBASE_CRON_SECRET!,
  jobs: {
    cleanup: async (run) => {
      // run.payload: the job's JSON payload
      // run.runId:   same across retries, so you can dedupe
      // run.attempt: 1, then 2, 3, … on retries
    },
  },
});
```

Responses: `200` when the job finishes, `401` for a bad or stale signature, `404` for a job with no handler, `500` if the job throws. mybase retries timeouts, `429`, and `5xx` (2 retries by default). It doesn't retry other `4xx` responses.

**Rotating the secret:** pass both secrets, new first, while you deploy: `secret: [process.env.MYBASE_CRON_SECRET!, process.env.MYBASE_CRON_SECRET_OLD!]`.

### Lower level

```ts
import { verifyCronRequest, verifyCronSignature, CronVerificationError } from "@mybase/sdk/cron";

// Fetch API Request: verifies, then returns the parsed CronRun. Throws CronVerificationError.
const run = await verifyCronRequest(request, process.env.MYBASE_CRON_SECRET!);

// Raw body + header (e.g. Express with express.text({ type: "application/json" })):
await verifyCronSignature({ body: req.body, signature: req.get("X-Mybase-Signature"), secret });
```

### Define jobs in code

Declare jobs next to your app and push them with the mybase CLI. Keep this file free of app code: the CLI imports only this file.

```ts
// mybase.config.ts
import { defineConfig } from "@mybase/sdk/config";

export default defineConfig({
  project: "shop",
  cron: {
    baseUrl: "https://shop.example.com", // must be reachable from the mybase server
    jobs: {
      cleanup: { schedule: "0 3 * * *" }, // POSTs to baseUrl + /api/cron
      digest: { schedule: "0 8 * * 1", timezone: "America/Chicago", path: "/api/cron", payload: { kind: "weekly" } },
    },
  },
});
```

```sh
mybase cron sync --dry-run   # show what would change
mybase cron sync             # create, update, and delete code-defined jobs to match
```

Jobs created in the dashboard are never touched by a sync. For typed job names in the handler, pass the config type: `cronHandler<typeof config>({ ... })`.

Job options: `schedule` (5-field cron, minute precision), `path` (default `/api/cron`), `timezone` (IANA, default `UTC`), `payload` (JSON, up to 16 KB), `retries` (0–5, default 2), `timeoutMs` (1000–120000, default 30000).

### One-off tasks

Schedule a single call to a handler from your app code, e.g. a reminder a day after an order. The task calls the same `cronHandler` as cron jobs: `run.job` is the name you pass, `run.trigger` is `"task"`, and `run.runId` is the task id.

```ts
import { createCronClient } from "@mybase/sdk/cron";

const cron = createCronClient({
  apiUrl: process.env.MYBASE_URL!,           // the mybase API, as reachable from your app
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!,       // a mybase API key with cron:write; server-side only
  baseUrl: "https://shop.example.com",       // your app, as reachable from mybase
});

const task = await cron.schedule("send-reminder", {
  in: "24h",                       // or at: new Date("2026-12-01T09:00:00Z"); neither = as soon as possible
  payload: { orderId: 42 },
  key: "reminder-42",              // optional dedupe key, see below
});

await cron.get(task.id);           // CronTask, or null
await cron.cancelByKey("reminder-42"); // or cron.cancel(task.id); only pending tasks
```

```ts
// the handler, next to your cron jobs
export const POST = cronHandler({
  secret: process.env.MYBASE_CRON_SECRET!,
  jobs: {
    "send-reminder": async (run) => {
      // run.payload: { orderId: 42 }, run.key: "reminder-42"
    },
  },
});
```

- **Delays:** milliseconds, or `"30s"`, `"15m"`, `"2h"`, `"7d"`. Up to a year out. Measured by the mybase server's clock.
- **Keys:** while a task with a key is pending or running, scheduling the same key returns that task instead of a new one. After it finishes, the key is free again.
- **Durable:** tasks live in Postgres. One that comes due while mybase is down runs when it's back; one interrupted mid-call runs again. Calls are at least once, so dedupe on `run.runId` if it matters.
- **Retries and timeouts** work like jobs: `retries` (0–5, default 2), `timeoutMs` (1000–120000, default 30000). `path` (default `/api/cron`) is appended to `baseUrl`; `url` overrides both.
- Finished and cancelled tasks are kept for 7 days. A project can have 10,000 pending tasks.
- Errors from the API throw `MybaseApiError` (with `status`); `get`/`cancel` resolve to `null` for an unknown task.

The client sends an API key with `cron:write` (not an admin one) as `Authorization: Bearer`.

### Signature format

For verifying in other languages:

```
X-Mybase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Reject the call if `t` is more than 5 minutes from now, then compare `v1` in constant time. The body is JSON:

```json
{ "job": "cleanup", "runId": "…", "attempt": 1, "trigger": "schedule", "scheduledAt": "…", "firedAt": "…", "payload": null }
```

`X-Mybase-Job` and `X-Mybase-Run` headers carry the job name and run id too. Task calls add `"key"`, and `trigger` is `"task"`.

Requests from your app to the mybase API (`createCronClient`) carry an API key as `Authorization: Bearer`. Routes: `POST /cron/<project>/tasks`, `GET|DELETE /cron/<project>/tasks/<id>`, `GET|DELETE /cron/<project>/tasks/by-key/<key>`.

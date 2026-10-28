# @mybase-dev/sdk

Helpers for apps that run on [mybase](https://github.com/LandonHarter/mybase), a self-hosted backend.

```sh
npm install @mybase-dev/sdk   # or bun add / pnpm add
```

No runtime dependencies. Uses Web Crypto, so it works in Node 20+, Bun, Deno, Next.js route handlers, Hono, and edge runtimes.

| Import | Use |
| --- | --- |
| `@mybase-dev/sdk/analytics` | Record page views, custom events, and errors |
| `@mybase-dev/sdk/cache` | Read and write the project's cache over HTTP |
| `@mybase-dev/sdk/ratelimit` | Check rate limits |
| `@mybase-dev/sdk/queue` | Send, receive, and consume queue messages |
| `@mybase-dev/sdk/search` | Search the web and read pages, plus tools for LLM agents |
| `@mybase-dev/sdk/vector` | Vector, full-text, and hybrid search over documents |
| `@mybase-dev/sdk/cron` | Verify cron calls, handle jobs, and schedule one-off tasks |
| `@mybase-dev/sdk/better-auth` | Better Auth on mybase: database URL, session storage, audit plugin, captcha |
| `@mybase-dev/sdk/captcha` | Solve captcha challenges in the browser, verify tokens on the server |
| `@mybase-dev/sdk/config` | Declare cron jobs, rate limit rules, queues, and vector indexes in `mybase.config.ts` |

## API keys

Cache, rate limits, queues, and one-off tasks authenticate with a mybase API key (`mb_…`). Each key has per-service permissions (`cache:write`, `ratelimit:write`, `queue:write`, `cron:write`, … or `admin`) and can be limited to some projects, so one key can cover everything an app uses. Create one in the dashboard (Settings → API keys) or with the CLI:

```sh
mybase token create shop-app --project shop --perm cache:write,ratelimit:write,queue:write,cron:write
```

Put it in your app's server-side environment as `MYBASE_API_KEY`. Never expose it to browser code: analytics has its own public write key for that.

Getting started guide: [docs/getting-started.md](docs/getting-started.md). Your mybase instance also serves every guide at `/docs` and `/llms.txt`.

## Analytics (`@mybase-dev/sdk/analytics`)

Page views, custom events, and errors, shown on the project's Analytics page. Turn analytics on for the project (dashboard, or `mybase analytics enable <project>`) to get its public write key, then:

```ts
import { createAnalytics } from "@mybase-dev/sdk/analytics";

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

## Cache (`@mybase-dev/sdk/cache`)

A Redis-compatible cache per project. Turn it on (dashboard, or `mybase cache enable <project>`) to get its password. On the LAN, use any Redis client with `keyPrefix: "<project>:"`. From anywhere else, over HTTP with an API key (`cache:write`):

```ts
import { createCache } from "@mybase-dev/sdk/cache";

const cache = createCache({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
await cache.set("session:abc", userId, { ex: 3600 }); // key: shop:session:abc
```

Full guide: [docs/cache.md](docs/cache.md).

## Rate limits (`@mybase-dev/sdk/ratelimit`)

Limits shared by every instance of your app. Turn them on (dashboard, or `mybase ratelimit enable <project>`), use an API key with `ratelimit:write`, define rules on the dashboard or in [`mybase.config.ts`](#define-jobs-rules-and-queues-in-code), then:

```ts
import { createRateLimiter, rateLimitHeaders } from "@mybase-dev/sdk/ratelimit";

const limiter = createRateLimiter({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const result = await limiter.limit("login", ip); // or limiter.limit({ limit: 10, window: "1m" }, ip)
if (!result.success) return new Response("Too many requests", { status: 429, headers: rateLimitHeaders(result) });
```

If mybase can't be reached, it allows the request (pass `failClosed: true` to deny instead). Full guide: [docs/rate-limits.md](docs/rate-limits.md).

## Queues (`@mybase-dev/sdk/queue`)

SQS-style standard and FIFO queues. Turn them on (dashboard, or `mybase queue enable <project>`), use an API key with `queue:write`, create queues on the dashboard, in [`mybase.config.ts`](#define-jobs-rules-and-queues-in-code), or with `queue.createQueue(...)`, then:

```ts
import { createQueueClient } from "@mybase-dev/sdk/queue";

const queue = createQueueClient({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
await queue.send("emails", { to: "ada@example.com" });
queue.consume("emails", async (message) => sendEmail(message.json()));
```

Delivery is at least once; `consume` deletes a message when its handler resolves, failed messages are retried and can go to a dead-letter queue. Full guide: [docs/queues.md](docs/queues.md).

## Web search (`@mybase-dev/sdk/search`)

Web search and page reading for your app's AI agent, through mybase's own SearXNG (no search API to pay for). Turn it on (dashboard, or `mybase search enable <project>`), use an API key with `search:read`, then:

```ts
import { createSearchClient, searchTools } from "@mybase-dev/sdk/search";

const web = createSearchClient({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const { results } = await web.search("bun sql postgres");
const page = await web.fetch(results[0]!.url); // main content as markdown
const tools = searchTools(web); // web_search + web_fetch for an LLM tool-use loop
```

Full guide: [docs/search.md](docs/search.md).

## Vector search (`@mybase-dev/sdk/vector`)

Index documents and search them by meaning (pgvector), keywords (Postgres full-text search), or both (hybrid). They live in your project's own database. Turn it on (dashboard, or `mybase vector enable <project>`), use an API key with `vector:write` (`vector:read` to only search), then:

```ts
import { createVectorClient, retrievalTool } from "@mybase-dev/sdk/vector";

const vector = createVectorClient({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const docs = vector.index<{ lang: string }>("docs");
await docs.upsert([{ id: "faq-1", title: "Reset your password", text: "…", metadata: { lang: "en" } }]);
const { matches } = await docs.query("forgot my password", { topK: 5, filter: { lang: "en" } });
const tool = retrievalTool(docs, { about: "the help center" }); // for an LLM tool-use loop
```

Send your own vectors, or set an embedding model for the project (any OpenAI-compatible endpoint) and mybase embeds text for you. Full guide: [docs/vector.md](docs/vector.md).

## Better Auth (`@mybase-dev/sdk/better-auth`)

Sign your app's users in with [Better Auth](https://better-auth.com), backed by mybase. Turn on the users service (`mybase users enable <project>`) and the cache, use an API key with `users:write` and `cache:write`, then:

```ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { createCache } from "@mybase-dev/sdk/cache";
import { authDatabaseUrl, mybaseAuth, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";

const mybase = { apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! };
export const auth = betterAuth({
  database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }), // tables in the "auth" schema
  secondaryStorage: mybaseSecondaryStorage(createCache(mybase)), // sessions in the mybase cache
  session: { storeSessionInDatabase: true }, // so the dashboard can list and revoke them
  emailAndPassword: { enabled: true },
  plugins: [mybaseAuth(mybase)], // sign-ins in the audit log
});
```

No dependency on Better Auth itself. Full guide: [docs/better-auth.md](docs/better-auth.md).

## Captcha (`@mybase-dev/sdk/captcha`)

Self-hosted, proof-of-work bot checks: no puzzles, cookies, or third party. Turn it on (`mybase captcha enable <project>`), solve in the browser, verify on the server with an API key that has `captcha:write`:

```ts
import { createCaptchaClient, solveCaptcha } from "@mybase-dev/sdk/captcha";

const token = await solveCaptcha({ apiUrl: "https://mybase.example.com", project: "shop" }); // browser
const { success } = await createCaptchaClient({ apiUrl, project: "shop", apiKey }).verify(token); // server
```

Or the script tag `<script defer src="https://mybase.example.com/captcha.js" data-project="shop">` on forms marked `data-mybase-captcha`. With Better Auth: `captcha(mybaseCaptcha({ …, secretKey }))`. Full guide: [docs/captcha.md](docs/captcha.md).

## Cron (`@mybase-dev/sdk/cron`)

A mybase cron job POSTs to a URL in your app on a schedule. Each call is signed with your project's cron secret. You can find it on the project's Cron page, or get it with `mybase cron secret <project>`. Set it as `MYBASE_CRON_SECRET`, then use the handler, which checks the signature and runs the job by name:

```ts
// app/api/cron/route.ts (Next.js); any framework that takes (Request) => Response works the same
import { cronHandler } from "@mybase-dev/sdk/cron";

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

Full guide: [docs/cron-handler.md](docs/cron-handler.md). Jobs are created on the dashboard, with `mybase cron create`, or [in code](#define-jobs-rules-and-queues-in-code).

### Lower level

```ts
import { verifyCronRequest, verifyCronSignature, CronVerificationError } from "@mybase-dev/sdk/cron";

// Fetch API Request: verifies, then returns the parsed CronRun. Throws CronVerificationError.
const run = await verifyCronRequest(request, process.env.MYBASE_CRON_SECRET!);

// Raw body + header (e.g. Express with express.text({ type: "application/json" })):
await verifyCronSignature({ body: req.body, signature: req.get("X-Mybase-Signature"), secret });
```

### One-off tasks

Schedule a single call to a handler from your app code, e.g. a reminder a day after an order. The task calls the same `cronHandler` as cron jobs: `run.job` is the name you pass, `run.trigger` is `"task"`, and `run.runId` is the task id.

```ts
import { createCronClient } from "@mybase-dev/sdk/cron";

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

The client sends an API key with `cron:write` (not an admin one) as `Authorization: Bearer`. Full guide: [docs/one-off-tasks.md](docs/one-off-tasks.md).

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

Full reference: [docs/signatures.md](docs/signatures.md).

## Define jobs, rules, and queues in code

Declare cron jobs, rate limit rules, and queues next to your app and push them with the mybase CLI. Keep this file free of app code: the CLI imports only this file.

```ts
// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  cron: {
    baseUrl: "https://shop.example.com", // must be reachable from the mybase server
    jobs: {
      cleanup: { schedule: "0 3 * * *" }, // POSTs to baseUrl + /api/cron
      digest: { schedule: "0 8 * * 1", timezone: "America/Chicago", path: "/api/cron", payload: { kind: "weekly" } },
    },
  },
  ratelimit: {
    rules: {
      login: { limit: 5, window: "1m" },
      api: { algorithm: "token", limit: 100, window: "1m", burst: 200 },
    },
  },
  queue: {
    queues: {
      "emails-dlq": {},
      emails: { visibilityTimeout: "2m", deadLetter: { queue: "emails-dlq", maxReceives: 5 } },
    },
  },
});
```

```sh
mybase cron sync --dry-run   # show what would change
mybase cron sync             # create, update, and delete code-defined jobs to match
mybase ratelimit sync        # same for rate limit rules
mybase queue sync            # same for queues (asks before deleting a queue: its messages go too)
```

Each sync only touches what came from code; jobs, rules, and queues created on the dashboard are left alone. For typed job names in the handler, pass the config type: `cronHandler<typeof config>({ ... })`.

- **Job options:** `schedule` (5-field cron, minute precision), `path` (default `/api/cron`), `timezone` (IANA, default `UTC`), `payload` (JSON, up to 16 KB), `retries` (0–5, default 2), `timeoutMs` (1000–120000, default 30000).
- **Rule options:** `algorithm` (`sliding` default, `fixed`, `token`), `limit`, `window` (ms or `"10s"`, `"1m"`, `"1h"`, `"1d"`; 1s–30d), `burst` (token bucket only).
- **Queue options:** `fifo` (fixed at creation), `visibilityTimeout` (default 30s), `delay`, `retention` (default 4d), `receiveWait`, `maxMessageBytes`, `contentDedup` (FIFO), `deadLetter` (`{ queue, maxReceives }`).

Full guide: [docs/jobs-in-code.md](docs/jobs-in-code.md).

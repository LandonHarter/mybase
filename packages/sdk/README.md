# @mybase/sdk

Helpers for apps that run on [mybase](https://github.com/landonharter/mybase), a self-hosted backend.

```sh
npm install @mybase/sdk   # or bun add / pnpm add
```

No runtime dependencies. Uses Web Crypto, so it works in Node 20+, Bun, Deno, Next.js route handlers, Hono, and edge runtimes.

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

### Signature format

For verifying in other languages:

```
X-Mybase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Reject the call if `t` is more than 5 minutes from now, then compare `v1` in constant time. The body is JSON:

```json
{ "job": "cleanup", "runId": "…", "attempt": 1, "trigger": "schedule", "scheduledAt": "…", "firedAt": "…", "payload": null }
```

`X-Mybase-Job` and `X-Mybase-Run` headers carry the job name and run id too.

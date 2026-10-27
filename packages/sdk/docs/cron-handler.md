# Handling cron calls

Create a server-side endpoint and pass incoming Fetch API `Request` objects to `cronHandler`. The handler verifies `X-Mybase-Signature` with your project's cron secret, then dispatches by job name.

## Add the handler

```ts
// app/api/cron/route.ts (Next.js route handler)
import { cronHandler } from "@mybase-dev/sdk/cron";

export const POST = cronHandler({
  secret: process.env.MYBASE_CRON_SECRET!,
  jobs: {
    cleanup: async (run) => {
      // run.payload: JSON configured for the job
      // run.runId: stable across retries; use to dedupe side effects
      // run.attempt: 1 on first attempt, then 2, 3, ...
    },
  },
});
```

Any framework that accepts `(Request) => Response` can use the returned handler. Configure the job URL to point to this endpoint. `run.trigger` is `"schedule"`, `"manual"`, or `"task"`; one-off tasks use the same handler.

## Responses and retries

The handler returns `200` when done, `401` for an invalid or stale signature, `404` for an unknown job, and `500` when a job throws. mybase retries network failures, timeouts, `429`, and `5xx` responses (two retries by default). Calls are at least once: dedupe on `run.runId` when repeated work matters.

## Rotate your secret

Deploy a handler accepting both secrets before switching mybase to the new one. Pass the new secret first:

```ts
secret: [process.env.MYBASE_CRON_SECRET!, process.env.MYBASE_CRON_SECRET_OLD!]
```

Once old calls are finished, remove the old secret. See [signatures and verification](signatures.md) for lower-level helpers.

# One-off tasks

Schedule a single signed call from your app's server-side code with `createCronClient`. This uses the same cron secret and endpoint as [scheduled jobs](cron-handler.md); no admin API token goes into your app.

## Schedule a task

```ts
import { createCronClient } from "@mybase/sdk/cron";

const cron = createCronClient({
  apiUrl: process.env.MYBASE_URL!,        // mybase, reachable from your app
  project: "shop",
  secret: process.env.MYBASE_CRON_SECRET!,
  baseUrl: "https://shop.example.com",    // your app, reachable from mybase
});

const task = await cron.schedule("send-reminder", {
  in: "24h",
  payload: { orderId: 42 },
  key: "reminder-42",
});

await cron.get(task.id);                 // task, or null if not found
await cron.getByKey("reminder-42");
await cron.cancelByKey("reminder-42"); // only pending tasks can be cancelled
```

## Handle the call

Add a `"send-reminder"` job to your `cronHandler`'s `jobs` map. Its `run.trigger` is `"task"`, `run.runId` is the task ID, and `run.key` is the optional dedupe key.

## Scheduling and delivery

- `in` accepts milliseconds or `"30s"`, `"15m"`, `"2h"`, `"7d"`; `at` accepts a date or date string. Omit both to run as soon as possible. You cannot pass both.
- `key` deduplicates while a task is pending or running. After it finishes, the key is free again.
- `path` defaults to `/api/cron` and appends to `baseUrl`; `url` overrides both. Set `retries` (0–5) and `timeoutMs` (1000–120000) per task if needed.
- Tasks persist in Postgres. Due tasks run when mybase restarts; interrupted tasks can run again. Dedupe on `run.runId` for non-repeatable side effects.
- `get`, `getByKey`, `cancel`, and `cancelByKey` return `null` for unknown tasks. Cancelling an already-run task throws `MybaseApiError` with `status: 409`.

Finished and cancelled tasks remain for seven days. Each project can have up to 10,000 pending tasks. Keep the cron secret server-side.

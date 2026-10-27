# Queues

Hand work off to background workers: your app sends a message, a worker receives it, handles it, and deletes it. Messages that fail are delivered again, and after too many failures they can be set aside in a dead-letter queue. The model is Amazon SQS: standard and FIFO queues, visibility timeouts, long polling, delays, and batches. Messages live in mybase's Postgres, so they survive restarts.

Turn queues on from the project's page or with `mybase queue enable <project>`. Your server authenticates with a mybase API key that has `queue:write` for the project. Create one in Settings → API keys (or from this service's page), or with `mybase token create shop-app --project shop --perm queue:write`. Keep it server-side, as `MYBASE_API_KEY`. One key can cover several services: `--perm queue:write,ratelimit:write,cron:write`. (`queue:read` is enough to list and get queues.)

## Send and consume

```ts
import { createQueueClient } from "@mybase-dev/sdk/queue";

const queue = createQueueClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!,
});

// In a route: strings go as is, anything else as JSON.
await queue.send("emails", { to: "ada@example.com", template: "welcome" });

// In a worker process:
const worker = queue.consume("emails", async (message) => {
  const { to, template } = message.json<{ to: string; template: string }>();
  await sendEmail(to, template);
});

process.on("SIGTERM", () => worker.stop());
```

`consume` long-polls for up to 10 messages at a time, runs your handler for each, and deletes the ones whose handler resolved. A handler that throws leaves its message in the queue: it's delivered again once its visibility timeout runs out (or after `retryDelay`, if set). `stop()` stops receiving, waits for running handlers, and deletes what they finished.

| Option | Default | |
| --- | --- | --- |
| `batchSize` | `10` | Messages per receive, 1–100 |
| `concurrency` | `batchSize` | Handlers running at once |
| `wait` | `"20s"` | Long poll per receive |
| `visibilityTimeout` | the queue's | Set it longer than your slowest handler |
| `retryDelay` | none | After a failure, make the message visible again after this long |
| `onError` | `console.error` | Hears handler errors and connection failures |

Delivery is **at least once**: a worker can crash after doing the work but before the delete. Make handlers safe to repeat (use `message.messageId` to dedupe if you must).

## Queues

Create queues on the project's Queues page, with `mybase queue create`, from app code, or in `mybase.config.ts`:

```ts
// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  queue: {
    queues: {
      emails: { visibilityTimeout: "1m", deadLetter: { queue: "emails-failed", maxReceives: 5 } },
      "emails-failed": { retention: "14d" },
      orders: { fifo: true, contentDedup: true },
    },
  },
});
```

```sh
mybase queue sync --dry-run   # show what would change
mybase queue sync             # create, update, and delete code-defined queues to match
```

Removing a queue from the config deletes it **and its messages**; `sync` asks before doing that (`--yes` skips the question, for CI). Queues made on the dashboard or by your app are never touched by a sync.

From app code, `createQueue` is safe to call at every startup: creating a queue that already exists with the same settings returns it.

```ts
await queue.createQueue(`tenant_${tenantId}`, { visibilityTimeout: "2m" });
```

| Setting | Default | Range | |
| --- | --- | --- | --- |
| `fifo` | `false` | | Fixed at creation |
| `visibilityTimeout` | `30s` | 0–12h | How long a received message stays hidden |
| `delay` | `0` | 0–15m | How long new messages wait before they can be received |
| `retention` | `4d` | 1m–14d | Messages nobody deletes are dropped after this |
| `receiveWait` | `0` | 0–20s | Default long poll for receives that don't set one |
| `maxMessageBytes` | `262144` | 1024–262144 | Body plus attributes |
| `contentDedup` | `false` | | FIFO only: deduplicate by body |
| `deadLetter` | none | `maxReceives` 1–1000 | `{ queue, maxReceives }` |

Durations are milliseconds or `"30s"`, `"5m"`, `"4d"`.

## Standard and FIFO

**Standard** queues deliver each message at least once, roughly in the order sent, to as many consumers as you run. Messages can have their own delay:

```ts
await queue.send("reminders", { userId }, { delay: "10m" });
```

**FIFO** queues add two guarantees:

- **Order per group.** Every message has a `groupId`. Messages in a group are delivered strictly in send order, and while any of them is in flight, no other message of that group is delivered. Different groups are processed in parallel. Use one group per thing that must stay ordered (an order id, a user id).
- **Deduplication.** A send that repeats a `dedupId` seen in the last 5 minutes is accepted but not added again; the result has `duplicate: true` and the original's `messageId`. With `contentDedup`, a send without a `dedupId` is deduplicated by a hash of its body.

```ts
await queue.send("orders", { orderId, status: "paid" }, { groupId: orderId, dedupId: `${orderId}:paid` });
```

FIFO messages get an increasing `sequence`. Per-message delays aren't allowed on FIFO queues (use the queue's `delay`). `consume` runs each group's messages one at a time, in order, and stops a group at its first failure so later messages wait for the retry.

## Receiving by hand

```ts
const messages = await queue.receive("emails", { max: 10, wait: "20s", visibilityTimeout: "2m" });
for (const message of messages) {
  await handle(message.json());
  await queue.delete("emails", message.receipt);
}
```

Each delivery gets a new `receipt`; only the latest one deletes the message or changes its visibility. Need more time? Extend it before it runs out:

```ts
await queue.changeVisibility("emails", message.receipt, "5m");
await queue.changeVisibility("emails", message.receipt, 0); // give it back now
```

`receiveCount` says how many times a message has been delivered, this time included.

## Batches

`sendBatch`, `delete` (with an array), and `changeVisibilityBatch` take up to 100 entries. Entries succeed or fail one by one, so check `failed`:

```ts
const { successful, failed } = await queue.sendBatch("emails", [
  { id: "a", body: { to: "ada@example.com" } },
  { id: "b", body: { to: "grace@example.com" }, delay: "1m" },
]);
```

A batch carries at most 1 MB of bodies. On an SD card, batching also means fewer disk writes.

## Dead-letter queues

Give a queue a `deadLetter` setting and a message received `maxReceives` times without being deleted moves to that queue (same kind: standard to standard, FIFO to FIFO) instead of being delivered again. Look at what's there on the dashboard, fix the cause, then move the messages back:

```ts
await queue.redrive("emails-failed"); // each message back to the queue it failed in
await queue.redrive("emails-failed", { to: "emails-v2" });
```

or **Move back** on the dead-letter queue's page, or `mybase queue redrive <project> emails-failed`. Moved messages start over: receive count 0, and the target queue's retention.

## Other calls

```ts
await queue.listQueues();            // with approximate visible / in-flight / delayed counts
await queue.getQueue("emails");
await queue.updateQueue("emails", { visibilityTimeout: "2m" });
await queue.purge("emails");         // delete every message
await queue.deleteQueue("emails");
```

Code-defined queues can only be changed by `mybase queue sync`; updating or deleting one from the API answers 409.

## Other languages

Every call is JSON over HTTP with `Authorization: Bearer <API key>`, under `https://<mybase>/queue/<project>/queues`:

| Call | Body | Answer |
| --- | --- | --- |
| `GET /` · `POST /` | `{ name, fifo?, visibilityTimeout?, … }` | Queues · the queue (201 new, 200 existing) |
| `GET` · `PATCH` · `DELETE /<queue>` | settings for `PATCH` | The queue · 204 |
| `POST /<queue>/messages` | `{ messages: [{ id?, body, delayMs?, groupId?, dedupId?, attributes? }] }` | `{ successful, failed }` |
| `POST /<queue>/receive` | `{ max?, waitMs?, visibilityTimeoutMs? }` | `{ messages: [{ messageId, receipt, body, … }] }` |
| `POST /<queue>/delete` | `{ receipts: [...] }` | `{ done, failed }` |
| `POST /<queue>/visibility` | `{ entries: [{ receipt, visibilityTimeoutMs }] }` | `{ done, failed }` |
| `POST /<queue>/purge` | | 204 |
| `POST /<queue>/redrive` | `{ to? }` | `{ moved }` |

`attributes` are up to 10 string, number, or boolean values. A long poll (`waitMs` up to 20000) holds the request open until a message arrives or the time is up.

## Differences from SQS

- Keys are scoped per project and per service, not per queue (no per-queue policies).
- Batches of up to 100, not 10.
- Retention of dead-lettered messages restarts in the dead-letter queue.
- Stats (sent, received, deleted, dead-lettered per hour) are on the dashboard and `mybase queue stats`, kept 8 days.
- Run one mybase API instance: long polls are woken in memory.

---
title: Queues
summary: SQS-style standard and FIFO queues with visibility timeouts, long polling, batches, and dead-letter queues.
section: Services
order: 13
---

# Queues

Queues hand work to background workers. Standard queues deliver at least once in roughly FIFO order; FIFO queues keep order per message group and dedupe for 5 minutes.

```sh
mybase queue enable shop
mybase queue create shop emails --dlq emails-dead --max-receives 5
mybase queue send shop emails '{"to":"a@b.c"}'
mybase queue peek shop emails
mybase queue stats shop
```

How it works:

- **Receive** hides a message for its visibility timeout (default 30 s) and returns a receipt. **Delete** it with the receipt when done, or it comes back.
- **Long polling**: receive waits up to 20 s for a message.
- **Dead letters**: after `max-receives` receives, a message moves to the dead-letter queue. `mybase queue redrive` moves them back.
- Batches up to 100 messages; delays per queue or message.

In apps, use `createQueueClient` from `@mybase-dev/sdk/queue` with an API key that has `queue:write` (receiving is a write). Full guide: [SDK queues](sdk/queues.md).

## Queues in code

Declare queues in `mybase.config.ts` and run `mybase queue sync` (it confirms before deleting queues, whose messages go too).

## Agent notes

- Workers must delete messages after processing, or they're redelivered.
- Handlers should be idempotent: standard queues can deliver twice.
- Test a worker with `mybase queue send` (or MCP `send_message`) and watch `mybase queue peek`.

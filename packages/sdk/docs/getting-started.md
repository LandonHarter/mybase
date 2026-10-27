# Getting started

`@mybase-dev/sdk` helps your app send analytics, receive signed cron calls, schedule one-off tasks, use its cache, check rate limits, and send and receive queue messages through mybase. It has no runtime dependencies and uses Web Crypto; run it in Node 20+, Bun, Deno, or a compatible edge runtime.

## Install

```sh
npm install @mybase-dev/sdk
# or: bun add @mybase-dev/sdk
```

## Configure your app

Most helpers authenticate with a mybase **API key** (`mb_…`). Each key has permissions per service (`queue:write`, `ratelimit:write`, `cache:write`, `cron:write`, … or `admin`) and can be limited to some projects, so one key can cover everything an app uses. Create one in the dashboard (Settings → API keys) or with the CLI:

```sh
mybase token create shop-app --project shop --perm queue:write,ratelimit:write,cache:write,cron:write
```

Put it in your app's server-side environment as `MYBASE_API_KEY`. Never expose it to browser code; analytics uses its own public write key for that.

For cron, find your project's cron secret on its Cron page or run `mybase cron secret <project>`. Put it in your app's server-side environment as `MYBASE_CRON_SECRET`. Never expose it to browser code.

Your app needs an HTTP endpoint reachable from the mybase server. mybase sends `POST` requests to it; the SDK verifies signatures before invoking your handlers.

## Choose a guide

- [Handle cron calls](cron-handler.md) to receive scheduled jobs.
- [Define jobs in code](jobs-in-code.md) to sync schedules with the CLI.
- [Schedule one-off tasks](one-off-tasks.md) from your app's server-side code.
- [Track page views, events, and errors](analytics.md) with analytics.
- [Use the cache](cache.md) over TCP or HTTP.
- [Check rate limits](rate-limits.md) shared by every instance of your app.
- [Use queues](queues.md) to hand work off to background workers.

## Package entry points

The SDK has five entry points:

| Import | Use |
| --- | --- |
| `@mybase-dev/sdk/analytics` | Record page views, custom events, and errors |
| `@mybase-dev/sdk/cron` | Verify calls, handle jobs, and schedule one-off tasks |
| `@mybase-dev/sdk/cache` | Read and write the project's cache over HTTP |
| `@mybase-dev/sdk/ratelimit` | Check rate limits |
| `@mybase-dev/sdk/queue` | Send, receive, and consume queue messages |
| `@mybase-dev/sdk/config` | Declare jobs, rate limit rules, and queues for `mybase cron sync` / `ratelimit sync` / `queue sync` |

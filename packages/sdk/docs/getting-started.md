# Getting started

`@mybase/sdk` helps your app send analytics, receive signed cron calls, and schedule one-off tasks through mybase. It has no runtime dependencies and uses Web Crypto; run it in Node 20+, Bun, Deno, or a compatible edge runtime.

## Install

```sh
npm install @mybase/sdk
# or: bun add @mybase/sdk
```

## Configure your app

Find your project's cron secret on its Cron page or run `mybase cron secret <project>`. Put it in your app's server-side environment as `MYBASE_CRON_SECRET`. Never expose it to browser code.

Your app needs an HTTP endpoint reachable from the mybase server. mybase sends `POST` requests to it; the SDK verifies signatures before invoking your handlers.

## Choose a guide

- [Handle cron calls](cron-handler.md) to receive scheduled jobs.
- [Define jobs in code](jobs-in-code.md) to sync schedules with the CLI.
- [Schedule one-off tasks](one-off-tasks.md) from your app's server-side code.
- [Track page views, events, and errors](analytics.md) with analytics.

## Package entry points

The SDK has three entry points:

| Import | Use |
| --- | --- |
| `@mybase/sdk/analytics` | Record page views, custom events, and errors |
| `@mybase/sdk/cron` | Verify calls, handle jobs, and schedule one-off tasks |
| `@mybase/sdk/config` | Declare jobs for `mybase cron sync` |

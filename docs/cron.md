---
title: Cron
summary: Schedule signed HTTP calls to your app (5-field cron), define jobs in code, and schedule one-off tasks.
section: Services
order: 12
---

# Cron

mybase POSTs a signed JSON request to a URL of your app on a schedule. Your app verifies the signature with `@mybase/sdk/cron`.

```sh
mybase cron enable shop                 # prints the signing secret → MYBASE_CRON_SECRET
mybase cron create shop nightly --schedule "0 3 * * *" --url https://shop.example.com/api/cron
mybase cron run shop nightly            # run now
mybase cron runs shop nightly           # recent results
```

- Schedules are 5-field cron (minute precision), in UTC unless `--tz` is given.
- Retries on network errors, timeouts, 429, and 5xx: after 10 s, 60 s, 5 min.
- Ticks missed while mybase is down are not replayed. One-off tasks are: overdue ones run at boot.
- Each call has `X-Mybase-Signature: t=…,v1=…` (HMAC-SHA256). See [signatures](sdk/signatures.md).

## Jobs in code

Declare jobs in `mybase.config.ts` and sync them (code jobs can only be changed by sync; dashboard jobs are left alone):

```sh
mybase cron sync --dry-run
mybase cron sync
```

Guides: [handling calls](sdk/cron-handler.md), [jobs in code](sdk/jobs-in-code.md), [one-off tasks](sdk/one-off-tasks.md).

## Agent notes

- The cron secret is the one stored secret: get it with `mybase cron secret <project>`; rotate with `--rotate` (then update the app).
- Your endpoint must be reachable from the mybase server.
- Prefer `mybase.config.ts` + sync for jobs the app depends on, so they're reviewed with the code.

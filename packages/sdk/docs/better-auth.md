# Better Auth

Sign your app's users in with [Better Auth](https://better-auth.com), backed by mybase: its tables in the project's database, sessions in the mybase cache, sign-ins in the audit log, and mybase's self-hosted captcha. Turn on the users service first (`mybase users enable <project>`).

```ts
import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { Pool } from "pg";
import { createCache } from "@mybase-dev/sdk/cache";
import { authDatabaseUrl, mybaseAuth, mybaseCaptcha, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";

const mybase = { apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! };

export const auth = betterAuth({
  database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }),
  secondaryStorage: mybaseSecondaryStorage(createCache(mybase)),
  session: { storeSessionInDatabase: true },
  emailAndPassword: { enabled: true },
  plugins: [mybaseAuth(mybase), captcha(mybaseCaptcha({ ...mybase, secretKey: process.env.MYBASE_CAPTCHA_SECRET! }))],
});
```

This module imports nothing from Better Auth (it adds no dependencies); the helpers return the shapes Better Auth expects. Tested with Better Auth 1.7.

## authDatabaseUrl

`authDatabaseUrl(url, extra?)` adds `options=-c search_path=auth` to the connection string, so Better Auth's tables and migrations use the `auth` schema the users service created. Pass `["public"]` as `extra` to also see your own tables unqualified.

## mybaseSecondaryStorage

`mybaseSecondaryStorage(cache)` is Better Auth's `secondaryStorage` on the mybase cache (`createCache` from `@mybase-dev/sdk/cache`, with an API key that has `cache:write`). Sessions and rate limit counters live in memory under `<project>:auth:`, instead of a Postgres write on every request. Keep `session.storeSessionInDatabase: true` so the dashboard can list and revoke sessions; revoking removes both copies.

## mybaseAuth

`mybaseAuth({ apiUrl, project, apiKey })` is a Better Auth plugin that reports sign-ups, sign-ins, sign-outs, and deleted users to the project's audit log (API key with `users:write`). It sends user ids, IPs, and user agents, never emails or passwords. Sending never blocks a sign-in: failures go to `onError` (default `console.warn`) and are dropped.

## mybaseCaptcha

`mybaseCaptcha({ apiUrl, project, secretKey, endpoints? })` returns options for Better Auth's `captcha()` plugin that check tokens with mybase (Turnstile-compatible) instead of Cloudflare. `secretKey` is the project's captcha secret (`mybase captcha key <project>`). In the browser, solve a challenge with the [captcha script or SDK](captcha.md) and send the token in the `x-captcha-response` header.

## userContextQuery

`userContextQuery(userId)` returns `{ text, values }` for `select set_config('mybase.user_id', $1, true)`. Run it at the start of a transaction, and policies using `mybase_auth.uid()` see the signed-in user. Policies need `force row level security`, since your app connects as the table owner.

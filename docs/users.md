---
title: Users
summary: Sign-in for your app's users with Better Auth, backed by the project's database, cache, and audit log.
section: Services
order: 20
---

# Users

mybase doesn't run an auth server. [Better Auth](https://better-auth.com) runs inside your app and does the sign-in work (email and password, OAuth, passkeys, 2FA, …). The users service gives it what it needs from mybase:

- a schema (`auth`) in the project's database for Better Auth's tables,
- sessions and rate limit counters in the project's cache (off the SD card),
- sign-ups, sign-ins, and sign-outs in the [audit log](security.md),
- the captcha, through Better Auth's captcha plugin ([Captcha](captcha.md)),
- a **Users** page to look people up, sign them out, ban, or delete them,
- `mybase_auth.uid()` for row-level security.

## Set up

```sh
mybase users enable shop
mybase cache enable shop                               # sessions live here
mybase token create shop-auth --project shop --perm users:write,cache:write
mybase users init shop --env prod                      # prints auth.ts; stores BETTER_AUTH_SECRET in secrets env "prod"
```

`mybase users init` prints a starting `auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { createCache } from "@mybase-dev/sdk/cache";
import { authDatabaseUrl, mybaseAuth, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";

const mybase = { apiUrl: "{{MYBASE_URL}}", project: "shop", apiKey: process.env.MYBASE_API_KEY! };

export const auth = betterAuth({
  database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }),
  secondaryStorage: mybaseSecondaryStorage(createCache(mybase)),
  session: { storeSessionInDatabase: true },
  emailAndPassword: { enabled: true },
  plugins: [mybaseAuth(mybase)],
});
```

Then create Better Auth's tables with its CLI, from the app: `npx @better-auth/cli migrate` (Better Auth 1.7+: `npx auth migrate`). `authDatabaseUrl` sets `search_path=auth`, so they land in the `auth` schema, apart from your own tables.

From serverless hosts that can't open TCP to your server, use the [Neon serverless driver](database.md) over `/db` with the same URL.

## The Users page

Dashboard → project → Users lists users (search by email, name, or id). A user's page shows how they sign in and their active sessions. **Sign out** ends one session, **Sign out everywhere** all of them, **Ban** (with Better Auth's admin plugin) signs them out and refuses new sign-ins, and **Delete user** removes the account. Sessions are removed from both Postgres and the cache, so they stop working right away.

Sessions only show up when the app keeps them in the database too (`session: { storeSessionInDatabase: true }`).

CLI: `mybase users list|show|revoke|delete <project> …`. REST (`users:read`/`users:write`): `GET /projects/<p>/users`, `GET /projects/<p>/users/accounts?search=`, `GET|PATCH|DELETE /projects/<p>/users/accounts/<id>`, `DELETE …/accounts/<id>/sessions[/<session-id>]`.

## Row-level security

Apps connect as the project's role, which owns the tables, so policies only apply with `force row level security`. Tell Postgres who's signed in, in the same transaction as your queries:

```sql
alter table orders enable row level security;
alter table orders force row level security;
create policy own_orders on orders using (user_id = mybase_auth.uid());
```

```ts
import { userContextQuery } from "@mybase-dev/sdk/better-auth";

await sql.begin(async (tx) => {
  const q = userContextQuery(session.user.id);
  await tx.unsafe(q.text, q.values);
  return tx`select * from orders`;
});
```

The [security advisor](security.md) flags tables without RLS, and RLS that isn't forced, once the users service is on.

## Agent notes

- mybase never sees passwords: Better Auth hashes them in the app. Events sent to mybase hold user ids, IPs, and user agents only.
- Turning the service off drops the `auth` schema: every account is deleted.
- `mybaseAuth()` needs `users:write`; `mybaseSecondaryStorage()` needs the cache service and `cache:write`.
- Project context shows the user count only, never user data.

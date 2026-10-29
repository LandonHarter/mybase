---
title: Secrets
summary: Env vars and secrets per environment (dev, staging, prod, branches), stored encrypted. Start apps with mybase run; read at runtime with the SDK.
section: Services
order: 18
---

# Secrets

Keep your app's env vars here instead of `.env` files: API keys, connection strings, feature config. Each project has environments (`dev`, `staging`, and `prod` to start); start your app through `mybase run` and the environment's keys arrive as env vars. Every change is kept, so you can see who changed what and restore an earlier version.

```sh
mybase secrets enable shop
mybase secrets setup -p shop -e dev        # once per repo: this directory uses shop/dev
mybase secrets upload .env                 # or: mybase secrets set STRIPE_KEY=sk_test_…
mybase run -- bun dev                      # starts bun dev with the keys as env vars
```

`mybase secrets setup` is saved in your CLI config (`~/.config/mybase/config.json`), per directory, not in the repo. `-p/--project` and `-e/--env` (or `MYBASE_PROJECT` / `MYBASE_ENV`) override it.

## Environments and branches

- An environment is one set of keys. Create more (`mybase secrets env create preview`), rename, or delete them.
- A **branch env** (`mybase secrets env create dev_alice --from dev`) inherits every key of its root env and overrides only what you set in it. Change a shared value in `dev` and every branch sees it. Branches of branches aren't allowed.
- Names: 1–40 lowercase letters, digits, `_` or `-`. Keys: env var names (`[A-Za-z_][A-Za-z0-9_]*`, up to 128). Values up to 64 KB; 1000 keys per env; 50 envs per project.

## mybase run

`mybase run [-p <project>] [-e <env>] [--preserve-env] -- <command>` fetches the env, then starts the command with the keys added to its environment (they win over vars already set, unless `--preserve-env`). It also sets `MYBASE_ENV`. Signals are passed on and its exit code is the command's. If the secrets can't be fetched, the command doesn't start.

In CI, a deploy, or a container, use an API key limited to the project and env:

```sh
mybase token create shop-prod --perm secrets:read --project shop --env prod
# in the deploy:
MYBASE_API_URL={{MYBASE_URL}} MYBASE_TOKEN=mb_… mybase run -p shop -e prod -- node server.js
```

## Read at runtime

`createSecretsClient` from `@mybase-dev/sdk/secrets` reads an env from app code (`all()`, `get(key)`, `load()` into `process.env`). Reads send the last ETag, so checking for changes is one small request. Guide: [SDK secrets](sdk/secrets.md).

HTTP, with `Authorization: Bearer <key>`:

- `GET {{MYBASE_URL}}/secrets/<project>/<env>`: `{ env, version, secrets: { KEY: "value" } }` with inherited keys resolved. Sends an `ETag`; `If-None-Match` answers 304 when nothing changed. Needs `secrets:read`.
- `GET {{MYBASE_URL}}/secrets/<project>/<env>/<KEY>`: `{ value }`.
- `PATCH {{MYBASE_URL}}/secrets/<project>/<env>` with `{ set?: { KEY: "value" }, unset?: ["KEY"], message? }`: one revision. Needs `secrets:write`.

## History and restore

Every change (from the dashboard, CLI, SDK, or an agent) is a revision with who made it and an optional note: `mybase secrets history`. `mybase secrets restore <revision>` puts values back as they were after that revision, as a new revision, so a restore can be undone too. The last 200 revisions per env are kept.

## Environment-scoped API keys

An API key can be limited to some environments (`--env prod,staging`, or in the dashboard when creating a key with a secrets permission). It can read (or write) only those envs, by exact name: `prod` doesn't include `prod_eu`. Limited keys can't create, rename, or delete envs, or link credentials.

## Project credentials

A project's database password and storage key are shown once at creation and never stored. `mybase secrets link --env prod` (or Link credentials on the Secrets page) **rotates** them, and the cache password if the cache is on, then stores the new ones as `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `REDIS_URL`, `MYBASE_URL`, and `MYBASE_PROJECT`. Apps still using the old credentials stop working until they restart with these.

Every other service that's on goes along, so a linked env is all an app needs:

| Service | Keys |
|---|---|
| cron | `MYBASE_CRON_SECRET` (copied, not rotated) |
| analytics | `MYBASE_ANALYTICS_KEY` (copied) |
| captcha | `MYBASE_CAPTCHA_SECRET` (copied) |
| realtime | `MYBASE_REALTIME_SECRET` (copied) |
| cron, cache, rate limits, queues, web search, vector search, users, captcha, realtime, sandboxes | `MYBASE_API_KEY`: one API key limited to the project, with `cron:write`, `cache:write`, `ratelimit:write`, `queue:write`, `search:read`, `vector:write`, `users:write`, `captcha:write`, `realtime:write`, `sandbox:write` for the services that are on. Link makes a new one each time and revokes the last |

- Turning a service on later (`mybase <service> enable`, or the switch in the dashboard) offers to add its keys to the linked envs, and widens `MYBASE_API_KEY` in place (same key). `--link` / `--no-link` answer without asking. Turning a service off removes its keys and narrows the key.
- Rotating a key (`mybase cron secret --rotate`, `analytics key --rotate`, `captcha key --rotate`, `realtime key --rotate`, `cache password --rotate`) updates the linked envs that hold it.
- Linked keys are read-only: run link again to rotate them; every linked env gets the new values. `mybase secrets unlink -e <env>` removes them from one env without rotating.
- There is one database and bucket per project, so every linked env holds the same credentials.
- Restoring a revision never rolls credentials back.

## Encryption and the master key

Values are encrypted with AES-256-GCM under a per-project key, which is itself encrypted with `MYBASE_SECRETS_KEY` (32 random bytes, `openssl rand -base64 32`, set in the server's `.env`). The master key is never stored in Postgres, so a database dump or backup alone doesn't reveal secrets. Without `MYBASE_SECRETS_KEY` the service answers 503; the rest of mybase works.

**Back up `MYBASE_SECRETS_KEY` separately from the database. If it's lost, the stored secrets can't be recovered.**

To change it: set the new key as `MYBASE_SECRETS_KEY` and the old one as `MYBASE_SECRETS_KEY_OLD`, restart once (the log says how many projects were re-encrypted), then remove `MYBASE_SECRETS_KEY_OLD`.

## Agent notes

- Agents see environment and key names, never values: `get_project_context`, `list_secret_envs`, and `list_secret_keys` leave values out. `set_secrets` writes values; use it only for values the user gave you or for non-secret config.
- To move an app's config here, have the user run `mybase secrets upload .env -p <project> -e dev` rather than pasting secrets into chat, then change its start script to `mybase run -- <command>`.
- Keep `.env` files out of the repo; add the names to `.env.example` if the app documents them.
- The CLI warns before `link`: it rotates live credentials. Don't run it with `--yes` unless the user asked.

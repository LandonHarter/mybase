# mybase

> Status: early planning. Much of this document is a draft. Anything marked `TBD` has not been decided yet. Update this file as decisions are made.

## What is mybase

mybase is a self-hosted, Docker-based alternative to Supabase and similar cloud backend platforms. The goal is to spin up a new "project" quickly and get the services I normally reach for (Postgres, file storage, and more over time) without paying for or managing cloud resources.

## Why it exists

- Cloud platforms (AWS, Azure, GCP, hosted Supabase, etc.) are convenient but get expensive, and their resources are hard to keep track of and manage.
- Running on my own hardware (for now a Raspberry Pi) makes it free to run.
- I control the whole thing. If a service or feature is missing, I can add it myself.

## Goals

- One command (CLI) or one click (dashboard) creates a project with its own Postgres database, its own storage bucket, and credentials to use them.
- Runs on any machine with Docker, including low-power ARM boards like a Raspberry Pi.
- Adding a new service later should be easy. The exact module/plugin shape is `TBD`.

## Non-goals (for now)

`TBD`. Possible candidates to confirm later:

- Multi-node clustering or high availability
- Hosting projects for other people/tenants
- Feature parity with Supabase

## Targets and constraints

- **Runtime:** Docker + Docker Compose.
- **Architectures:** must support both `arm64` and `amd64`. The Pi is one target, not the only one, so every image we use or build must be multi-arch.
- **Reference low-end host:** Raspberry Pi 4/5 with 4GB RAM, running off an SD card. Design for this:
  - Keep total RAM use low. Prefer lightweight services.
  - Avoid heavy disk writes (SD cards are slow and wear out). An SSD is recommended for Postgres, but it can't be assumed.

## Architecture (draft)

Model: **shared services, isolated data.** There is one instance of each backing service, and each project gets its own isolated slice of it:

- One Postgres server → a separate database + role per project
- One storage server → a separate bucket (+ credentials) per project

A control plane written in TypeScript owns the project registry and does the provisioning. The CLI and the dashboard are both clients of its API.

```
  CLI ─────┐
           ├──> Control plane API (Bun/TS) ──┬──> Postgres (db + role per project)
Dashboard ─┘          │                      └──> Storage  (bucket per project)
                      └── project registry (store TBD)
```

Build vs. reuse is decided **per service**: use a proven OSS container when it fits, and write custom TS when the existing option is too heavy or doesn't fit.

## Services

| Service            | Status | Implementation          | Notes |
|--------------------|--------|-------------------------|-------|
| Postgres           | v1     | Official `postgres` + extensions (`docker/postgres.Dockerfile`) | Database + role per project; dashboard table editor, SQL editor, extensions, settings |
| File storage       | v1     | Reuse Garage (`dxflrs/garage`), S3-compatible | Bucket + access key per project; `public/` prefix readable via the API |
| Control plane API  | v1     | Custom (Bun/TS)         | Project registry and provisioning |
| CLI                | v1     | Custom (Bun/TS)         | e.g. `mybase project create <name>` (command shape `TBD`) |
| Dashboard          | v1     | Custom (React + shadcn/ui) | Design standard in `DESIGN.md` |
| Cron               | v1     | Custom (scheduler in the API, `croner`) | Optional service. POSTs a signed request to a URL on a schedule; run history, retries, jobs from code (`mybase cron sync`); one-off tasks scheduled from app code |
| Analytics          | v1     | Custom (ingest + reports in the API) | Optional service. Page views, routes, referrers, countries, browsers, custom events, errors; cookieless; dashboard page with charts; script tag at `/analytics.js` |
| Cache              | v1     | Reuse Valkey (`valkey/valkey:8.1-alpine`), Redis-compatible | Optional service. ACL user per project limited to `<project>:*` keys; TCP on :6379 or HTTP via the API (Upstash REST format); dashboard key browser |
| Rate limits        | v1     | Custom (Lua scripts on Valkey, API) | Optional service. Named rules (dashboard or `mybase ratelimit sync`) + inline limits; sliding/fixed/token bucket; hourly allowed/blocked stats |
| SDK (npm)          | v1     | Custom (`@mybase/sdk`)  | For apps: `@mybase/sdk/analytics` sends page views/events/errors (`createAnalytics`), `@mybase/sdk/cron` verifies + handles cron calls and schedules one-off tasks (`createCronClient`), `@mybase/sdk/cache` HTTP cache client (`createCache`), `@mybase/sdk/ratelimit` checks limits (`createRateLimiter`), `@mybase/sdk/config` declares jobs and rate limit rules in code |
| Auth (for apps)    | Later  | `TBD`                   | |
| Auto REST API      | Later  | `TBD`                   | |
| Realtime           | Later  | `TBD`                   | |
| Functions          | Later  | `TBD`                   | |
| Backups            | Later  | `TBD`                   | Especially important given the SD card risk |

## Tech stack

- **Language:** TypeScript
- **Runtime:** Bun
- **API framework:** `TBD` (Hono and Elysia are candidates)
- **Dashboard framework:** React 19 + Tailwind v4 + shadcn/ui, bundled by Bun's HTML import (no Vite). Follow `DESIGN.md` for all dashboard UI.
- **Control-plane metadata store:** a `mybase` schema in the shared Postgres (`postgres` database), migrated on boot by `control.ts`. Projects themselves are still registered by database comment.

## Networking and security

- **LAN / Tailscale** works directly: :4000 (dashboard + API), :5432 (Postgres), :3900 (S3), :6379 (cache).
- **Public access: Cloudflare Tunnel** (`cloudflared` service in compose.yml, `COMPOSE_PROFILES=tunnel`). No router ports; the home IP stays hidden. Hostnames: `mybase.<domain>` → `mybase:4000`, `s3.<domain>` → `garage:3900`. Set `MYBASE_TRUST_PROXY=cloudflare` so `CF-Connecting-IP` is trusted for client IPs (ignored otherwise: anyone can send it). Free plan: 100 MB request bodies, ~100 s responses.
- **Postgres from the internet** goes over WebSocket (the tunnel is HTTP only): `/db` (`db-proxy.ts`) pipes Neon-serverless-driver connections to our Postgres. The target is fixed, and the startup message is checked first: only `user == database ==` an existing project. Superuser and system DBs are rejected before Postgres sees them. `pg-wire.ts` has the protocol bits.
- **Admin auth** (`auth.ts` + `auth-http.ts`): one admin account (`mybase.admin`, argon2id). Browsers get a `mybase_session` cookie (HttpOnly, SameSite=Lax, Secure over https, 30-day sliding expiry). The CLI/scripts use API tokens (`mb_…`, `Authorization: Bearer`). Sessions and tokens are stored as SHA-256 hashes; last-seen writes are throttled to hourly (SD card).
- **Default-deny:** `logged()` in `index.ts` rejects signed-out requests unless the handler was wrapped in `open()`. Open: `/health`, `/auth/me|setup|login`, `/storage/:name/public/*`, `/db`, `/analytics/:project/events` + `/analytics.js`, `/cache/:project[/pipeline|/multi-exec]` and `/ratelimit/:project/limit` (both `withAppKey`: project secret as Bearer, wrong ones throttled per IP like sign-ins), and the dashboard's static files. Add new public routes deliberately.
- **CSRF:** non-GET requests with `Sec-Fetch-Site` other than same-origin/none (or a mismatched `Origin`) get 403, except `open(…, { anonymous: true, crossSite: true })` routes (analytics ingest: no cookie is read, so nothing to forge). Only the public storage route, `/analytics.js`, and analytics ingest send CORS headers.
- **First run:** `MYBASE_ADMIN_PASSWORD` creates the admin on boot; otherwise `/auth/setup` works once, and only from a private IP and not via Cloudflare, so a fresh public instance can't be claimed.
- Login throttling is per IP, in memory (5 free failures, then doubling lockout up to 1 h).
- Secrets management for project credentials: still `TBD` (returned once, not stored).

## Repo layout

Bun workspace monorepo:

```
apps/api         control plane (plain Bun.serve). Provisions a role + database (postgres.ts) and a Garage
                 bucket + key (storage.ts) per project; projects.ts keeps the two in step. Database tools:
                 project-db.ts (per-project pools, asProject), database.ts (stats, extensions), tables.ts
                 (table editor, SQL editor). services.ts: optional-service contract. control.ts: `mybase`
                 schema migrations. cron.ts (cron service, jobs, sync, secret) + cron-scheduler.ts (timers, calls).
                 auth.ts + auth-http.ts (admin account, sessions, API tokens). db-proxy.ts + pg-wire.ts (Postgres over WebSocket).
                 analytics.ts (service, settings, reports) + analytics-ingest.ts (validation, buffer, prune) +
                 analytics-ua.ts (user-agent parser) + analytics-tz.ts (time zone → country, generated from tzdata).
                 valkey.ts (admin connection, reconnect hooks) + cache.ts (ACL users, HTTP commands, key browser) +
                 ratelimit.ts (service, rules, sync, checks, stats) + ratelimit-scripts.ts (Lua algorithms)
apps/cli         `mybase` CLI (plain arg parsing, talks to the API)
apps/dashboard   web UI (React + shadcn/ui via Bun HTML import; see DESIGN.md)
packages/shared  shared types + constants (@mybase/shared)
packages/sdk     @mybase/sdk, published to npm for apps (zero deps). The API imports its signing code
docker/          Dockerfile (control-plane image), postgres.Dockerfile (Postgres + extensions),
                 compose.yml (end users), compose.dev.yml (dev Postgres + Garage)
.github/         docker.yml: builds amd64+arm64 images, pushes ghcr.io/landonharter/mybase and mybase-postgres.
                 sdk.yml: tests @mybase/sdk; tag sdk-v<version> publishes it to npm (NPM_TOKEN secret)
plan/            local plans, gitignored (see Plans)
```

## Plans

All plans live in `plan/` at the repo root. It is gitignored (local only, never committed). **Standard procedure: whenever in plan mode, write the plan file here**, not in the default location.

```
plan/
  api/          plans for apps/api
  cli/          plans for apps/cli
  dashboard/    plans for apps/dashboard
  shared/       plans for packages/shared
  docker/       plans for docker/ + .github/ (images, compose, CI)
  repo/         cross-cutting plans that span several apps/services
  <service>/    new service → new dir (e.g. plan/storage/)
```

- Put each plan under the dir of the app/service it changes. If it spans several, use `plan/repo/`.
- One plan = one markdown file, kebab-case name describing the work: `plan/api/project-delete-endpoint.md`.
- **Plan groups:** plans that should be executed together go in their own subdir, numbered in execution order:
  ```
  plan/api/storage-provisioning/
    01-bucket-create.md
    02-credentials.md
    03-cleanup-on-delete.md
  ```
- Create missing dirs as needed. `.claude/settings.json` sets `plansDirectory` to `./plan`; move/name the plan file into the right subdir per the rules above.

## Dev commands

```
bun install
bun run dev              # api + dashboard together, prefixed/colored output
bun run dev:api          # API on :4000 (API_PORT)
bun run dev:dashboard    # dashboard on :4001 (DASHBOARD_PORT)
bun run cli login [--url <url>]       # saves a token to ~/.config/mybase/config.json (MYBASE_API_URL / MYBASE_TOKEN override)
bun run cli project create <name>
bun run cli project list
bun run cli project delete <name> [--yes]
bun run typecheck
bun run test             # bun test (packages/sdk, apps/api auth + wire + analytics UA helpers)
bun run cli cron enable <project>        # then: cron list|create|delete|run|runs|tasks|schedule|cancel|secret|sync|disable
bun run cli cron sync [--config mybase.config.ts] [--dry-run]
bun run cli analytics enable <project>   # then: analytics key [--rotate] | stats [--range 7d] | disable
bun run cli cache enable <project>       # then: cache info | password --rotate | disable
bun run cli ratelimit enable <project>   # then: ratelimit rules|create|delete|key --rotate|stats|sync|disable
bun run db:up / db:down  # dev Postgres + Garage + Valkey via docker/compose.dev.yml
```

Ports default to 4000/4001 (3000 often taken by other local dev servers). See `.env.example`.

## Docker (how end users run mybase)

- **One image** (`docker/Dockerfile`): the API serves the pre-built dashboard (`DASHBOARD_DIR`) on one port, 4000. The dashboard always calls the API same-origin; in dev, `apps/dashboard/src/server.ts` proxies non-page requests to the API to match.
- **End users** download `docker/compose.yml`, set `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, and `VALKEY_PASSWORD` in `.env`, and run `docker compose up -d`. It runs the published image + `postgres` + `garage` + `valkey`. `MYBASE_IMAGE` overrides the image (e.g. a local build). `MYBASE_PUBLIC_HOST` sets the host shown to apps. Garage's config is inline in the compose file (`configs.content`, needs Compose ≥ 2.23.1); its image is scratch (no shell), so the API's `waitForGarage` stands in for a healthcheck.
- **Build locally:** `docker build -f docker/Dockerfile -t mybase:local .` (legacy builder without buildx needs `--build-arg BUILDPLATFORM=linux/amd64`). The build stage runs on the native platform (output is plain JS/CSS); only the runtime stage is per-arch.
- **Project registry** (stopgap until the metadata store is decided): Postgres itself. A project is a database whose comment starts with `{"mybase":` (`{"mybase":{"createdAt","storage":{"bucket"}}}`), owned by a same-named login role. Passwords and S3 secret keys are returned once at creation and never stored.
- **Postgres image** (`docker/postgres.Dockerfile`, published as `ghcr.io/landonharter/mybase-postgres:17`): `postgres:17-bookworm` + pgvector, PostGIS, hypopg, pg_partman from PGDG apt, with `pg_stat_statements` preloaded. Enabling an extension in the dashboard = `CREATE EXTENSION` in that project's database (as superuser). `MYBASE_POSTGRES_IMAGE` overrides it. Moving an existing volume off `postgres:17-alpine` needs a one-time `REINDEX DATABASE` per database (musl → glibc collation); see compose.yml.
- **Database tools** (dashboard Database page): the API keeps a small superuser pool per project database (`project-db.ts`). Row reads/edits and the SQL editor run in a transaction under `SET LOCAL ROLE <project>` with a 15s statement timeout, so they get the project's privileges. That's a guard against accidents, not a security boundary (SQL can `RESET ROLE`); revisit when admin auth lands. Never log SQL text or row values.
- **Services:** `SERVICES` in shared lists every service; `core: true` ones (database, storage) are on for every project. Optional services implement `ServiceModule` (`apps/api/src/services.ts`), are toggled with `PUT/DELETE /projects/:name/services/:id`, and are recorded in the registry comment's `services` array. Cron is the first.
- **Cron:** jobs live in `mybase.cron_jobs` (+ `cron_runs`, `cron_projects`). The API runs one in-process timer per enabled job (`cron-scheduler.ts`), so **run exactly one API instance**. Two (e.g. a second dev server against the same Postgres) both fire every job. Each run POSTs JSON signed with `X-Mybase-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` (`signCronRequest` from `@mybase/sdk/cron`, shared with apps). 5-field schedules only (minute precision, to spare the SD card). Retries: network error, timeout, 429, 5xx, backoff 10s/60s/5m, inside the run, so ticks during a retry are skipped. One `cron_runs` row per run, last 100 kept per job. Ticks missed while the API is down are not replayed. The per-project cron secret **is stored** (it signs every call), the one exception to "secrets aren't stored". Jobs have a `source`: `dashboard` ones are edited freely, `code` ones only by `mybase cron sync` (which replaces the code set and never touches dashboard jobs; only `enabled` can change elsewhere).
- **Cron tasks** (`cron-tasks.ts`, `mybase.cron_tasks`): one-off calls ("run job X once at T"), scheduled by apps via `createCronClient` in the SDK. App routes `/cron/:project/tasks…` are `open()` but must carry `X-Mybase-Signature` = HMAC(cron secret, `t.METHOD path.body`) (`signApiRequest`; a different message from cron calls so neither replays as the other). Admin routes: `/projects/:name/cron/tasks…` (list, create, cancel). Unlike job ticks, tasks are durable: overdue ones run at boot, ones left `running` by a crash are requeued (at least once; `runId` = task id). One timer sleeps until the soonest pending task (max 1 h, no polling); claims use `for update skip locked`; 10 calls in flight max. Optional `key` dedupes among pending/running tasks. Finished tasks pruned after 7 days; 10k pending per project.
- **Analytics** (`analytics.ts`, `analytics-ingest.ts`, `mybase.analytics_projects` + `analytics_events` + `analytics_salts`): apps POST batches (≤ 50 events, 64 KB, `text/plain` so `sendBeacon` works) to `/analytics/<project>/events` with the project's public write key (`mba_…`, stored in plain text: it's meant for browser code and can only add events). Events are buffered in memory and written as one multi-row insert every 10 s or 500 events (SD card); buffer capped at 10k, flushed on SIGTERM/SIGINT and before dashboard reads. Visitor = sha256(daily salt, project, IP, UA), salt rotates per UTC day; IPs are never stored or logged. Country = `CF-IPCountry` when trusting Cloudflare, else the browser's time zone (`analytics-tz.ts`, no GeoIP DB). Bots dropped by UA. Per-IP limit 300 events/min (`RateLimit` in auth-http.ts). Optional allowed-origins list; retention 1–365 days (default 90), pruned hourly. `/analytics.js` is the IIFE build of `packages/sdk/src/analytics-script.ts`: prebuilt in the image (`ANALYTICS_SCRIPT`), built with `Bun.build` on first request in dev.
- **Valkey** (`valkey.ts`): one admin connection (`default` user, `VALKEY_PASSWORD`). 64 MB cap (`CACHE_MAXMEMORY`), `allkeys-lru`, RDB snapshot at most every 15 min + on shutdown, no AOF (SD card). The API starts without it; cache/ratelimit routes answer 503 until it's back. Bun's `RedisClient` doesn't reliably reconnect, so disconnected clients are replaced before sending (never retried after: a command could run twice). Bun reports some error replies (NOPERM) as `ERR_REDIS_INVALID_RESPONSE`; `isServerError` checks the reply prefix.
- **Cache** (`cache.ts`, `mybase.cache_projects`): ACL user = project name, `~<p>:* &<p>:*`, `+@all -@dangerous -@admin` minus commands that list/count other projects' keys or channels (`SCAN`, `KEYS`, `DBSIZE`, `PUBSUB CHANNELS`, …). Only SHA-256 of the password is stored; Valkey takes it as `#<hash>`, and ACLs live in memory only, so every admin (re)connect re-applies them (`onValkeyConnect`). HTTP: one connection per project as its user (Valkey enforces the ACL; the API doesn't parse commands), blocking/subscribe/transaction commands refused, `/multi-exec` gets its own connection. RESP3 maps become flat arrays for Upstash clients. The project name `default` can't use the cache.
- **Rate limits** (`ratelimit.ts`, `mybase.ratelimit_projects` + `ratelimit_rules`): counters under `mybase:rl:<p>:<rule>:<id>`, outside the project's cache ACL. One Lua script per algorithm (`EVALSHA`, reloaded on `NOSCRIPT`), time from Valkey `TIME`. Stats: `HINCRBY mybase:rlstats:<p>:<rule>:<hour>` inside the same script, 8-day TTL, no Postgres writes. App key `mbr_…` stored as a hash; rules and key hashes cached in memory. Rules have a `source` like cron jobs (`mybase ratelimit sync`). SDK fails open on network errors/5xx unless `failClosed`. Eviction can reset a count early.
- **Enabling a service** may return secrets (`EnableServiceResponse`): `PUT /projects/:name/services/:id` answers 200 with them (cache password, rate limit key), else 204. The dashboard shows them once (`CredentialsDialog`).
- **Storage** (Garage, single node): the API applies the layout on first boot and keeps an internal key (`mybase-internal`) granted on every bucket, for the dashboard file browser, the public `/storage/<project>/public/*` route, and emptying buckets on delete. Bucket name = project name with `_` → `-` (`bucketName` in shared), which is why project names need ≥ 3 chars. Apps use the S3 port (3900) directly; the admin port (3903) stays internal in prod.

## Logging

Logs must be useful: always obvious which app/service a line came from and what happened. Rules:

- **Use the shared logger** (`createLogger("<service>")` from `@mybase/shared/logger`) in all server-side code. No bare `console.log` for diagnostics. CLI user-facing output (results, usage) may use `console.log`; diagnostics still go through the logger.
- **Every line is attributable.** The logger tags lines with a colored `[service]`. `bun run dev` prefixes every child line (crashes and stack traces included) with a colored, padded service name. Each service has a fixed color (`serviceColor` in the logger). Give new services an entry there.
- **Levels mean something.** `debug` = noisy detail, `info` = normal events (startup, one line per request, state changes), `warn` = expected failures (4xx, retries), `error` = needs attention (5xx, crashes). warn/error go to stderr.
- **Structured fields, not string interpolation.** `log.info("project created", { project: name })`, not `` log.info(`created ${name}`) ``. Pass errors as `{ err }` so the stack is printed.
- **Correlate.** API requests get a short request id (`req=`), echoed in the `X-Request-Id` header. Use `log.child({...})` for scoped context instead of repeating fields.
- **Never log secrets.** Passwords, tokens, connection strings with credentials, and full request bodies stay out of logs.
- **Config by env:** `LOG_LEVEL` (debug|info|warn|error, default info), `LOG_FORMAT=json` for containers/production (one JSON object per line), `NO_COLOR` / `FORCE_COLOR`.

## Open questions

- [x] Storage backend choice: Garage (light, multi-arch, S3 API, admin HTTP API)
- [x] Platform admin auth: one admin, session cookie + API tokens (auth for project apps still open)
- [~] How apps connect: direct Postgres connection string on LAN, WebSocket (`/db`, Neon serverless driver) from anywhere; REST API still open
- [ ] Backup/restore strategy
- [x] Interface for adding new services: `ServiceModule` + `SERVICES` (cron is the reference)
- [x] Method for public exposure: Cloudflare Tunnel; Postgres over WebSocket at `/db`
- [ ] API framework (dashboard: React + shadcn/ui, decided)
- [~] Where the control plane stores its own metadata: `mybase` schema in shared Postgres (cron uses it); projects still live in database comments
- [ ] Non-goals list

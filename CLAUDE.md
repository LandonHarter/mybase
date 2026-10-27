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
| Cron               | v1     | Custom (scheduler in the API, `croner`) | Optional service. POSTs a signed request to a URL on a schedule; run history, retries, jobs from code (`mybase cron sync`) |
| SDK (npm)          | v1     | Custom (`@mybase/sdk`)  | For apps: `@mybase/sdk/cron` verifies + handles cron calls, `@mybase/sdk/config` declares jobs in code |
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

- **LAN / Tailscale** works directly: :4000 (dashboard + API), :5432 (Postgres), :3900 (S3).
- **Public access: Cloudflare Tunnel** (`cloudflared` service in compose.yml, `COMPOSE_PROFILES=tunnel`). No router ports; the home IP stays hidden. Hostnames: `mybase.<domain>` → `mybase:4000`, `s3.<domain>` → `garage:3900`. Set `MYBASE_TRUST_PROXY=cloudflare` so `CF-Connecting-IP` is trusted for client IPs (ignored otherwise: anyone can send it). Free plan: 100 MB request bodies, ~100 s responses.
- **Postgres from the internet** goes over WebSocket (the tunnel is HTTP only): `/db` (`db-proxy.ts`) pipes Neon-serverless-driver connections to our Postgres. The target is fixed, and the startup message is checked first: only `user == database ==` an existing project. Superuser and system DBs are rejected before Postgres sees them. `pg-wire.ts` has the protocol bits.
- **Admin auth** (`auth.ts` + `auth-http.ts`): one admin account (`mybase.admin`, argon2id). Browsers get a `mybase_session` cookie (HttpOnly, SameSite=Lax, Secure over https, 30-day sliding expiry). The CLI/scripts use API tokens (`mb_…`, `Authorization: Bearer`). Sessions and tokens are stored as SHA-256 hashes; last-seen writes are throttled to hourly (SD card).
- **Default-deny:** `logged()` in `index.ts` rejects signed-out requests unless the handler was wrapped in `open()`. Open: `/health`, `/auth/me|setup|login`, `/storage/:name/public/*`, `/db`, and the dashboard's static files. Add new public routes deliberately.
- **CSRF:** non-GET requests with `Sec-Fetch-Site` other than same-origin/none (or a mismatched `Origin`) get 403. Only the public storage route sends CORS headers.
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
                 auth.ts + auth-http.ts (admin account, sessions, API tokens). db-proxy.ts + pg-wire.ts (Postgres over WebSocket)
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
bun run test             # bun test (packages/sdk, apps/api auth + wire helpers)
bun run cli cron enable <project>        # then: cron list|create|delete|run|runs|secret|sync|disable
bun run cli cron sync [--config mybase.config.ts] [--dry-run]
bun run db:up / db:down  # dev Postgres + Garage via docker/compose.dev.yml
```

Ports default to 4000/4001 (3000 often taken by other local dev servers). See `.env.example`.

## Docker (how end users run mybase)

- **One image** (`docker/Dockerfile`): the API serves the pre-built dashboard (`DASHBOARD_DIR`) on one port, 4000. The dashboard always calls the API same-origin; in dev, `apps/dashboard/src/server.ts` proxies non-page requests to the API to match.
- **End users** download `docker/compose.yml`, set `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, and `GARAGE_ADMIN_TOKEN` in `.env`, and run `docker compose up -d`. It runs the published image + `postgres` + `garage`. `MYBASE_IMAGE` overrides the image (e.g. a local build). `MYBASE_PUBLIC_HOST` sets the host shown to apps. Garage's config is inline in the compose file (`configs.content`, needs Compose ≥ 2.23.1); its image is scratch (no shell), so the API's `waitForGarage` stands in for a healthcheck.
- **Build locally:** `docker build -f docker/Dockerfile -t mybase:local .` (legacy builder without buildx needs `--build-arg BUILDPLATFORM=linux/amd64`). The build stage runs on the native platform (output is plain JS/CSS); only the runtime stage is per-arch.
- **Project registry** (stopgap until the metadata store is decided): Postgres itself. A project is a database whose comment starts with `{"mybase":` (`{"mybase":{"createdAt","storage":{"bucket"}}}`), owned by a same-named login role. Passwords and S3 secret keys are returned once at creation and never stored.
- **Postgres image** (`docker/postgres.Dockerfile`, published as `ghcr.io/landonharter/mybase-postgres:17`): `postgres:17-bookworm` + pgvector, PostGIS, hypopg, pg_partman from PGDG apt, with `pg_stat_statements` preloaded. Enabling an extension in the dashboard = `CREATE EXTENSION` in that project's database (as superuser). `MYBASE_POSTGRES_IMAGE` overrides it. Moving an existing volume off `postgres:17-alpine` needs a one-time `REINDEX DATABASE` per database (musl → glibc collation); see compose.yml.
- **Database tools** (dashboard Database page): the API keeps a small superuser pool per project database (`project-db.ts`). Row reads/edits and the SQL editor run in a transaction under `SET LOCAL ROLE <project>` with a 15s statement timeout, so they get the project's privileges. That's a guard against accidents, not a security boundary (SQL can `RESET ROLE`); revisit when admin auth lands. Never log SQL text or row values.
- **Services:** `SERVICES` in shared lists every service; `core: true` ones (database, storage) are on for every project. Optional services implement `ServiceModule` (`apps/api/src/services.ts`), are toggled with `PUT/DELETE /projects/:name/services/:id`, and are recorded in the registry comment's `services` array. Cron is the first.
- **Cron:** jobs live in `mybase.cron_jobs` (+ `cron_runs`, `cron_projects`). The API runs one in-process timer per enabled job (`cron-scheduler.ts`), so **run exactly one API instance**. Two (e.g. a second dev server against the same Postgres) both fire every job. Each run POSTs JSON signed with `X-Mybase-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` (`signCronRequest` from `@mybase/sdk/cron`, shared with apps). 5-field schedules only (minute precision, to spare the SD card). Retries: network error, timeout, 429, 5xx, backoff 10s/60s/5m, inside the run, so ticks during a retry are skipped. One `cron_runs` row per run, last 100 kept per job. Ticks missed while the API is down are not replayed. The per-project cron secret **is stored** (it signs every call), the one exception to "secrets aren't stored". Jobs have a `source`: `dashboard` ones are edited freely, `code` ones only by `mybase cron sync` (which replaces the code set and never touches dashboard jobs; only `enabled` can change elsewhere).
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

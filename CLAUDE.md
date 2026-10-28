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
| CLI                | v1     | Custom (Bun/TS)         | Published as `@mybase-dev/cli` + standalone binaries (`scripts/install.sh`). `--json`, exit codes, `--yes` required without a TTY; `context`, `docs`, `mcp`, `agent init` for agents; `server setup|status|update|tunnel|autostart` installs and runs the server (wizard, `@clack/prompts`); `update` self-updates the binary from GitHub releases, then the local server |
| Dashboard          | v1     | Custom (React + shadcn/ui) | Design standard in `DESIGN.md` |
| Cron               | v1     | Custom (scheduler in the API, `croner`) | Optional service. POSTs a signed request to a URL on a schedule; run history, retries, jobs from code (`mybase cron sync`); one-off tasks scheduled from app code |
| Analytics          | v1     | Custom (ingest + reports in the API) | Optional service. Page views, routes, referrers, countries, browsers, custom events, errors; cookieless; dashboard page with charts; script tag at `/analytics.js` |
| Cache              | v1     | Reuse Valkey (`valkey/valkey:8.1-alpine`), Redis-compatible | Optional service. ACL user per project limited to `<project>:*` keys; TCP on :6379 or HTTP via the API (Upstash REST format); dashboard key browser |
| Rate limits        | v1     | Custom (Lua scripts on Valkey, API) | Optional service. Named rules (dashboard or `mybase ratelimit sync`) + inline limits; sliding/fixed/token bucket; hourly allowed/blocked stats |
| Queues             | v1     | Custom (Postgres tables, API) | Optional service. SQS-style standard + FIFO queues: visibility timeouts, long polling, delays, batches (≤ 100), dead-letter queues + redrive; queues from dashboard, code (`mybase queue sync`), or apps |
| Web search         | v1     | Reuse SearXNG (`searxng/searxng`) + custom fetch (API) | Optional service, for apps' AI agents. Search (Bing, Mojeek, Yahoo, DDG, Brave; `it`, `news`) + read a URL as markdown (Readability); Valkey cache; public addresses only. Apps use the SDK (no MCP tools, by choice); dashboard page to try searches and page reads |
| Secrets            | v1     | Custom (API, Postgres, AES-GCM) | Optional service, Doppler-style. Envs per project (dev/staging/prod + custom + branch envs inheriting a root); values encrypted (envelope: `MYBASE_SECRETS_KEY` wraps a per-project data key); revisions + restore; `mybase run -- <cmd>` injects them; env-scoped API keys; `link` rotates and stores project credentials. Agents see names only |
| Vector search      | v1     | Custom (API, pgvector + Postgres FTS in the project DB) | Optional service. Named indexes of documents (`id`, `title`, `text`, `metadata`, `vector`); vector, keyword, and hybrid (RRF) search with metadata filters; optional OpenAI-compatible embedding provider; indexes from dashboard, code (`mybase vector sync`), or apps; `retrievalTool` for agents |
| Users (app auth)   | v1     | Reuse Better Auth (runs in the app) + custom glue (API, SDK) | Optional service. `auth` schema in the project DB for Better Auth's tables, sessions in the cache (`mybaseSecondaryStorage`), sign-in events → audit log (`mybaseAuth` plugin), `mybase_auth.uid()` for RLS; dashboard Users page (list, sessions, revoke, ban, delete) |
| Captcha            | v1     | Custom (API, proof of work, ALTCHA-style) | Optional service. Signed challenges, browser finds the SHA-256 preimage, one-time tokens (Valkey `SET NX`); `/captcha.js` widget, SDK verify, Turnstile-compatible siteverify for Better Auth's captcha plugin |
| Security           | v1     | Custom (API)            | Instance-wide: advisor (read-only checks, `mybase doctor`), audit log (every write, buffered), alerts (built-in rules → ntfy/webhook); dashboard Security page |
| SDK (npm)          | v1     | Custom (`@mybase-dev/sdk`)  | For apps: `@mybase-dev/sdk/analytics` sends page views/events/errors (`createAnalytics`), `@mybase-dev/sdk/cron` verifies + handles cron calls and schedules one-off tasks (`createCronClient`), `@mybase-dev/sdk/cache` HTTP cache client (`createCache`), `@mybase-dev/sdk/ratelimit` checks limits (`createRateLimiter`), `@mybase-dev/sdk/queue` sends/receives/consumes messages (`createQueueClient`), `@mybase-dev/sdk/search` searches + reads pages (`createSearchClient`, `searchTools` for LLM tool loops), `@mybase-dev/sdk/secrets` reads/writes an env (`createSecretsClient`), `@mybase-dev/sdk/vector` indexes + searches documents (`createVectorClient`, `retrievalTool`), `@mybase-dev/sdk/better-auth` plugs Better Auth into mybase (`authDatabaseUrl`, `mybaseSecondaryStorage`, `mybaseAuth`, `mybaseCaptcha`, `userContextQuery`; imports nothing from better-auth), `@mybase-dev/sdk/captcha` solves + verifies captchas (`solveCaptcha`, `createCaptchaClient`), `@mybase-dev/sdk/config` declares jobs, rate limit rules, queues, and vector indexes in code |
| Docs for agents    | v1     | Custom (`docs.ts`, API)  | `docs/*.md` (platform) + `packages/sdk/docs` served at `/llms.txt`, `/llms-full.txt`, `/docs`, `/docs/<slug>.md`, `/docs/search?q=`; also in the dashboard |
| MCP server         | v1     | Custom (`mcp.ts`, API)   | Streamable HTTP at `/mcp`, stateless JSON-RPC, API key as Bearer. Tools wrap REST routes over loopback with the caller's key; list filtered by key. No destructive tools |
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

- **LAN / Tailscale** works directly: :4000 (dashboard + API), :5432 (Postgres), :3900 (S3), :6379 (cache). Postgres can also be made public with a router port forward (see Public Postgres).
- **Public access: Cloudflare Tunnel** (`cloudflared` service in compose.yml, `COMPOSE_PROFILES=tunnel`). No router ports; the home IP stays hidden. Hostnames: `mybase.<domain>` → `mybase:4000`, `s3.<domain>` → `garage:3900`. Set `MYBASE_TRUST_PROXY=cloudflare` so `CF-Connecting-IP` is trusted for client IPs (ignored otherwise: anyone can send it). Free plan: 100 MB request bodies, ~100 s responses.
- **Postgres from the internet** goes over WebSocket (the tunnel is HTTP only): `/db` (`db-proxy.ts`) pipes Neon-serverless-driver connections to our Postgres. The target is fixed, and the startup message is checked first: only `user == database ==` an existing project. Superuser and system DBs are rejected before Postgres sees them. `pg-wire.ts` has the protocol bits.
- **Public Postgres** (`db-public.ts` + `acme.ts`, `mybase.db_public`, `mybase server database-public`): a router port forward + `MYBASE_DB_PUBLIC=on`, `MYBASE_DB_PUBLIC_HOST=db.<domain>`, `MYBASE_DNS_TOKEN` (Cloudflare, DNS edit only) give apps a plain `postgres://…?sslmode=require` URL from anywhere. The API keeps an unproxied A record on the public IPv4 (1.1.1.1/cdn-cgi/trace, every 5 min) and gets a Let's Encrypt cert with dns-01 (own ACME client, zero deps), renewed 30 days before expiry with 1 h/6 h/1 d backoff. Files go into PGDATA through the superuser connection (`lo_export` writes them as postgres, 0600), then `ssl = on` + reload; cert + key are also kept in the DB (sealed with `MYBASE_SECRETS_KEY` when set) to refill a fresh volume. `pg_hba.conf` is rewritten at boot whether or not the feature is on, but only if the file is the image default or ours (it gets checked against `pg_hba_file_rules` before the reload): private/Docker/Tailscale ranges as before, the internet only `hostssl sameuser +mybase_project` (every project role is in that group; superusers aren't), the rest rejected. `sslmode` only appears once a cert is installed (`setPublicTls`). `auth_delay` (500 ms) is preloaded in the Postgres image. If Docker's userland proxy is used, internet clients look like 172.x addresses and get the LAN rule.
- **Admin auth** (`auth.ts` + `auth-http.ts`): one admin account (`mybase.admin`, argon2id). Browsers get a `mybase_session` cookie (HttpOnly, SameSite=Lax, Secure over https, 30-day sliding expiry). The CLI, scripts, and apps use API keys (`mb_…`, `Authorization: Bearer`). Sessions and keys are stored as SHA-256 hashes, and keys are cached in memory by hash (dropped on update/revoke). Last-seen writes are throttled to hourly (SD card).
- **Admin 2FA** (`auth-mfa.ts` + `totp.ts`, `mybase.admin_totp` + `admin_recovery_codes`): optional TOTP (RFC 6238, ±1 step, last step saved against replay) + 10 one-time recovery codes (sha256). With it on, `/auth/login` returns `{ mfaRequired, challenge }` (in memory, 5 min, 5 tries) and `/auth/login/mfa` issues the cookie/token; the per-IP throttle is only reset after the code. `/auth/mfa/*` is session-only (API keys get 403). The secret is AES-GCM under `MYBASE_SECRETS_KEY` when set (`startMfa` seals/re-seals it at boot); `MYBASE_ADMIN_RESET_MFA=1` turns it off. API tokens never need a code.
- **API key permissions** (`permissions.ts`, `mybase.api_tokens.permissions/projects`): `admin` or `<resource>:read|write` (resources: `KEY_RESOURCES` in shared; write includes read), plus an optional project list (null = all). Sessions and pre-existing tokens are `admin`. `audit` is read-only (`/audit*` GET → `audit:read`; `PUT /audit/settings` and `/alerts*` → admin). `requirement(method, path)` derives each route's need from its path: `/projects/:name/<service>/…` and the app routes `/<service>/:project/…` → that service (GET = read, else write), `/projects` → `projects`; `/auth/*`, the SQL editor, extensions, and any unlisted route → `admin`. A project-limited key can read lists (filtered) but not write outside its projects. New routes under a service path inherit its permission; anything else is admin-only until listed.
- **Default-deny:** `logged()` in `index.ts` rejects signed-out requests unless the handler was wrapped in `open()`, and checks the key's permission (`allows`) for everything else. Open: `/health`, `/llms.txt`, `/llms-full.txt`, `/docs`, `/docs/search`, `/docs/*`, `/auth/me|setup|login`, `/storage/:name/public/*`, `/db`, `/analytics/:project/events` + `/analytics.js`, `/captcha/:project/challenge` + `/captcha/:project/siteverify` (takes the captcha secret) + `/captcha.js`, and the dashboard's static files. `/mcp` and `GET /projects/:name/context` need any valid key (`requirement` → `any`): each MCP tool re-enters a REST route over loopback (`127.0.0.1:<port>`) with the caller's credentials, and context drops sections the key can't read (handler checks `canSeeProject`). App routes (`/cache/:project…`, `/ratelimit/:project/limit`, `/queue/:project/queues…`, `/cron/:project/tasks…`, `/search/:project…`, `/secrets/:project/:env…`, `/users/:project/events`, `/captcha/:project/verify`) are not open: they take an API key (`appRoute`, which also checks the service is on). Wrong bearer keys are throttled per IP like sign-ins. Add new public routes deliberately.
- **Security headers** (`security-headers.ts`): every API response gets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` (`setMissing` in `logged()`), signed-in ones `Cache-Control: no-store`. The built dashboard gets a CSP (inline theme script allowed by sha256, computed at boot from `index.html`), COOP, Permissions-Policy, HSTS over https; dev has no CSP (HMR). Stored objects (public route + file browser) get `nosniff` + a `sandbox` CSP, and active types (HTML, SVG, XML, JS, wasm, unknown) go out as `application/octet-stream` attachments (`objectHeaders`): public files share the dashboard's origin, so a rendered HTML file could act as the admin.
- **CSRF:** non-GET requests with `Sec-Fetch-Site` other than same-origin/none (or a mismatched `Origin`) get 403, except `open(…, { anonymous: true, crossSite: true })` routes (analytics ingest: no cookie is read, so nothing to forge). Only the public storage route, `/analytics.js`, and analytics ingest send CORS headers.
- **First run:** `MYBASE_ADMIN_PASSWORD` creates the admin on boot; otherwise `/auth/setup` works once, and only from a private IP and not via Cloudflare, so a fresh public instance can't be claimed.
- Login throttling is per IP, in memory (5 free failures, then doubling lockout up to 1 h).
- Project credentials are returned once and not stored, unless the user links them into the secrets service (`mybase secrets link`, which rotates them). Per-service app keys are gone: apps use scoped API keys (optionally limited to secrets environments).

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
                 ratelimit.ts (service, rules, sync, checks, stats) + ratelimit-scripts.ts (Lua algorithms).
                 queue.ts (queues, messages, long-poll waiters, dead letters, sync, stats)
                 search.ts (service, SearXNG calls, cache, throttles) + search-fetch.ts (SSRF checks, HTML → markdown)
                 secrets.ts (service, envs, values, revisions) + secrets-crypto.ts (AES-GCM envelope) + secrets-state.ts
                 (branch overlay, rewind) + secrets-link.ts (rotate + store project credentials)
                 vector.ts (service, indexes, documents, queries) + vector-embed.ts (embedding provider, query cache)
                 docs.ts (loads docs/ + sdk docs, llms.txt, search) + mcp.ts (MCP server) + context.ts (project context)
                 security-headers.ts (response headers, sandboxed stored objects) + advisor.ts (security checks) +
                 audit.ts (audit log: request scope, auto events, buffer) + alerts.ts (rules over audit events, ntfy/webhook)
                 users.ts (users service: Better Auth's tables, sessions, events) + captcha.ts (captcha service)
                 db-public.ts (public Postgres: pg_hba, cert install/renew, DDNS) + acme.ts (Let's Encrypt, dns-01)
apps/cli         `mybase` CLI (plain arg parsing, talks to the API). output.ts: --json, confirm, exit codes.
                 run.ts: `mybase run` (spawns a command with an env's secrets); config.ts keeps per-directory setups
                 server.ts (`mybase server` commands) + server-setup.ts (install wizard, @clack/prompts) +
                 server-env.ts (.env parse/merge/keys) + server-docker.ts (Docker checks, compose); the Cloudflare
                 client (tunnel + DNS) is in packages/shared/src/cloudflare.ts (the API uses it for public Postgres)
                 Published as @mybase-dev/cli (bundle) and compiled binaries (cli.yml)
apps/dashboard   web UI (React + shadcn/ui via Bun HTML import; see DESIGN.md)
packages/shared  shared types + constants (@mybase/shared)
packages/sdk     @mybase-dev/sdk, published to npm for apps (zero deps). The API imports its signing code
docs/            platform docs (frontmatter: title, summary, section, order; `{{MYBASE_URL}}` placeholder; end
                 with "Agent notes"). docs/cli.md is generated: `bun scripts/gen-cli-docs.ts` (a test checks it)
scripts/         dev.ts, gen-cli-docs.ts, install.sh (CLI binary installer)
docker/          Dockerfile (control-plane image), postgres.Dockerfile (Postgres + extensions),
                 compose.yml (end users), compose.dev.yml (dev Postgres + Garage)
.github/         docker.yml: builds amd64+arm64 images, pushes ghcr.io/landonharter/mybase and mybase-postgres.
                 Tag v<version> releases everything (npm trusted publishing, no token; npm trusts these files):
                 sdk.yml tests + publishes @mybase-dev/sdk, cli.yml tests + publishes @mybase-dev/cli + CLI
                 binaries (GitHub release), docker.yml tags images.
                 One version for everything: sdk + cli package.json and MYBASE_VERSION, set by hand with
                 `./scripts/set-version.ts <version>`
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
bun run test             # bun test (packages/sdk, apps/api auth + permissions + wire + analytics UA helpers)
bun run cli token create <name> --perm queue:write,cache:write [--project shop] | --admin   # then: token list|update|delete
bun run cli cron enable <project>        # then: cron list|create|delete|run|runs|tasks|schedule|cancel|secret|sync|disable
bun run cli cron sync [--config mybase.config.ts] [--dry-run]
bun run cli analytics enable <project>   # then: analytics key [--rotate] | stats [--range 7d] | disable
bun run cli cache enable <project>       # then: cache info | password --rotate | disable
bun run cli ratelimit enable <project>   # then: ratelimit rules|create|delete|stats|sync|disable
bun run cli queue enable <project>       # then: queue list|create|delete|purge|send|peek|receive|redrive|stats|sync|disable
bun run cli search enable <project>      # then: search disable (apps use the SDK; no search command)
bun run cli secrets enable <project>     # then: secrets setup|envs|env|list|get|set|unset|upload|history|restore|link|unlink|disable
bun run cli vector enable <project>      # then: vector settings|embedding|list|create|delete|upsert|documents|query|sync|disable
bun run cli run [-p p] [-e env] -- <cmd> # start a command with an env's secrets
bun run cli users enable <project>       # then: users init|list|show|revoke|delete|disable
bun run cli captcha enable <project>     # then: captcha key [--rotate] | difficulty <n> | disable
bun run cli server database-public       # public postgres:// URLs (port forward + Let's Encrypt + DDNS); --off
bun run cli update [--cli] [--version v]  # self-update the CLI binary, then the server on this machine
bun run cli server setup [--dir ~/mybase] # install wizard; then: server status|update|tunnel [--off]|autostart on|off
bun run cli doctor [<project>]           # security advisor; audit [--action auth --since 24h] [--follow]; alerts add|test|rule
bun run cli context <project> [--json]   # project at a glance for agents (no secrets)
bun run cli docs [<slug> | --search "<q>"]
bun run cli mcp                          # MCP setup snippets; agent init [--project p] [--key] writes AGENTS.md, skill, .mcp.json
bun scripts/gen-cli-docs.ts              # after changing any CLI usage text
./scripts/set-version.ts 1.0.1           # set the release version everywhere, then tag v1.0.1
bun --cwd apps/cli run compile           # standalone binary in apps/cli/dist
bun run db:up / db:down  # dev Postgres + Garage + Valkey + SearXNG (:8080) via docker/compose.dev.yml
```

Ports default to 4000/4001 (3000 often taken by other local dev servers). See `.env.example`.

## Docker (how end users run mybase)

- **One image** (`docker/Dockerfile`): the API serves the pre-built dashboard (`DASHBOARD_DIR`) on one port, 4000. The dashboard always calls the API same-origin; in dev, `apps/dashboard/src/server.ts` proxies non-page requests to the API to match.
- **End users** run `mybase server setup` (install.sh `--setup` launches it): it writes `~/mybase/.env` + the `compose.yml` embedded in the CLI (text import, so it matches the CLI version), generates keys (never regenerates existing ones), sets up LAN host / Cloudflare Tunnel (auto via API token, or manual token) / start on boot (`MYBASE_RESTART` restart policy + `systemctl enable docker`), starts the stack, creates the admin via `/auth/setup`, and saves a CLI token. `docker compose` is spawned without any variable compose.yml reads (`composeEnv`): Bun loads the cwd's .env, and shell env beats the install's .env. Or by hand: download `docker/compose.yml`, set `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `VALKEY_PASSWORD`, and `SEARXNG_SECRET` in `.env`, and run `docker compose up -d`. It runs the published image + `postgres` + `garage` + `valkey` + `searxng`. `MYBASE_IMAGE` overrides the image (e.g. a local build). `MYBASE_PUBLIC_HOST` sets the host shown to apps. Garage's config is inline in the compose file (`configs.content`, needs Compose ≥ 2.23.1); its image is scratch (no shell), so the API's `waitForGarage` stands in for a healthcheck.
- **Build locally:** `docker build -f docker/Dockerfile -t mybase:local .` (legacy builder without buildx needs `--build-arg BUILDPLATFORM=linux/amd64`). The build stage runs on the native platform (output is plain JS/CSS); only the runtime stage is per-arch.
- **Project registry** (stopgap until the metadata store is decided): Postgres itself. A project is a database whose comment starts with `{"mybase":` (`{"mybase":{"createdAt","storage":{"bucket"}}}`), owned by a same-named login role. Passwords and S3 secret keys are returned once at creation and never stored.
- **Postgres image** (`docker/postgres.Dockerfile`, published as `ghcr.io/landonharter/mybase-postgres:17`): `postgres:17-bookworm` + pgvector, PostGIS, hypopg, pg_partman from PGDG apt, with `pg_stat_statements` preloaded. Enabling an extension in the dashboard = `CREATE EXTENSION` in that project's database (as superuser). `MYBASE_POSTGRES_IMAGE` overrides it. Moving an existing volume off `postgres:17-alpine` needs a one-time `REINDEX DATABASE` per database (musl → glibc collation); see compose.yml.
- **Database tools** (dashboard Database page): the API keeps a small superuser pool per project database (`project-db.ts`). Row reads/edits and the SQL editor run in a transaction under `SET LOCAL ROLE <project>` with a 15s statement timeout, so they get the project's privileges. That's a guard against accidents, not a security boundary (SQL can `RESET ROLE`); revisit when admin auth lands. Never log SQL text or row values.
- **Services:** `SERVICES` in shared lists every service; `core: true` ones (database, storage) are on for every project. Optional services implement `ServiceModule` (`apps/api/src/services.ts`), are toggled with `PUT/DELETE /projects/:name/services/:id`, and are recorded in the registry comment's `services` array. Cron is the first.
- **Cron:** jobs live in `mybase.cron_jobs` (+ `cron_runs`, `cron_projects`). The API runs one in-process timer per enabled job (`cron-scheduler.ts`), so **run exactly one API instance**. Two (e.g. a second dev server against the same Postgres) both fire every job. Each run POSTs JSON signed with `X-Mybase-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` (`signCronRequest` from `@mybase-dev/sdk/cron`, shared with apps). 5-field schedules only (minute precision, to spare the SD card). Retries: network error, timeout, 429, 5xx, backoff 10s/60s/5m, inside the run, so ticks during a retry are skipped. One `cron_runs` row per run, last 100 kept per job. Ticks missed while the API is down are not replayed. The per-project cron secret **is stored** (it signs every call), an exception to "secrets aren't stored" (the secrets service is the other, encrypted). Jobs have a `source`: `dashboard` ones are edited freely, `code` ones only by `mybase cron sync` (which replaces the code set and never touches dashboard jobs; only `enabled` can change elsewhere).
- **Cron tasks** (`cron-tasks.ts`, `mybase.cron_tasks`): one-off calls ("run job X once at T"), scheduled by apps via `createCronClient` in the SDK. App routes `/cron/:project/tasks…` take an API key with `cron:read|write` (the cron secret only signs outbound calls). Admin routes: `/projects/:name/cron/tasks…` (list, create, cancel). Unlike job ticks, tasks are durable: overdue ones run at boot, ones left `running` by a crash are requeued (at least once; `runId` = task id). One timer sleeps until the soonest pending task (max 1 h, no polling); claims use `for update skip locked`; 10 calls in flight max. Optional `key` dedupes among pending/running tasks. Finished tasks pruned after 7 days; 10k pending per project.
- **Analytics** (`analytics.ts`, `analytics-ingest.ts`, `mybase.analytics_projects` + `analytics_events` + `analytics_salts`): apps POST batches (≤ 50 events, 64 KB, `text/plain` so `sendBeacon` works) to `/analytics/<project>/events` with the project's public write key (`mba_…`, stored in plain text: it's meant for browser code and can only add events). Events are buffered in memory and written as one multi-row insert every 10 s or 500 events (SD card); buffer capped at 10k, flushed on SIGTERM/SIGINT and before dashboard reads. Visitor = sha256(daily salt, project, IP, UA), salt rotates per UTC day; IPs are never stored or logged. Country = `CF-IPCountry` when trusting Cloudflare, else the browser's time zone (`analytics-tz.ts`, no GeoIP DB). Bots dropped by UA. Per-IP limit 300 events/min (`RateLimit` in auth-http.ts). Optional allowed-origins list; retention 1–365 days (default 90), pruned hourly. `/analytics.js` is the IIFE build of `packages/sdk/src/analytics-script.ts`: prebuilt in the image (`ANALYTICS_SCRIPT`), built with `Bun.build` on first request in dev.
- **Valkey** (`valkey.ts`): one admin connection (`default` user, `VALKEY_PASSWORD`). 64 MB cap (`CACHE_MAXMEMORY`), `allkeys-lru`, RDB snapshot at most every 15 min + on shutdown, no AOF (SD card). The API starts without it; cache/ratelimit routes answer 503 until it's back. Bun's `RedisClient` doesn't reliably reconnect, so disconnected clients are replaced before sending (never retried after: a command could run twice). Bun reports some error replies (NOPERM) as `ERR_REDIS_INVALID_RESPONSE`; `isServerError` checks the reply prefix.
- **Cache** (`cache.ts`, `mybase.cache_projects`): ACL user = project name, `~<p>:* &<p>:*`, `+@all -@dangerous -@admin` minus commands that list/count other projects' keys or channels (`SCAN`, `KEYS`, `DBSIZE`, `PUBSUB CHANNELS`, …). Only SHA-256 of the password is stored; Valkey takes it as `#<hash>`, and ACLs live in memory only, so every admin (re)connect re-applies them (`onValkeyConnect`). HTTP (API key with `cache:write`; the password is for TCP only): one connection per project as its user, with a second password the API derives from a per-boot secret (`internalPassword`, never stored, re-applied with the ACLs) (Valkey enforces the ACL; the API doesn't parse commands), blocking/subscribe/transaction commands refused, `/multi-exec` gets its own connection. RESP3 maps become flat arrays for Upstash clients. The project name `default` can't use the cache.
- **Rate limits** (`ratelimit.ts`, `mybase.ratelimit_projects` + `ratelimit_rules`): counters under `mybase:rl:<p>:<rule>:<id>`, outside the project's cache ACL. One Lua script per algorithm (`EVALSHA`, reloaded on `NOSCRIPT`), time from Valkey `TIME`. Stats: `HINCRBY mybase:rlstats:<p>:<rule>:<hour>` inside the same script, 8-day TTL, no Postgres writes. Apps use an API key with `ratelimit:write`; rules and the enabled flag are cached in memory. Rules have a `source` like cron jobs (`mybase ratelimit sync`). SDK fails open on network errors/5xx unless `failClosed`. Eviction can reset a count early.
- **Queues** (`queue.ts`, `mybase.queue_projects` + `queues` + `queue_messages` + `queue_dedup` + `queue_stats`): a message is a row; receiving sets a fresh `receipt` token and pushes `visible_at` out by the visibility timeout (in flight = receipt set and `visible_at` in the future). Receipts are `<message id>.<token>`; only the latest works. Standard receives use `for update skip locked`; FIFO sends and receives take a per-queue advisory lock, and a group is blocked while any of its messages is in flight or an earlier one is delayed. FIFO dedup ids live 5 min in `queue_dedup`. Messages received `max_receives` times move to the dead-letter queue at the next receive (`dead_lettered_from` remembers the source for redrive). Long polls (≤ 20 s, route extends Bun's idle timeout) wait in memory, woken by sends/visibility changes/FIFO deletes or a timer for the next `visible_at`, so **one API instance** again. Stats counted in memory, upserted every 5 min and on shutdown/stats reads (SD card), kept 8 days; expired messages pruned hourly. Apps use an API key with `queue:read|write` (receive is a write). Queues have a `source` (`dashboard`/`code`/`api`); `code` ones change only via `mybase queue sync`, which confirms before deleting queues (messages go too). App `createQueue` is idempotent for identical settings. Bun SQL: pass JSON as `${JSON.stringify(x)}::text::jsonb` (a plain `::jsonb` param double-encodes strings), and don't `order by` a column you also select as an alias (`seq::text as seq`).
- **Web search** (`search.ts`, `search-fetch.ts`, `mybase.search_projects`): SearXNG runs internal only (`SEARXNG_URL`, no published port in prod; settings inline in compose `configs`, limiter off, JSON format on). Curated engines: Bing, Mojeek, Yahoo (re-enabled; off by SearXNG default), DuckDuckGo, Brave, Wikipedia, GitHub + Stack Overflow (`it`), DDG/Bing news. Google and Qwant are left out: they block non-browser traffic outright. All queries leave from the host IP, so engines get rate-limited/CAPTCHA'd and SearXNG suspends them for a while; on a residential IP, DDG/Brave often fail. App routes are GET (`search:read`): `/search/:project?q=` and `/search/:project/fetch?url=`; the dashboard's Try it panel uses the same handlers at `/projects/:name/search[/fetch]`. Cache in Valkey under `mybase:search:<p>:` (searches 1 h keyed on lowercased query; pages 1 day, only ≤ 50k chars since Valkey memory is shared with project caches); Valkey down → uncached (skipped 30 s after a failure). Throttles in memory: 60 searches + 120 fetches/min per project; 4 SearXNG + 8 page fetches in flight. Fetch: http(s) only, no credentials, every hop's host resolved and all addresses must be public (`isPublicIp`: also v4-mapped/NAT64 v6), manual redirects ≤ 5, 10 s, 2 MB, HTML/text/JSON only (415). DNS rebinding between check and connect isn't closed (Bun fetch can't pin the IP for https). Extraction: linkedom + Readability (fallback: body minus nav/header/footer) + Turndown; images and anchor/empty links dropped. No JS rendering. Never log queries or URLs (fetch logs the host).
- **Secrets** (`secrets.ts`, `secrets-crypto.ts`, `secrets-link.ts`; `mybase.secrets_projects` + `secrets_envs` + `secrets_values` + `secrets_revisions` + `secrets_changes`): `MYBASE_SECRETS_KEY` (32 bytes base64, never stored) wraps a random per-project AES-256-GCM data key (`wrapped_key`, `master_id` = sha256 prefix to detect a wrong key). Values are `iv || ciphertext`, AAD `project\0envId\0key` (a moved row fails to decrypt). Unset key → secrets routes 503, rest of the API fine; `MYBASE_SECRETS_KEY_OLD` re-wraps data keys at boot. **Losing the master key loses every secret.** Every write is one revision (`commit` locks the env row); `secrets_changes` keeps old/new ciphertexts, so restore copies them back without re-encrypting (`rewind`), 200 revisions kept per env. Branch env = `parent_id` to a root env (one level); reads overlay parent + own. App route `GET /secrets/:project/:env` sends an ETag (`envId.rev.parentId.parentRev`), 304 on match. Env scoping: `api_tokens.environments` (`Grant.environments`), checked by the handlers (`requireEnv`, `requireAllEnvs` for env create/rename/delete and link), not by `allows`. `link` rotates the DB password (`alter role`), storage key (new Garage key, old ones deleted), and cache password if on, then writes managed keys to every linked env (`linked_envs`); managed keys are read-only to everyone else (409) and never restored. Other services' keys go along (`SERVICE_KEYS`/`APP_PERMISSIONS` in secrets-link.ts): stored ones copied (`MYBASE_CRON_SECRET`, `MYBASE_ANALYTICS_KEY`, `MYBASE_CAPTCHA_SECRET`), plus `MYBASE_API_KEY`, a project-limited token (`secrets_projects.linked_token`, new on each link, old revoked). `PUT /projects/:name/services/:id` with `{ link: true }` adds a service's keys to linked envs (`linkService`, token widened in place); disable removes them (best-effort); rotate routes call `relinkService` for envs already holding the key. Disabling secrets revokes the linked token. Values and key names are never logged (counts only). MCP tools and context return names only. `mybase secrets setup` stores `{project, env}` per directory in the CLI config (`dirs`), kept across login/logout.
- **Vector search** (`vector.ts`, `vector-embed.ts`; `mybase.vector_projects` + `vector_indexes`): documents live in the **project's own database**, one table per index in schema `mybase_vector` (`id`, `title`, `content`, `metadata` jsonb, `embedding vector(n)`, generated `tsv`, `updated_at`; GIN on tsv + metadata, HNSW on embedding). DDL and queries run on `projectSql` (superuser); the project role gets `usage` + `select` (default privileges), so apps can join in SQL but write only through the API. Enabling creates the `vector` extension + schema; disabling drops the schema. Index name = table name (`VECTOR_INDEX_PATTERN`), language from a fixed list of text search configs; both interpolated, always validated. Upsert = one `insert … select from jsonb_to_recordset($1::text::jsonb) … on conflict do update` (vectors passed as `'[…]'` text, duplicate ids deduped first). Query modes: text (`websearch_to_tsquery`, `ts_rank_cd`), vector (`<=>`/`<->`/`<#>`, `hnsw.iterative_scan = relaxed_order` for filtered scans), hybrid (RRF, k = 60, `topK*4` candidates each side); filter = `metadata @>`; `ts_headline` only on final hits. Bind only parameters the statement uses (Postgres can't type an unused `$n`). Embedding provider (admin-only `PUT /projects/:name/vector`, since the server calls its URL with document text): any OpenAI-compatible `/embeddings`; its API key is AES-GCM under `MYBASE_SECRETS_KEY` (`secretsMaster()`, AAD `project\0vector\0embed`, not re-wrapped on master rotation: re-enter it). Query embeddings cached in Valkey `mybase:vector:<p>:q:` for 1 day. `POST …/query` needs only `vector:read` (special-cased in `requirement`). Indexes have a `source` like queues (`mybase vector sync`). Texts and queries are never logged.
- **Docs + agents:** platform docs live in `docs/`, SDK docs in `packages/sdk/docs`; the image copies both under `DOCS_DIR` (`platform/`, `sdk/`). Loaded once at boot. `MYBASE_VERSION` (shared) is the platform version: `/health` reports it and the CLI warns on a major/minor mismatch; the SDK and CLI package.json versions equal it (cli.yml checks). Versions are bumped by hand only. New REST routes an agent should use get an MCP tool in `mcp.ts` (never destructive ones). New CLI output goes through `print(data, human)`; prompts through `confirm`.
- **Enabling a service** may return secrets (`EnableServiceResponse`): `PUT /projects/:name/services/:id` answers 200 with them (only the cache password now), else 204. The dashboard shows them once (`CredentialsDialog`).
- **Audit log** (`audit.ts`, `mybase.audit_events` + `audit_settings`): `logged()` runs every handler inside an AsyncLocalStorage scope (`withAuditScope`); at the end, `finishRequest` records the handler's own `audit()` events, or else an automatic one for any write (`autoEvent`: a route table → `token.created`, `secrets.changed`, …; unknown project routes → `<segment>.changed`). App data-plane routes are skipped (`SKIP`). `auditOnce` dedupes per actor (secret reads: hourly). `cleanMeta` drops keys that look like secrets: never put values, SQL, or bodies in meta. IPs are stored (security log). Buffered like analytics (10 s / 500, flushed on SIGTERM; `bun --watch` restarts lose the buffer). Ordered by `at` (ids follow flush order). Background work started during a request must use `outsideRequest` or its events land in a finished scope.
- **Alerts** (`alerts.ts`, `mybase.alert_channels` + `alert_rules` + `alert_state`): `onAudit` listener; `RuleState` (bursts, seen IPs/readers rebuilt from 30 days of audit at boot) → `Throttle` (15 min per rule+key) → ntfy or webhook (signed with `signCronRequest`, per-channel secret stored like the cron secret; ntfy tokens sealed with `MYBASE_SECRETS_KEY` when set). Rules ignore `alert.*`. `advisor.critical` runs daily, remembering alerted ids in `alert_state`.
- **Advisor** (`advisor.ts`): facts gathered (env, catalog queries on each project DB), then pure `instanceFindings`/`projectFindings`. Each check group has a 5 s timeout; a failure becomes an info finding. Never put secret values in findings.
- **Users** (`users.ts`, `mybase.users_projects`): enable creates schema `auth` (owned by the project role, so the app's Better Auth migrations work) + `mybase_auth.uid()` (`current_setting('mybase.user_id')`); disable drops both. Better Auth owns its tables and plugins add columns, so reads look columns up first (camelCase or snake_case). Revoking deletes the session row and its Valkey copy (`<p>:auth:<token>`, the SDK's secondary storage keys). App events (`POST /users/:p/events`, `users:write`) become `users.*` audit entries with the end user's IP.
- **Captcha** (`captcha.ts`, `mybase.captcha_projects`): stateless challenges (salt with `?expires=`, sha256(salt+n), HMAC under a per-project key); verify checks HMAC, expiry, hash, then `SET mybase:captcha:<p>:<sig> NX` (Valkey down → refused). `siteverify` speaks Turnstile's format (JSON or form), which Better Auth's captcha plugin calls via `siteVerifyURLOverride`. `/captcha.js` = IIFE of `packages/sdk/src/captcha-widget.ts` (`CAPTCHA_SCRIPT` in the image).
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
- [x] Platform admin auth: one admin, session cookie + API tokens
- [x] Auth for project apps: Better Auth in the app, backed by the users service (no auth server in mybase)
- [~] How apps connect: direct Postgres connection string on LAN, WebSocket (`/db`, Neon serverless driver) from anywhere; REST API still open
- [ ] Backup/restore strategy (must include `MYBASE_SECRETS_KEY`, kept apart from DB backups)
- [x] Interface for adding new services: `ServiceModule` + `SERVICES` (cron is the reference)
- [x] Method for public exposure: Cloudflare Tunnel; Postgres over WebSocket at `/db`
- [ ] API framework (dashboard: React + shadcn/ui, decided)
- [~] Where the control plane stores its own metadata: `mybase` schema in shared Postgres (cron uses it); projects still live in database comments
- [ ] Non-goals list

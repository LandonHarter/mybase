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
| Postgres           | v1     | Reuse official `postgres` image | Database + role per project |
| File storage       | v1     | `TBD`                   | Bucket per project. Candidates: MinIO, SeaweedFS, Garage, or custom TS over the filesystem |
| Control plane API  | v1     | Custom (Bun/TS)         | Project registry and provisioning |
| CLI                | v1     | Custom (Bun/TS)         | e.g. `mybase project create <name>` (command shape `TBD`) |
| Dashboard          | v1     | Custom (React + shadcn/ui) | Design standard in `DESIGN.md` |
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
- **Control-plane metadata store:** `TBD` (a schema in the shared Postgres, or SQLite)

## Networking and security

- Private first: reachable over LAN / Tailscale.
- Public exposure later. This will need TLS, a reverse proxy or tunnel, and hardened auth. Approach `TBD`.
- Secrets management (project credentials, admin credentials): `TBD`.

## Repo layout

Bun workspace monorepo:

```
apps/api         control plane (plain Bun.serve). Provisions a role + database per project via Bun.sql
apps/cli         `mybase` CLI (plain arg parsing, talks to the API)
apps/dashboard   web UI (React + shadcn/ui via Bun HTML import; see DESIGN.md)
packages/shared  shared types + constants (@mybase/shared)
docker/          Dockerfile (control-plane image), compose.yml (end users), compose.dev.yml (dev Postgres)
.github/         docker.yml: builds amd64+arm64 image, pushes to ghcr.io/landonharter/mybase
```

## Dev commands

```
bun install
bun run dev              # api + dashboard together, prefixed/colored output
bun run dev:api          # API on :4000 (API_PORT)
bun run dev:dashboard    # dashboard on :4001 (DASHBOARD_PORT)
bun run cli project create <name>
bun run cli project list
bun run typecheck
bun run db:up / db:down  # dev Postgres via docker/compose.dev.yml
```

Ports default to 4000/4001 (3000 often taken by other local dev servers). See `.env.example`.

## Docker (how end users run mybase)

- **One image** (`docker/Dockerfile`): the API serves the pre-built dashboard (`DASHBOARD_DIR`) on one port, 4000. The dashboard always calls the API same-origin; in dev, `apps/dashboard/src/server.ts` proxies non-page requests to the API to match.
- **End users** download `docker/compose.yml`, set `POSTGRES_PASSWORD` in `.env`, and run `docker compose up -d`. It runs the published image + `postgres`. `MYBASE_IMAGE` overrides the image (e.g. a local build).
- **Build locally:** `docker build -f docker/Dockerfile -t mybase:local .` (legacy builder without buildx needs `--build-arg BUILDPLATFORM=linux/amd64`). The build stage runs on the native platform (output is plain JS/CSS); only the runtime stage is per-arch.
- **Project registry** (stopgap until the metadata store is decided): Postgres itself. A project is a database whose comment starts with `{"mybase":`, owned by a same-named login role. Passwords are returned once at creation and never stored.

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

- [ ] Storage backend choice (MinIO vs SeaweedFS vs Garage vs custom)
- [ ] Platform admin auth vs. auth-as-a-service for project apps
- [ ] How apps connect: a direct Postgres connection string, a generated REST API, or both
- [ ] Backup/restore strategy
- [ ] Interface for adding new services (module/plugin contract)
- [ ] Method for public exposure
- [ ] API framework (dashboard: React + shadcn/ui, decided)
- [ ] Where the control plane stores its own metadata
- [ ] Non-goals list

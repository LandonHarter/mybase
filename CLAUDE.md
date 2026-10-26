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
| Dashboard          | v1     | Custom (TS)             | Framework `TBD` |
| Auth (for apps)    | Later  | `TBD`                   | |
| Auto REST API      | Later  | `TBD`                   | |
| Realtime           | Later  | `TBD`                   | |
| Functions          | Later  | `TBD`                   | |
| Backups            | Later  | `TBD`                   | Especially important given the SD card risk |

## Tech stack

- **Language:** TypeScript
- **Runtime:** Bun
- **API framework:** `TBD` (Hono and Elysia are candidates)
- **Dashboard framework:** `TBD`
- **Control-plane metadata store:** `TBD` (a schema in the shared Postgres, or SQLite)

## Networking and security

- Private first: reachable over LAN / Tailscale.
- Public exposure later. This will need TLS, a reverse proxy or tunnel, and hardened auth. Approach `TBD`.
- Secrets management (project credentials, admin credentials): `TBD`.

## Repo layout

Bun workspace monorepo (shells only, nothing real built yet):

```
apps/api         control plane (plain Bun.serve, in-memory registry for now)
apps/cli         `mybase` CLI (plain arg parsing, talks to the API)
apps/dashboard   web UI (Bun HTML import, plain TS, no framework yet)
packages/shared  shared types + constants (@mybase/shared)
docker/          compose.yml (Postgres; storage TBD)
```

## Dev commands

```
bun install
bun run dev:api          # API on :4000 (API_PORT)
bun run dev:dashboard    # dashboard on :4001 (DASHBOARD_PORT)
bun run cli project create <name>
bun run cli project list
bun run typecheck
bun run db:up / db:down  # shared Postgres via docker compose
```

Ports default to 4000/4001 (3000 often taken by other local dev servers). See `.env.example`.

## Open questions

- [ ] Storage backend choice (MinIO vs SeaweedFS vs Garage vs custom)
- [ ] Platform admin auth vs. auth-as-a-service for project apps
- [ ] How apps connect: a direct Postgres connection string, a generated REST API, or both
- [ ] Backup/restore strategy
- [ ] Interface for adding new services (module/plugin contract)
- [ ] Method for public exposure
- [ ] API framework and dashboard framework
- [ ] Where the control plane stores its own metadata
- [ ] Non-goals list

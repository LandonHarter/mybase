---
title: Database (Postgres)
summary: Connect to a project's Postgres over TCP or WebSocket (Neon driver), browse tables, run SQL, and enable extensions.
section: Services
order: 10
---

# Database (Postgres)

Every project has a Postgres 17 database named after the project, owned by a login role of the same name. The password is shown once by `mybase project create`.

## Connect over TCP (LAN, Tailscale)

```sh
DATABASE_URL=postgres://shop:<password>@<host>:5432/shop
```

Any driver works (`pg`, `postgres`, Prisma, Drizzle, psql).

## Connect over WebSocket (serverless, public internet)

Behind a Cloudflare Tunnel only HTTP gets through, so mybase serves Postgres over WebSocket at `{{MYBASE_URL}}/db`, in the protocol of Neon's serverless driver:

```ts
import { neonConfig, Pool } from "@neondatabase/serverless";

neonConfig.wsProxy = () => "{{MYBASE_URL}}/db".replace(/^\w+:\/\//, "");
neonConfig.useSecureWebSocket = "{{MYBASE_URL}}".startsWith("https");
neonConfig.pipelineConnect = false;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

Only project roles can log in through `/db`, and only to their own database.

## Tables and SQL

```sh
mybase context shop            # every table with its columns
```

The dashboard's Database page has a table editor and SQL editor. Over the API (or MCP):

- `GET /projects/<p>/database/schema`: tables and columns (`database:read`)
- `GET /projects/<p>/database/tables/<schema>/<table>?limit=50`: rows (`database:read`)
- `POST /projects/<p>/database/query` `{ "sql": "…" }`: SQL (`admin`)

Reads and SQL run as the project's role inside a transaction with a 15 s statement timeout.

## Extensions

pgvector (`vector`), PostGIS, hypopg, pg_partman, and `pg_stat_statements` are installed. Turn one on from the dashboard, or in SQL as admin: `create extension vector;`.

## Agent notes

- Keep schema in the app's migrations (Drizzle, Prisma, plain SQL files), not in one-off SQL against the live database.
- Values from the table API are Postgres text output; parse them yourself.
- The SQL route needs an `admin` key. Without one, use the app's own migration tooling with `DATABASE_URL`.
- Back up before destructive SQL: there is no built-in backup yet.

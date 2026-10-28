---
title: Database (Postgres)
summary: Connect to a project's Postgres over TCP (LAN or, with a port forward, the internet) or WebSocket (Neon driver), browse tables, run SQL, and enable extensions.
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

## Connect from anywhere (port forward)

With public Postgres turned on, the connection string works from any network and any driver:

```sh
DATABASE_URL=postgres://shop:<password>@db.example.com:5432/shop?sslmode=require
```

The server admin sets it up once with `mybase server database-public`:

1. The router forwards TCP 5432 to the mybase machine. This shows the home IP, and doesn't work behind carrier-grade NAT.
2. mybase keeps an unproxied DNS record (`db.<domain>`) on the network's public IPv4 address, checked every 5 minutes, through a Cloudflare token limited to DNS (`MYBASE_DNS_TOKEN`).
3. mybase gets a Let's Encrypt certificate for that name (DNS challenge, no port 80) and renews it 30 days before it expires. Connection strings end in `?sslmode=require` once it's installed, so `sslmode=verify-full` works too.

From the internet, only a project's own role can sign in, only to its own database, and only over TLS. The admin superuser is refused. On your network and Tailscale, nothing changes. Failed sign-ins wait half a second each (`auth_delay`).

Apps on the same network use the same name. That needs a router that supports NAT loopback (most do). Otherwise use the LAN address.

Status: dashboard → Database → Settings → Public access, `GET /database/public` (admin), or `mybase doctor`.

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
- Use the connection string as given. If it ends in `?sslmode=require`, keep it: from the internet, connections without TLS are refused.
- For serverless hosts without raw TCP (Vercel Edge, Cloudflare Workers), use the WebSocket route, even when public Postgres is on.

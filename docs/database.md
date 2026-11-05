---
title: Database (Postgres)
summary: Connect to a project's Postgres over TCP (LAN or, with a port forward, the internet) or WebSocket (Neon driver), browse tables, run SQL, and enable extensions.
section: Services
order: 10
---

# Database (Postgres)

Every project has a Postgres 17 database named after the project, owned by a login role of the same name. The password is shown once by `mybase project create`.

## Which address to use

The right host and TLS mode depend on where the code runs. `mybase database access shop` (or dashboard → Database → Settings → Reachability) lists every route, whether it's on, and its host and port:

```
hosting network   on   postgres:5432          hosted sites (project network)
server localhost  on   127.0.0.1:5432         on the server machine only
LAN               on   192.168.1.20:5432
Tailscale         off                         no Tailscale address set (MYBASE_TAILSCALE_HOST)
public            off                         off (`mybase database access <project> --public on`)
wss proxy         on   wss://mybase.example.com/db
```

Instead of copying one into an env, link it: `mybase secrets link -p shop -e prod --database`. Each reader then gets the right one: hosted sites the hosting network, `mybase run` the first route that answers from its machine, the local proxy when none does. See [Secrets](secrets.md#linked-service-connections).

`mybase database access shop --public on|off` turns internet access on or off (it runs `mybase server database-public`, so run it on the server). Linked keys follow without changes.

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

The server admin sets it up once with `mybase database access <project> --public on` (or `mybase server database-public`):

1. The router forwards TCP 5432 to the mybase machine. This shows the home IP, and doesn't work behind carrier-grade NAT.
2. mybase keeps an unproxied DNS record (`db.<domain>`) on the network's public IPv4 address, checked every 5 minutes, through a Cloudflare token limited to DNS (`MYBASE_DNS_TOKEN`).
3. mybase gets a Let's Encrypt certificate for that name (DNS challenge, no port 80) and renews it 30 days before it expires. Connection strings end in `?sslmode=require` once it's installed, so `sslmode=verify-full` works too.

From the internet, only a project's own role can sign in, only to its own database, and only over TLS. The admin superuser is refused. On your network and Tailscale, nothing changes. Failed sign-ins wait half a second each (`auth_delay`).

Apps on the same network use the same name. That needs a router that supports NAT loopback (most do). Otherwise use the LAN address.

Status: dashboard → Database → Settings → Public access, `GET /database/public` (admin), or `mybase doctor`.

**The connection string signs in as the project's owner role.** With public access on, anyone holding it can read and change all of the project's data from anywhere. If only you need to reach the database from outside (migrations, a laptop), use the local proxy below and leave the port closed.

`--public off` removes the internet rules from `pg_hba.conf`, deletes the DNS record mybase kept, and stops linked keys from using the public host. mybase can't change your router: remove the port forward yourself.

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

## Local proxy

`mybase db proxy` turns the WebSocket route into a normal Postgres port on your machine, so psql, `prisma migrate`, and any driver work from anywhere the API is reachable, with port 5432 closed:

```sh
mybase db proxy -p shop --port 5432
# postgres://shop:<password>@127.0.0.1:5432/shop?sslmode=disable
```

Use `sslmode=disable`: the bytes are already inside `wss://`. `mybase run` starts a proxy by itself when a linked `DATABASE_URL` has no direct route from the machine, points the URL at it, and stops it when the command exits, so `mybase run -e dev -- bun dev` works off the LAN with public access off.

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

## Security

- The connection string is the project's owner role: share it like a password. Force row-level security on tables that end users reach through your app (`rls-not-forced`).
- The table editor runs as the project's role through an unprivileged login, so code in the database never runs as superuser. The SQL editor and extensions are admin-only; enabling an extension runs its install script as superuser, so enable them on databases whose owner you trust.
- From the internet, prefer `/db` over the tunnel; with public Postgres, limit 5432 in your firewall to your apps.

More: [Security best practices](security-best-practices.md#database).

## Agent notes

- Keep schema in the app's migrations (Drizzle, Prisma, plain SQL files), not in one-off SQL against the live database.
- Values from the table API are Postgres text output; parse them yourself.
- The SQL route needs an `admin` key. Without one, use the app's own migration tooling with `DATABASE_URL`.
- Back up before destructive SQL: `mybase server backup` on the server (it copies the whole instance).
- Link `DATABASE_URL` (`mybase secrets link -e <env> --database`) rather than writing a host into it; `mybase database access <project>` shows which routes exist.
- From a machine without a direct route, use `mybase run` or `mybase db proxy`, not public access.
- Use the connection string as given. If it ends in `?sslmode=require`, keep it: from the internet, connections without TLS are refused.
- For serverless hosts without raw TCP (Vercel Edge, Cloudflare Workers), use the WebSocket route, even when public Postgres is on.

---
title: Self-hosting
summary: Run mybase with Docker Compose on a Pi or server, configure env, update, and expose it with a Cloudflare Tunnel.
section: Reference
order: 30
---

# Self-hosting

mybase runs as four containers: the control plane (API + dashboard on :4000), Postgres (:5432), Garage S3 (:3900), and Valkey (:6379). All images are multi-arch (arm64 + amd64). Needs Docker Compose 2.23.1+.

```sh
curl -fsSLO https://raw.githubusercontent.com/landonharter/mybase/master/docker/compose.yml
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)" >> .env
echo "GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "VALKEY_PASSWORD=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Open http://localhost:4000 and create the admin account (first-run setup works only from the machine or LAN; or set `MYBASE_ADMIN_PASSWORD`).

## Useful settings (`.env`)

| Variable | Use |
| --- | --- |
| `MYBASE_PUBLIC_HOST` | LAN/Tailscale name apps use to reach this machine |
| `MYBASE_PUBLIC_URL` | Public URL of the API (shown in docs, SDK snippets, MCP) |
| `MYBASE_S3_PUBLIC_URL` | Public S3 endpoint |
| `MYBASE_TRUST_PROXY=cloudflare` | Trust `CF-Connecting-IP` behind a Cloudflare Tunnel |
| `CACHE_MAXMEMORY` | Valkey memory cap (default 64mb) |
| `LOG_LEVEL`, `LOG_FORMAT=json` | Logging |

## Public access

Use a Cloudflare Tunnel (`COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN`): `mybase.<domain>` → `mybase:4000`, `s3.<domain>` → `garage:3900`. Postgres goes over WebSocket at `/db` (see [Database](database.md)). The steps are at the top of `compose.yml`.

## Update

```sh
docker compose pull && docker compose up -d
```

Update the CLI to the same minor version (`mybase version` warns when they differ).

## Agent notes

- Run exactly one API container: cron and queue long polls are coordinated in memory.
- On a Raspberry Pi with an SD card, prefer an SSD for Postgres; mybase batches writes to spare the card.
- There is no built-in backup yet: `pg_dumpall` the Postgres container and copy Garage's data volume.

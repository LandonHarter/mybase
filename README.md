<div align="center">

# mybase

### Your own backend platform. On your own hardware. For free.

Postgres, storage, cron, queues, cache, and analytics for every project,<br>
running on one box in your closet. Even a Raspberry Pi.

[![npm sdk](https://img.shields.io/npm/v/@mybase-dev/sdk?label=%40mybase-dev%2Fsdk&color=black)](https://www.npmjs.com/package/@mybase-dev/sdk)
[![npm cli](https://img.shields.io/npm/v/@mybase-dev/cli?label=%40mybase-dev%2Fcli&color=black)](https://www.npmjs.com/package/@mybase-dev/cli)
![arm64 + amd64](https://img.shields.io/badge/docker-arm64%20%2B%20amd64-black)
[![MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

---

## One command, one backend

```sh
$ mybase project create shop
```

That's it. `shop` now has:

```
  shop
  ├── 🐘  Postgres      its own database + role
  ├── 🪣  Storage       its own S3 bucket + keys
  └── 🔑  Credentials   shown once, never stored
```

And when you need more, flip a switch:

```
  ⏰  Cron         signed calls to your app on a schedule
  📬  Queues       SQS-style standard + FIFO, dead letters included
  ⚡  Cache        Redis-compatible, over TCP or HTTP
  🚦  Rate limits  sliding window, fixed window, token bucket
  📈  Analytics    cookieless page views, events, and errors
```

## Why

Cloud backends are great until the bill shows up, or you lose track of what's running where.
mybase gives you the parts you reach for every time, on a machine you already own.
If something's missing, you can add it yourself.

## How it fits together

```
   mybase CLI ──┐                          ┌──▶  Postgres   database per project
                │                          ├──▶  Garage     bucket per project
   Dashboard ───┼──▶  mybase  (Bun + TS) ──┼──▶  Valkey     cache + rate limits
                │                          ├──▶  SearXNG    web search
                │                          └──▶  cron, queues, analytics (built in)
   Your apps ───┘   @mybase-dev/sdk
```

**Shared services, isolated data.** One of each server; every project gets its own walled-off slice.

## Get it running

You need a Linux or macOS machine with [Docker](https://docs.docker.com/engine/install/) (Compose 2.23.1+), arm64 or amd64.
A Raspberry Pi 4/5 with 4 GB is plenty.

```sh
curl -fsSL https://raw.githubusercontent.com/LandonHarter/mybase/master/scripts/install.sh | sh -s -- --setup
```

That installs the `mybase` CLI and starts the setup wizard. It walks you through everything, and nothing changes until you confirm at the end:

```
  ✔  Checks         Docker, Compose, memory, disk (and warns about SD cards on a Pi)
  🔑  Keys           generates every password and key for you
  🏠  Your network   picks the LAN / Tailscale address your apps will use
  🌍  The internet   sets up a Cloudflare Tunnel, automatically or step by step
  🔁  Start on boot  keeps mybase running in the background, across reboots and crashes
  👤  Admin          creates your account and signs the CLI in
  ⚙️  Advanced       ports, cache memory, storage size, log level
```

Everything lands in `~/mybase` (`.env` + `compose.yml`). Then:

```sh
mybase project create shop
```

Already have the CLI? Run `mybase server setup`.

### Running it day to day

```sh
mybase update                   # update the CLI, then the server on this machine
mybase server status            # containers, health, start-on-boot
mybase server update            # just the server: new images, restart (your data stays)
mybase server autostart on|off  # start when the machine boots
mybase server tunnel            # add or change the Cloudflare Tunnel (--off removes it)
mybase server setup             # change any setting later; keys are kept
```

Using mybase from another computer? Install the CLI there (`curl -fsSL …/install.sh | sh`) and run `mybase login --url http://<server>:4000`.

### On the internet, with a Cloudflare Tunnel

The tunnel gives mybase HTTPS on your own domain without opening router ports, and your home IP stays hidden.
You need a domain on Cloudflare (the free plan works). In the wizard, pick **The internet**, then choose a mode:

**Automatic.** Create an API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (Custom token) with:

- Account › Cloudflare Tunnel › Edit
- Zone › DNS › Edit
- Zone › Zone › Read

Paste it, pick your domain, and the wizard creates the tunnel, routes `mybase.<domain>` and `s3.<domain>` to it, and adds the DNS records. The token is used once and never saved.

**By hand.** In the Cloudflare dashboard:

1. Add your domain to Cloudflare and switch its nameservers at your registrar.
2. Go to [Zero Trust](https://one.dash.cloudflare.com) → Networks → Tunnels → **Create a tunnel** → Cloudflared, and name it `mybase`.
3. Skip installing a connector, because mybase runs one in Docker. Copy the token: it's the long string after `--token` in the install commands.
4. Add two public hostnames (type HTTP):

   | Hostname | Service | For |
   | --- | --- | --- |
   | `mybase.<domain>` | `mybase:4000` | dashboard, API, Postgres over WebSocket |
   | `s3.<domain>` | `garage:3900` | S3 for your apps |

5. Paste the token and hostname into the wizard.

The wizard can also close the Postgres, S3, and cache ports on your network, so the tunnel is the only way in.
From serverless hosts, apps reach Postgres at `wss://mybase.<domain>/db` (`@neondatabase/serverless`) and the cache at `https://mybase.<domain>/cache/<project>`.
Cloudflare's free plan caps uploads at 100 MB, so bigger uploads only work on your network.

> **Turn on two-factor sign-in** (Settings → Two-factor authentication) before you share the public URL.

### Back up

- **`MYBASE_SECRETS_KEY`** in `~/mybase/.env`. Keep a copy off the machine, in a password manager for example. Without it, the secrets service's data can't be decrypted.
- Postgres: `docker compose exec postgres pg_dumpall -U mybase > backup.sql` (from `~/mybase`).
- Files: Garage's `garage-meta` and `garage-data` volumes.

<details>
<summary><b>Manual install (no wizard)</b></summary>

```sh
mkdir ~/mybase && cd ~/mybase
curl -fsSLO https://raw.githubusercontent.com/LandonHarter/mybase/master/docker/compose.yml
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)
VALKEY_PASSWORD=$(openssl rand -hex 32)
SEARXNG_SECRET=$(openssl rand -hex 32)
MYBASE_SECRETS_KEY=$(openssl rand -base64 32)
EOF
chmod 600 .env
docker compose up -d
```

Open http://localhost:4000 from this machine or your network and create the admin account.
Other settings go in `.env` (then `docker compose up -d`):

| Variable | Use |
| --- | --- |
| `MYBASE_PUBLIC_HOST` | LAN/Tailscale name apps use to reach this machine |
| `MYBASE_PORT`, `POSTGRES_PORT`, `GARAGE_S3_PORT`, `VALKEY_PORT` | Published ports (4000, 5432, 3900, 6379) |
| `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN` | Run the Cloudflare Tunnel |
| `MYBASE_PUBLIC_URL`, `MYBASE_S3_PUBLIC_URL` | Public URLs (`https://mybase.<domain>`, `https://s3.<domain>`) |
| `MYBASE_TRUST_PROXY=cloudflare` | Trust Cloudflare's client IP header (set it with the tunnel) |
| `POSTGRES_BIND`, `GARAGE_S3_BIND`, `VALKEY_BIND` | `127.0.0.1` closes those ports to the network |
| `MYBASE_RESTART=no` | Don't start mybase again after a reboot (default: always) |
| `MYBASE_ADMIN_PASSWORD` | Create the admin on first boot instead of in the browser |
| `CACHE_MAXMEMORY`, `GARAGE_CAPACITY`, `LOG_LEVEL` | Tuning |

For start on boot, Docker itself has to start at boot: `sudo systemctl enable docker`.

</details>

## Use it from your app

```ts
import { createQueueClient } from "@mybase-dev/sdk/queue";

const queue = createQueueClient({ apiUrl, project: "shop", apiKey });

await queue.send("emails", { to: "ada@example.com" });
queue.consume("emails", async (msg) => sendEmail(msg.json()));
```

Postgres is plain Postgres: any driver on your LAN, or over WebSocket from serverless hosts.
Storage is plain S3: any S3 client works.

## Built for agents, too

Every mybase instance serves its docs at `/llms.txt` and runs an MCP server at `/mcp`.
`mybase agent init` drops an `AGENTS.md`, a skill, and `.mcp.json` into your app, so your coding agent knows how to use your backend.

---

<div align="center">

**[Quickstart](docs/quickstart.md)** · **[Concepts](docs/concepts.md)** · **[CLI](docs/cli.md)** · **[SDK](packages/sdk/README.md)** · **[Self-hosting](docs/self-hosting.md)**

MIT © Landon Harter

</div>

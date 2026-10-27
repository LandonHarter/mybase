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
                │                          └──▶  cron, queues, analytics (built in)
   Your apps ───┘   @mybase-dev/sdk
```

**Shared services, isolated data.** One of each server; every project gets its own walled-off slice.

## Get it running

```sh
curl -fsSLO https://raw.githubusercontent.com/LandonHarter/mybase/master/docker/compose.yml
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"   > .env
echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)"  >> .env
echo "GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "VALKEY_PASSWORD=$(openssl rand -hex 32)"    >> .env
docker compose up -d
```

Open **http://localhost:4000**, create your admin account, and make your first project.

Grab the CLI:

```sh
curl -fsSL https://raw.githubusercontent.com/LandonHarter/mybase/master/scripts/install.sh | sh
mybase login --url http://localhost:4000
```

Want it on the internet? Add a Cloudflare Tunnel. No open router ports, home IP stays hidden.
See [self-hosting](docs/self-hosting.md).

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

## Made for small machines

- 🍓 Runs on a **Raspberry Pi 4/5 with 4 GB**. Also any arm64 or amd64 box with Docker.
- 💾 Light on writes: buffered analytics, batched stats, no AOF. Your SD card will thank you.
- 🧩 Proven parts where they fit (Postgres, Garage, Valkey), small custom TypeScript where they don't.

---

<div align="center">

**[Quickstart](docs/quickstart.md)** · **[Concepts](docs/concepts.md)** · **[CLI](docs/cli.md)** · **[SDK](packages/sdk/README.md)** · **[Self-hosting](docs/self-hosting.md)**

MIT © Landon Harter

</div>

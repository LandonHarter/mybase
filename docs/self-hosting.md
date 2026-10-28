---
title: Self-hosting
summary: Install mybase with `mybase server setup` (keys, LAN/Tailscale, Cloudflare Tunnel, start on boot), configure env, update, and back up.
section: Reference
order: 30
---

# Self-hosting

mybase runs as Docker Compose services: the control plane (API + dashboard on :4000), Postgres (:5432), Garage S3 (:3900), Valkey (:6379), and SearXNG (internal). All images are multi-arch (arm64 + amd64). Needs Docker with Compose 2.23.1+.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/LandonHarter/mybase/master/scripts/install.sh | sh -s -- --setup
```

This installs the CLI and runs `mybase server setup`, a wizard that checks Docker, generates every key, asks how mybase should be reached (your network / Tailscale, the internet through a Cloudflare Tunnel), whether it should start on boot, and creates the admin account. It writes `~/mybase/.env` (mode 600) and `compose.yml`, starts the stack, and signs the CLI in. Rerun it any time to change settings: existing keys are kept.

| Command | Does |
| --- | --- |
| `mybase server setup` | Install, or change settings (`--dir` for another location) |
| `mybase server status` | Containers, health, start on boot |
| `mybase server update` | Pull new images, refresh `compose.yml`, restart |
| `mybase server tunnel [--off]` | Add, replace, or remove the Cloudflare Tunnel |
| `mybase server autostart on\|off` | Start on boot (restart policy + `systemctl enable docker`) |

Scripted install (no prompts): `mybase server setup --yes [--public-host <h>] [--tunnel-token <t> --domain <d>] [--port <n>] [--no-autostart] [--admin-user <u> --admin-password-stdin] [--json]`.

Manual install without the CLI: download `docker/compose.yml`, write a `.env` with `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `VALKEY_PASSWORD`, `SEARXNG_SECRET` (random hex) and `MYBASE_SECRETS_KEY` (`openssl rand -base64 32`), then `docker compose up -d`. Open http://localhost:4000 and create the admin account (first-run setup works only from the machine or LAN; or set `MYBASE_ADMIN_PASSWORD`).

## Useful settings (`.env`)

| Variable | Use |
| --- | --- |
| `MYBASE_PUBLIC_HOST` | LAN/Tailscale name apps use to reach this machine |
| `MYBASE_PUBLIC_URL` | Public URL of the API (shown in docs, SDK snippets, MCP) |
| `MYBASE_S3_PUBLIC_URL` | Public S3 endpoint |
| `MYBASE_TRUST_PROXY=cloudflare` | Trust `CF-Connecting-IP` behind a Cloudflare Tunnel |
| `MYBASE_RESTART=no` | Don't restart after a reboot or crash (default `unless-stopped`) |
| `POSTGRES_BIND`, `GARAGE_S3_BIND`, `VALKEY_BIND` | `127.0.0.1` closes those ports to the network |
| `CACHE_MAXMEMORY` | Valkey memory cap (default 64mb) |
| `LOG_LEVEL`, `LOG_FORMAT=json` | Logging |

## Two-factor sign-in

Turn it on in **Settings → Two-factor authentication**: scan the QR code with any TOTP app (1Password, Bitwarden, Google Authenticator, …), enter a code, and save the 10 recovery codes it shows (once). From then on the dashboard and `mybase login` ask for a code after the password. A recovery code works once in place of a code. API tokens keep working without a code, and 2FA can only be changed from a signed-in browser, not with a token.

- The TOTP secret is encrypted with `MYBASE_SECRETS_KEY` when that's set. Rotating the key with `MYBASE_SECRETS_KEY_OLD` moves it along. Without the right key, codes can't be checked (recovery codes still work).
- Lost the phone and the codes? Restart once with `MYBASE_ADMIN_RESET_MFA=1` (it turns 2FA off), then remove it and turn 2FA on again.
- Codes depend on the clock: keep the server's time synced (NTP).

## Public access

Use a Cloudflare Tunnel: no router ports, home IP hidden. `mybase server tunnel` (or the setup wizard) sets it up either automatically, with a Cloudflare API token (Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit, Zone › Zone › Read; used once, not saved), or by hand: create a tunnel in Zero Trust → Networks → Tunnels, add public hostnames `mybase.<domain>` → `http://mybase:4000` and `s3.<domain>` → `http://garage:3900`, and paste its token. Either way `.env` gets `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN`, `MYBASE_PUBLIC_URL`, `MYBASE_S3_PUBLIC_URL`, and `MYBASE_TRUST_PROXY=cloudflare`. Postgres goes over WebSocket at `/db` (see [Database](database.md)). The free plan caps request bodies at 100 MB.

## Update

```sh
mybase update
```

That replaces the CLI binary with the latest release (`--version <v>` for another), then runs `mybase server update` with the new binary, so `compose.yml` matches it. `--cli` updates only the CLI. Installed with npm/bun instead? `bun add -g @mybase-dev/cli@latest`, then `mybase server update`. (Without the CLI: `docker compose pull && docker compose up -d` in the install directory.)

Update the CLI to the same minor version (`mybase version` warns when they differ).

## Agent notes

- Run exactly one API container: cron and queue long polls are coordinated in memory.
- On a Raspberry Pi with an SD card, prefer an SSD for Postgres; mybase batches writes to spare the card.
- Turn on two-factor sign-in before exposing mybase publicly. Agents use API tokens, which don't need a code.
- Install non-interactively with `mybase server setup --yes --json`; it never prompts then. It refuses to share the `mybase` compose project with another directory.
- `.env` in the directory you run the CLI from never reaches the server: compose's variables are stripped before `docker compose` runs.
- There is no built-in backup yet: `pg_dumpall` the Postgres container and copy Garage's data volume.

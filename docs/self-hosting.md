---
title: Self-hosting
summary: Install mybase with `mybase server setup` (keys, LAN/Tailscale, Cloudflare Tunnel, start on boot), configure env, update, and back up.
section: Reference
order: 30
---

# Self-hosting

mybase runs as Docker Compose services: the control plane (API + dashboard on :4000), Postgres (:5432), Garage S3 (:3900), Valkey (:6379), and SearXNG (internal). All images are multi-arch (arm64 + amd64). Needs Docker with Compose 2.23.1+.

On a cloud VM (AWS, GCP, Azure): see [Hosting on AWS, GCP, and Azure](cloud.md).

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
| `mybase server sandbox [--project p]` | Automate gVisor, matching images, worker config and optional project enablement ([guide](sandboxes.md)) |
| `mybase server tunnel [--off]` | Add, replace, or remove the Cloudflare Tunnel |
| `mybase server autostart on\|off` | Start on boot (restart policy + `systemctl enable docker`) |

Scripted install (no prompts): `mybase server setup --yes [--public-host <h>] [--tunnel-token <t> --domain <d>] [--port <n>] [--no-autostart] [--sandboxes] [--admin-user <u> --admin-password-stdin] [--json]`. Sandbox setup uses the same Linux Docker host and needs administrator access if gVisor isn't installed.

Before going further, read [Security best practices](security-best-practices.md): it has a checklist for home and cloud installs, and what each service expects from your app.

Manual install without the CLI: download `docker/compose.yml`, write a `.env` with `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `VALKEY_PASSWORD`, `SEARXNG_SECRET` (random hex) and `MYBASE_SECRETS_KEY` (`openssl rand -base64 32`), then `docker compose up -d`. Open http://localhost:4000 and create the admin account (first-run setup works only from the machine or LAN, and never through a proxy; or set `MYBASE_ADMIN_PASSWORD` and remove it after the first boot). Generate every value: never keep placeholders from examples.

## Useful settings (`.env`)

| Variable | Use |
| --- | --- |
| `MYBASE_PUBLIC_HOST` | LAN/Tailscale name apps use to reach this machine |
| `MYBASE_PUBLIC_URL` | Public URL of the API (shown in docs, SDK snippets, MCP) |
| `MYBASE_S3_PUBLIC_URL` | Public S3 endpoint |
| `MYBASE_TRUST_PROXY` | `cloudflare` behind the tunnel (believes `CF-Connecting-IP` only from the tunnel or Cloudflare's ranges), or your reverse proxy's IPs/CIDRs (`127.0.0.1,172.16.0.0/12`) to believe its `X-Forwarded-For`/`-Proto`. Unset: no proxy headers are believed |
| `MYBASE_OUTBOUND` | Where cron jobs and realtime webhooks may call: `lan` (default), `public` (recommended on a cloud server). Loopback, cloud metadata, and mybase's own containers are always refused |
| `MYBASE_BIND` | `127.0.0.1` keeps :4000 off the network (the tunnel and a local reverse proxy still reach it) |
| `CLOUDFLARED_REGION=us` | Keep the tunnel's connections on US data centers (default: nearest by anycast) |
| `CLOUDFLARED_PROTOCOL` | Tunnel transport: `auto` (default), `quic`, or `http2` (if UDP is blocked or flaky) |
| `MYBASE_RESTART=no` | Don't restart after a reboot or crash (default `unless-stopped`) |
| `POSTGRES_BIND`, `GARAGE_S3_BIND`, `VALKEY_BIND` | `127.0.0.1` closes those ports to the network |
| `CACHE_MAXMEMORY` | Valkey memory cap (default 64mb) |
| `LOG_LEVEL`, `LOG_FORMAT=json` | Logging |

## Security checklist

1. Two-factor sign-in on (below).
2. `MYBASE_SECRETS_KEY` backed up outside this machine, apart from database backups.
3. Only the ports you need reachable: `POSTGRES_BIND`, `GARAGE_S3_BIND`, `VALKEY_BIND` (and `MYBASE_BIND` on a public machine) = `127.0.0.1` otherwise. Docker's published ports skip `ufw`.
4. Internet access only through the Cloudflare Tunnel or an HTTPS reverse proxy with `MYBASE_TRUST_PROXY` set; never :4000 directly.
5. On a cloud server, `MYBASE_OUTBOUND=public`.
6. Apps get scoped API keys (`--perm … --project …`), never admin keys.
7. `mybase doctor` shows no `critical` or `warn` findings; alerts go to your phone (`mybase alerts add ntfy <url>`).

Details for each step and every service: [Security best practices](security-best-practices.md).

## Two-factor sign-in

Turn it on in **Settings → Two-factor authentication**: scan the QR code with any TOTP app (1Password, Bitwarden, Google Authenticator, …), enter a code, and save the 10 recovery codes it shows (once). From then on the dashboard and `mybase login` ask for a code after the password. A recovery code works once in place of a code. API tokens keep working without a code, and 2FA can only be changed from a signed-in browser, not with a token.

- The TOTP secret is encrypted with `MYBASE_SECRETS_KEY` when that's set. Rotating the key with `MYBASE_SECRETS_KEY_OLD` moves it along. Without the right key, codes can't be checked (recovery codes still work).
- Lost the phone and the codes? Restart once with `MYBASE_ADMIN_RESET_MFA=1` (it turns 2FA off), then remove it and turn 2FA on again.
- Codes depend on the clock: keep the server's time synced (NTP).

## Public access

Use a Cloudflare Tunnel: no router ports, home IP hidden. `mybase server tunnel` (or the setup wizard) sets it up either automatically, with a Cloudflare API token (Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit, Zone › Zone › Read; used once, not saved), or by hand: create a tunnel in Zero Trust → Networks → Tunnels, add public hostnames `mybase.<domain>` → `http://mybase:4000` and `s3.<domain>` → `http://garage:3900`, and paste its token. Either way `.env` gets `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN`, `MYBASE_PUBLIC_URL`, `MYBASE_S3_PUBLIC_URL`, and `MYBASE_TRUST_PROXY=cloudflare`. Postgres goes over WebSocket at `/db` (see [Database](database.md)). The free plan caps request bodies at 100 MB.

`mybase server status` lists the tunnel's connections and the Cloudflare data center each one uses (`ord08 quic`, …). None means the public URL answers 530 (Cloudflare can't reach the tunnel), so apps calling the API (secrets, cache, SDK) fail until cloudflared reconnects. Colos far from you (another continent) add that round trip to every request: set `CLOUDFLARED_REGION=us` (US hosts) in `.env` and run `mybase server update`.

## Update

```sh
mybase update
```

That replaces the CLI binary with the latest release (`--version <v>` for another), then runs `mybase server update` with the new binary, so `compose.yml` matches it. `--cli` updates only the CLI. Installed with npm/bun instead? `bun add -g @mybase-dev/cli@latest`, then `mybase server update`. (Without the CLI: `docker compose pull && docker compose up -d` in the install directory.)

Update the CLI to the same minor version (`mybase version` warns when they differ).

## Backups and moving to another machine

`mybase server backup` copies the whole instance into one `.mbk` file. `mybase server restore` rebuilds it on a machine that doesn't have mybase yet. `mybase server migrate` does both over the network. The copy is logical (a SQL dump, the stored objects, and the keys), so it works between CPU types, such as a Raspberry Pi and an x86 machine. Raw Docker volumes don't move safely between those.

What's included:

- `.env` with every key, including `MYBASE_SECRETS_KEY`, so stored secrets still decrypt.
- Postgres: every project database and role, with the same passwords, plus mybase's own data (admin, API keys, cron jobs, queues, secrets, audit log).
- Storage: buckets, files, and access keys. The keys keep the same id and secret, so apps' S3 credentials keep working.
- The cache snapshot (sessions, rate limit counters). Leave it out with `--no-cache`.
- Hosted sites' images, but only onto the same CPU type. On a different one, the restore lists the sites to deploy again.

While it reads the data, the API is stopped (Postgres, storage, and the cache keep running). After a backup, the API starts again. Both machines need the same mybase version (major.minor).

### Move over the network

Both machines need the CLI. On the **new** machine:

```sh
mybase server migrate receive
```

It prints a one-time code and a `send` command for each address it has. Run one of those on the **old** machine:

```sh
mybase server migrate send 192.168.1.20 --code ABCD-EFGH-…
```

The transfer is encrypted with the code, and nothing is staged on either disk. When the new machine is up, the old one stops all its containers so cron jobs, the tunnel, and hosted sites don't run twice. Its data stays in its volumes. Bring it back with `mybase server restart`, or remove it with `docker compose down -v`. Turn off its autostart (`mybase server autostart off`) so a reboot doesn't start it again.

A Cloudflare Tunnel moves with the `.env`, so public URLs keep working without changes. Apps that reached the old machine by its LAN or Tailscale address need the new one. `receive` asks which address to put in `MYBASE_PUBLIC_HOST` (or pass `--public-host`).

### Backup files

```sh
mybase server backup --encrypt                    # asks for a passphrase
mybase server backup --out /mnt/usb/mybase.mbk    # unencrypted: keep it safe
mybase server restore mybase.mbk                  # on the new machine
```

A backup without a passphrase holds `MYBASE_SECRETS_KEY` and every database in the clear. Encrypt it (`--encrypt`, or `--passphrase-stdin` in scripts), or store it like the key itself. A restore needs a machine with no mybase on it: no containers, no `.env`, and no volumes left from an earlier install (`docker compose down` without `-v` keeps them). `--force` on `restore` or `migrate receive` deletes all of that first, after a confirmation, and keeps the old `.env` as `.env.old-<time>`. If a restore stops partway, run it again with `--force`. The backup is never changed.

## Agent notes

- Run exactly one API container: cron and queue long polls are coordinated in memory.
- On a Raspberry Pi with an SD card, prefer an SSD for Postgres; mybase batches writes to spare the card.
- Turn on two-factor sign-in before exposing mybase publicly, and walk the security checklist above. Agents use API tokens, which don't need a code.
- Install non-interactively with `mybase server setup --yes --json`; it never prompts then. It refuses to share the `mybase` compose project with another directory.
- `.env` in the directory you run the CLI from never reaches the server: compose's variables are stripped before `docker compose` runs.
- Back up or move an instance with `mybase server backup|restore|migrate`. It works between CPU types and needs the same mybase version on both ends. Non-interactive runs need `--yes`, plus `--passphrase-stdin` for encrypted files. A restore needs a machine with no mybase install.

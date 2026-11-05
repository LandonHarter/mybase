---
title: Hosting
summary: Run your sites (Next.js, static, any Docker image) as containers on your mybase server, at <site>.<your domain>.
section: Services
order: 24
---

# Hosting

Sites run as containers on the same machine as mybase. You build the image on your own computer, `mybase deploy` pushes it to the project's [container registry](registry.md), and mybase starts it, waits until it answers, then switches traffic to it. If the new container crashes or never answers, the old one keeps serving.

```sh
mybase server hosting                     # once, on the server
mybase hosting enable shop                # once per project
mybase hosting init --template nextjs --project shop --site web
mybase deploy                             # → https://web.example.com
```

## Set up the server

Run `mybase server hosting` on the machine that runs mybase. It turns on three containers (Compose profile `hosting`):

- **registry**: stores your images (CNCF distribution, `registry:3`; see [Container registry](registry.md)). Internal only: pushes go through the mybase API, and Docker pulls from `127.0.0.1:5000`.
- **caddy**: routes `<site>.<domain>` to each site's live container. Its config comes from mybase.
- **hosting-worker**: starts and stops site containers. It's the only part with the Docker socket; the API never gets it.

It asks for the **base domain** (`MYBASE_HOSTING_DOMAIN`, e.g. `example.com`). With a Cloudflare Tunnel (`mybase server tunnel`), it adds one wildcard route, `*.example.com → caddy`, plus a proxied wildcard DNS record, using a Cloudflare API token it doesn't save. Explicit hostnames like `mybase.example.com` keep working: they're matched before the wildcard.

Use the zone itself as the base domain. Cloudflare's free certificate covers one level (`*.example.com`); `*.apps.example.com` needs their Advanced Certificate Manager.

Without a tunnel, Caddy answers plain HTTP on port 80 (`MYBASE_HOSTING_PORT`). Sites are reachable at `http://<site>.localhost` on the server, or at `<site>.<domain>` if you point that name at the machine yourself.

| Setting | Default | What it does |
|---|---|---|
| `MYBASE_HOSTING_DOMAIN` | none | Sites live at `<site>.<domain>` |
| `MYBASE_HOSTING_MEMORY` | `512m` | Memory cap per site container |
| `MYBASE_HOSTING_PORT` | `80` | Host port Caddy listens on |

`mybase hosting enable` also turns on the [container registry](registry.md) for the project: site images live in `<project>/<site>`. The registry can't be turned off while hosting is on.

## Sites

A project can have any number of sites. Each has a name (one DNS label, unique across the whole server, since they share the domain), a port the container listens on (default 3000, also passed as `$PORT`), and a health path (default `/`).

```sh
mybase hosting create shop web --port 3000 --health /api/health
mybase hosting sites shop
mybase hosting set shop web --port 8080
mybase hosting delete shop web
```

Names like `www`, `mybase`, `s3`, `db`, and `registry` are reserved, as are the first labels of mybase's own public hostnames.

## Deploying

`mybase deploy` reads `mybase.config.ts` (or `--project` and `--site`):

```ts
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  hosting: {
    sites: { web: { port: 3000, healthPath: "/", context: ".", dockerfile: "Dockerfile" } },
  },
});
```

It then:

1. builds the Dockerfile with `docker build --platform linux/<server arch>` (an `arm64` Pi needs buildx/QEMU on an `amd64` laptop),
2. saves the image and pushes its layers in 32 MB chunks (Cloudflare caps requests at 100 MB; plain `docker push` sends a layer in one request), skipping layers the registry already has,
3. starts a deploy and waits: the new container must answer its health path (any status below 500) within 90 seconds,
4. switches Caddy to it, and stops the old container 15 seconds later.

A deploy that fails keeps its error and the container's last 30 lines of output (`mybase hosting deploys shop web`). The previous deploy stays live. The site is created on first deploy if it doesn't exist.

The CLI needs an API key with `hosting:write` for the project (it covers pushing to the registry too). `mybase deploy --no-wait` returns once the deploy is queued.

### Pushing with docker

You can also push with `docker` and deploy the digest:

```sh
docker login mybase.example.com -u mybase      # password: an mb_… API key with registry:write
docker push mybase.example.com/shop/web:v1     # repository = <project>/<site>
curl -X POST https://mybase.example.com/projects/shop/hosting/sites/web/deploys \
  -H "Authorization: Bearer $MYBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"digest":"sha256:…"}'
```

Over plain HTTP (a LAN address), add it to Docker's `insecure-registries` first. Large layers fail through the tunnel; use `mybase deploy` there. Other repositories in the project (`shop/tools`, …) are ordinary registry images that hosting leaves alone.

## Templates

`mybase hosting init --template <t>` writes a Dockerfile and `.dockerignore` (and `mybase.config.ts` with `--project` and `--site`). Existing files are left alone unless `--force`.

| Template | For | Notes |
|---|---|---|
| `nextjs` | Next.js | Needs `output: "standalone"` in `next.config`. Multi-stage, runs `node server.js` as a non-root user |
| `static` | Vite, Astro, plain HTML | `npm run build` into `dist/` (`OUT_DIR` build arg), served by Caddy with SPA fallback |
| `node` | Bun or Node servers | `bun run start`; your server must listen on `$PORT` |

Every template installs with the lockfile it finds (npm, pnpm, yarn, or bun).

## Env vars and secrets

Each site has its own env vars, and optionally a [secrets](secrets.md) environment whose values are added at deploy time. Precedence: secrets env, then the site's vars, then mybase's own (`PORT`, `HOSTNAME`, `MYBASE_SITE`, `MYBASE_SITE_URL`, `MYBASE_DEPLOY_ID`).

```sh
mybase hosting env set shop web NEXT_PUBLIC_API=https://api.example.com
mybase hosting set shop web --secrets-env prod
mybase hosting redeploy shop web          # env changes apply on the next deploy
```

For the project's own database, cache, storage, and API, link the keys instead of writing connection strings: a linked key resolves to the project network's names inside the site, and to a reachable address for `mybase run` on your laptop (see [Secrets](secrets.md#linked-service-connections)).

```sh
mybase secrets link -p shop -e prod --database --cache --storage --api
mybase hosting redeploy shop web
```

Site vars are encrypted with `MYBASE_SECRETS_KEY` when it's set. Keep real secrets in a secrets environment anyway: values there have revisions and env-scoped keys. Next.js inlines `NEXT_PUBLIC_*` at build time, so those must be set while building, not here.

## Rollbacks, logs, retention

```sh
mybase hosting rollback shop web            # the previous live image
mybase hosting rollback shop web 1a2b3c4d   # a given deploy
mybase hosting logs shop web                # follows; --no-follow, --tail 500, --deploy <id>
```

In the dashboard, a site's **Logs** tab streams the same output live: it follows the live deploy across redeploys, or shows any earlier deploy whose container is still around (the Logs button on each deploy row). Filter by text or by errors/warnings, toggle timestamps and wrapping, and download what's loaded.

Before a new container takes traffic, every env value that's a URL with a host (`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, …) is tried from the project network. One that doesn't answer becomes a warning on the deploy, shown by `mybase deploy`, `mybase hosting deploys`, the dashboard, and at the top of `mybase hosting logs`:

```
DATABASE_URL → db.example.com:5432 unreachable from site network (timed out).
This project's Postgres is reachable here as postgres:5432. Run:
  mybase secrets link -p shop -e prod --database
  mybase hosting redeploy shop web
```

The deploy still goes on. To fail it instead, set `strictEnvCheck: true` on the site in `mybase.config.ts` (or `mybase hosting set shop web --strict-env-check on`). Only hosts and ports are checked and shown, never values.

A rollback is a new deploy of an older image, with the current env vars. The last 5 deploys per site keep their images; older images are deleted, and the registry is garbage-collected daily when nobody's pushing. Container logs are capped at two 5 MB files per container.

## Networking and isolation

Each project gets its own Docker network (`mybase-p-<project>`). Sites reach mybase's services on it by name: `postgres:5432`, `valkey:6379`, `garage:3900`, and `mybase:4000` (the API). You don't write these by hand: keys linked with `mybase secrets link --database|--cache|--storage|--api` resolve to them inside sites (TLS off, since the certificate is for the public name), and to other addresses elsewhere. Sites in other projects, the workers, and SearXNG aren't on it. Compose drops these extra networks whenever it recreates a container (`mybase server update`, a changed `.env`), so the hosting worker re-attaches mybase's services as soon as they start, at its own start, every 5 minutes, and before each deploy. `mybase database access` checks the hosting route live. Docker's default address pools allow about 30 networks, which caps the number of projects with hosting on.

Containers restart with Docker (`unless-stopped`), get Docker's default capabilities minus a few web servers don't need, and `no-new-privileges`. They aren't sandboxed like [sandboxes](sandboxes.md): only deploy images you trust.

Run exactly one API instance: it watches deploys in memory.

## Security

- Sites are ordinary containers on the Docker host (not gVisor): deploy only code you trust. A `hosting:write` key can run code on the project's network, so guard it like the database password.
- Serve sites from a different registrable domain than the dashboard. Env names that steer the hosting worker (`DOCKER_*`, `LD_*`, `PATH`, `HOME`) are refused.

More: [Security best practices](security-best-practices.md#hosting).

## Agent notes

- Deploy with `mybase deploy` from the app's directory; never ask for the server's Docker access.
- Sites must listen on `$PORT` and bind `0.0.0.0`. `HOSTNAME=0.0.0.0` is set for Next.js.
- A failed deploy's error includes the container's last output: read it with the `hosting_deploys` MCP tool or `mybase hosting deploys`.
- After changing env vars or the linked secrets env, redeploy (`hosting_redeploy`).
- For mybase services, link the keys in the site's secrets env (`mybase secrets link -p <p> -e <env> --database`); they resolve to `postgres:5432` and friends inside the site. Don't hand-write public or internal URLs.
- A deploy warning like `DATABASE_URL → … unreachable from site network` carries the fix command; run it, then redeploy.

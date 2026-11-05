---
title: Container registry
summary: A private Docker/OCI image registry per project. docker login with an API key, then push and pull <host>/<project>/<name>.
section: Services
order: 23
---

# Container registry

A private image registry for each project, on your own server. Sign in with an API key, then `docker push` and `docker pull` like any other registry. Images live under the project: `mybase.example.com/shop/api:latest`. Use it for images you run elsewhere (a VPS, CI, a Raspberry Pi), or just to keep builds off Docker Hub. [Hosting](hosting.md) stores its site images here too.

```sh
mybase server registry                     # once, on the server
mybase registry enable shop                # once per project
mybase token create shop-registry --perm registry:write --project shop
docker login mybase.example.com -u mybase  # password: the mb_… key
docker push mybase.example.com/shop/api:latest
```

## Set up the server

`mybase server registry` turns on the `registry` container (CNCF distribution, `registry:3`, Compose profile `registry`). `mybase server hosting` turns it on as well, so with hosting there's nothing more to do. The container is internal: every push and pull goes through the mybase API at `/v2/`, which checks the API key. It's also published on `127.0.0.1:5000` for the local Docker daemon (hosting pulls from there); nothing else can reach that port.

```sh
mybase server registry --off   # refused while hosting is on
mybase server registry gc      # free the space of deleted images
```

## Sign in

The user name can be anything (`mybase` by convention). The password is an API key:

| Permission | Can |
|---|---|
| `registry:read` | pull, list repositories and tags |
| `registry:write` | also push and delete |

Limit the key to the project (`--project shop`): a key only reaches the repositories of projects it can access. Keys with `hosting:read|write` keep working for the registry at the same level (that's how deploy keys pushed before the registry was its own service).

```sh
mybase registry info shop      # prints the login and push commands
```

Over plain HTTP (a LAN address like `192.168.1.10:4000`), add it to Docker's `insecure-registries` first.

## Repositories

Any name under the project, with slashes if you like: `shop/api`, `shop/tools/cli`. Repositories appear on first push. Names follow Docker's rules: lowercase letters, digits, and `.`, `_`, `-` between them.

```sh
mybase registry list shop
mybase registry tags shop api
mybase registry delete shop api sha256:…   # deletes the image and every tag that points at it
```

The dashboard's Container registry page shows the same: repositories, tags with digest, size, and platforms, and a delete button.

Images for any platform can be stored; this server only runs its own (`linux/arm64` on a Pi). Build with `docker buildx build --platform linux/amd64,linux/arm64 --push` to cover both.

## Hosting

[Hosting](hosting.md) keeps each site's images in `<project>/<site>`, pushed by digest (no tags), and deletes old ones itself (the last 5 deploys keep theirs). So:

- Turning on hosting turns on the registry for that project. The registry can't be turned off while hosting is on.
- `registry tags` lists the untagged digests a site's deploys use (`(untagged)`).
- Deleting an image a queued, starting, or live deploy uses is refused (409). Deleting an older one breaks rollbacks to it.

## Disk space

Deleting an image removes its manifest; the layers are freed by garbage collection. With hosting on, the hosting worker collects daily when nobody has pushed for 10 minutes. Otherwise run `mybase server registry gc` on the server. Pushes during a collection can fail, so run it when nobody's pushing.

`mybase server registry gc --untagged` also deletes manifests that no tag points at (a tag moved to a newer build leaves the old one untagged). It's refused while hosting is on, since hosted sites' images are untagged.

Turning the registry off for a project deletes every tagged image under `<project>/`.

## Limits

- Through a Cloudflare Tunnel, request bodies are capped at 100 MB, and `docker push` sends each layer in one request: layers bigger than that fail. Push over the LAN or Tailscale instead (`mybase deploy` chunks its uploads, so hosting isn't affected).
- One registry for the whole server. Repositories are separated by the project prefix, which the API enforces; there are no per-repository permissions.
- Backups (`mybase server backup`) include the registry, but restore it only onto the same CPU type.

## Security

- The registry is reachable only through the API. Every request needs an API key with `registry:read|write` (or `hosting:read|write`) for the project in the path. `/v2/_catalog`, which lists every project's repositories, needs an admin key.
- Paths with encoded characters (`%`) are refused, so the registry always sees the path the API checked. Cross-repository blob mounts are only allowed from the same project.
- A `registry:write` key can replace any image in its projects. If something runs those images (hosting, a VPS pulling `:latest`), the key is as powerful as that deployment: keep it in CI secrets, project-limited.
- Pushes and deletes are in the audit log (`registry.image.pushed`, `registry.image.deleted`).

More: [Security best practices](security-best-practices.md#container-registry).

## Agent notes

- Read repositories and tags with the `registry_repositories` and `registry_tags` MCP tools (read-only). Pushing needs Docker on the user's machine and a key with `registry:write`; ask the user for one, never for the admin key.
- Image names are `<host>/<project>/<name>[:tag]`. `registry_repositories` returns the prefix.
- To deploy a site, use `mybase deploy` (see [Hosting](hosting.md)), not a manual `docker push`.
- Never delete images in a site's repository unless asked: they're what rollbacks use.

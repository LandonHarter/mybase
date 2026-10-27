---
title: Quickstart
summary: Install the mybase CLI, sign in, create a project, and connect an app to its database and storage.
section: Start here
order: 2
---

# Quickstart

## Install the CLI

Standalone binary (Linux, macOS; no runtime needed):

```sh
curl -fsSL https://raw.githubusercontent.com/landonharter/mybase/master/scripts/install.sh | sh
```

Or with Bun: `bun add -g @mybase-dev/cli` (or run once with `bunx @mybase-dev/cli <command>`).

Check it: `mybase version` prints the CLI and server versions and warns when they differ.

## Sign in

```sh
mybase login --url {{MYBASE_URL}}
mybase whoami
```

`login` saves a token to `~/.config/mybase/config.json`. In CI or for agents, set `MYBASE_API_URL` and `MYBASE_TOKEN` (an API key) instead; env vars win over the saved login.

## Create a project

```sh
mybase project create shop
```

This prints the Postgres URL and the S3 credentials **once**. Put them in your app's `.env` (never commit it):

```sh
DATABASE_URL=postgres://shop:<password>@<host>:5432/shop
S3_ENDPOINT=…
S3_REGION=garage
S3_BUCKET=shop
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

## Turn on what you need

```sh
mybase queue enable shop
mybase cron enable shop        # prints the signing secret for MYBASE_CRON_SECRET
mybase cache enable shop       # prints the cache password once
mybase ratelimit enable shop
mybase analytics enable shop   # prints the public write key and a script tag
```

## Give your app an API key

The SDK authenticates with an API key limited to what the app uses:

```sh
mybase token create shop-app --project shop --perm queue:write,cron:write,cache:write,ratelimit:write
```

Put it in the app's server-side env as `MYBASE_API_KEY`, then `npm install @mybase-dev/sdk`. Start with the [SDK guide](sdk/getting-started.md).

## See what you have

```sh
mybase context shop            # services, tables, jobs, queues, env vars (no secrets)
mybase docs --search "dead letter"
```

## Agent notes

- Use `--json` on every command you parse; errors come as JSON on stderr with an `exitCode` (1 failure, 2 usage, 3 auth, 4 not found).
- Commands that delete data need `--yes` when there's no terminal. Ask the user first.
- `mybase agent init --project <name>` sets up AGENTS.md, a Claude skill, and `.mcp.json` in an app repo.

---
title: What is mybase
summary: Self-hosted backend: one Postgres database + S3 bucket per project, plus optional cron, queues, cache, rate limits, analytics.
section: Start here
order: 1
---

# What is mybase

mybase is a self-hosted alternative to Supabase-style backends. It runs with Docker on anything from a Raspberry Pi to a server, and gives each **project** its own slice of a few shared services:

| Service | What a project gets | Turned on |
| --- | --- | --- |
| Database | A Postgres database + login role (pgvector, PostGIS, hypopg, pg_partman available) | Always |
| Storage | An S3 bucket + access key (Garage). Objects under `public/` are readable by anyone | Always |
| Cron | Signed HTTP calls to your app on a schedule, plus one-off tasks | Per project |
| Queues | SQS-style standard and FIFO queues with dead-letter queues | Per project |
| Cache | A Redis-compatible keyspace (`<project>:*`) over TCP or HTTP | Per project |
| Rate limits | Shared limits (sliding window, fixed window, token bucket) | Per project |
| Analytics | Cookieless page views, custom events, and errors | Per project |
| Vector search | Indexes of documents, searched by vector, keywords, or both (pgvector + full-text) | Per project |
| Users | Sign-in for your app's users with Better Auth: its tables, sessions, and a users page | Per project |
| Captcha | Self-hosted proof-of-work bot checks for forms | Per project |
| Realtime | WebSocket channels: live updates, chat, presence, for apps on serverless hosts | Per project |
| [Agent sandboxes](sandboxes.md) | Temporary gVisor-isolated Node/Chromium workspaces, executions, and private artifacts | Opt-in worker, per project |

Instance-wide: a [security advisor, audit log, and alerts](security.md).

This instance: {{MYBASE_URL}}

## How you use it

- **Dashboard** at {{MYBASE_URL}}: projects, tables, SQL, files, jobs, queues, keys, and [sandbox runs](sandbox-dashboard.md).
- **CLI** (`mybase`): everything the dashboard does, scriptable, with `--json`. See [Quickstart](quickstart.md).
- **SDK** (`@mybase-dev/sdk`): what your app imports for cron, queues, cache, rate limits, and analytics.
- **Plain clients**: any Postgres driver, any S3 client, any Redis client.
- **Agents**: MCP server at `{{MYBASE_URL}}/mcp`, docs at `{{MYBASE_URL}}/llms.txt`. See [Agents](agents.md).

## Agent notes

- Start with `mybase context <project>` (or MCP `get_project_context`) instead of guessing what a project has.
- Credentials (database password, S3 secret key, cache password, API keys) are shown **once** and never stored, unless the user linked them into [Secrets](secrets.md). If lost, rotate or recreate; don't search for them.
- Project names: 3–40 lowercase letters, digits, or `_`, starting with a letter. The bucket name is the project name with `_` → `-`.

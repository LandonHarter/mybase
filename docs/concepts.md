---
title: Projects, keys, and permissions
summary: How projects are isolated, how API keys and their permissions work, and which permission each action needs.
section: Start here
order: 3
---

# Projects, keys, and permissions

## Projects

A project is a Postgres database + same-named login role, and a Garage bucket + access key. Optional services are switched on per project. Projects share one Postgres server, one Garage node, and one Valkey server, but can't see each other's data: the role owns only its database, the S3 key is granted only its bucket, and the cache user only its `<project>:*` keys.

## Admin and API keys

There is one admin account (dashboard sign-in). Everything else uses **API keys** (`mb_…`), sent as `Authorization: Bearer mb_…`.

Each key has permissions and, optionally, a list of projects:

| Permission | Allows |
| --- | --- |
| `admin` | Everything, including keys, the SQL editor, and extensions |
| `projects:read` / `projects:write` | List projects / create, delete, turn services on and off |
| `database:read` / `database:write` | Database details, tables, rows (the SQL editor needs `admin`) |
| `storage:read` / `storage:write` | Files in the project's bucket |
| `cron:read` / `cron:write` | Jobs, runs, one-off tasks |
| `analytics:read` / `analytics:write` | Reports, events, settings |
| `cache:read` / `cache:write` | Keys; HTTP commands need write |
| `ratelimit:read` / `ratelimit:write` | Rules and stats; limit checks need write |
| `queue:read` / `queue:write` | Queues and messages; receiving is a write |
| `search:read` / `search:write` | Web searches and page reads (read is enough) |

`write` includes `read`. A key limited to projects can read lists (filtered to its projects) but can't write outside them, so it can't create projects.

```sh
mybase token create shop-app --project shop --perm queue:write,ratelimit:write
mybase token create ci --admin
mybase token list
mybase token delete <id>
```

A request a key can't make gets **403** with the permission it needs, e.g. `this API key needs queue:write`.

## Secrets

Database passwords, S3 secret keys, cache passwords, and API keys are returned once and stored only as hashes (or not at all). The one exception is the per-project cron secret, which mybase needs to sign every call.

## Agent notes

- Ask the user for a key with the permissions a task needs; don't work around a 403.
- Recommended agent key: `--project <p> --perm database:read,storage:read,<service>:write` for the services it works on. Admin only when it must run SQL.

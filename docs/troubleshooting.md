---
title: Troubleshooting
summary: Common error messages from the CLI, API, and SDK, and what fixes them.
section: Reference
order: 31
---

# Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| `can't reach the API at …` | Wrong URL or mybase is down | `mybase login --url <url>` or set `MYBASE_API_URL`; check `curl <url>/health` |
| `not signed in. Run mybase login` | No saved token, no `MYBASE_TOKEN` | `mybase login`, or export an API key as `MYBASE_TOKEN` |
| `the API rejected your token` / `invalid API key` | Revoked or mistyped key | Make a new key: `mybase token create …` |
| `Too many requests with a wrong key` | Repeated bad keys from one IP | Wait the given seconds; fix the key |
| `this API key needs queue:write` (any `<resource>:<level>`) | Key lacks that permission | `mybase token update <id> --perm …` or use another key |
| `this API key can't access project "x"` | Key is limited to other projects | `mybase token update <id> --project …` |
| `this API key needs the admin permission` | Route is admin-only (SQL, extensions, keys) | Use an admin key, or the app's own DB connection |
| `refusing without --yes (no terminal to confirm)` | Destructive command run non-interactively | Confirm with the user, then add `--yes` |
| `queues are not enabled for this project` (any service) | Service is off | `mybase <service> enable <project>` |
| `project "x" not found` | Typo or wrong instance | `mybase project list` |
| `NOPERM` from the cache | Key without the `<project>:` prefix | Prefix every key, or set `keyPrefix` in the client |
| Cron calls fail signature checks | App has an old or wrong `MYBASE_CRON_SECRET` | `mybase cron secret <project>` and update the app |
| S3 client errors on bucket host | Virtual-host addressing | `forcePathStyle: true` |
| CLI and server versions differ | One side is older | Update the CLI (install script) or the server (`docker compose pull`) |

Every API response has an `X-Request-Id` header; the server log line for the request carries the same `req=` id.

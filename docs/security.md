---
title: Security
summary: The security advisor, the audit log, alerts, and what mybase does to keep the dashboard and your projects apart.
section: Reference
order: 32
---

# Security

Three tools on the dashboard's **Security** page (also in the CLI): the **advisor** finds mistakes, the **audit log** says who did what, and **alerts** tell you when something suspicious happens.

## Security advisor

Read-only checks, run each time you open the page or call it. Nothing is stored or changed.

```sh
mybase doctor             # this instance + every project (admin key); exits 1 on critical findings
mybase doctor shop        # one project (projects:read)
```

`GET /advisor` (admin) and `GET /projects/<p>/advisor` (`projects:read`) return `{ checkedAt, findings, checks }`; each finding has `id`, `severity` (`critical`, `warn`, `info`), `project`, `title`, `detail`, and `fix`. MCP: `security_advisor`.

Instance checks:

| Check | What it means |
| --- | --- |
| `admin-no-2fa` | The admin signs in with a password alone. Turn on 2FA in Settings. |
| `secrets-key-unset` | `MYBASE_SECRETS_KEY` isn't set (critical when a project uses secrets). |
| `secrets-key-old-set` | `MYBASE_SECRETS_KEY_OLD` is still set after the re-wrap. |
| `admin-password-in-env` | `MYBASE_ADMIN_PASSWORD` is still in the environment. |
| `weak-service-secret` | `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, or `GARAGE_ADMIN_TOKEN` is short or a placeholder. Values are never shown. |
| `tunnel-no-trust-proxy` | Requests come through Cloudflare but `MYBASE_TRUST_PROXY` isn't set, so every visitor looks like one IP. |
| `public-url-http` | `MYBASE_PUBLIC_URL` is plain http on a public address. |
| `admin-token-stale`, `token-unused` | API keys unused for 90+ days. |
| `control-schema-public` | Project roles could read mybase's own tables. |
| `db-public-off` | `MYBASE_DB_PUBLIC` is on but the host or DNS token is missing. |
| `db-public-cert` | Public Postgres's certificate couldn't be issued, or expires within 14 days. |
| `db-public-dns` | The database's DNS record couldn't be updated. |

Project checks: other projects can connect to the database (`database-public-connect`), the project role has extra privileges (`role-privileged`), anyone can create objects in `public` (`public-schema-create`), tables granted to `PUBLIC` (`grants-to-public`), row-level security on but not forced (`rls-not-forced`: apps connect as the table owner, which skips RLS unless forced), tables without RLS once the users service is on (`tables-no-rls`), `SECURITY DEFINER` functions without a fixed `search_path`, files under `public/`, analytics open to any origin, and Better Auth's tables missing (`users-not-migrated`).

## Audit log

Every request that changes something is recorded: sign-ins (and failed ones), 2FA changes, API keys, projects, services, secrets changes and **reads** (names only), SQL editor runs (never the SQL), row edits, file uploads and deletes, syncs, rejected API keys, rejected database connections, and your app's sign-ins from the users service. High-volume app calls (cache commands, rate limit checks, queue sends and receives, analytics events) are not.

```sh
mybase audit                                  # newest 50
mybase audit --action auth --since 24h        # a group (auth, mfa, token, project, service, secrets, database, storage, users, …)
mybase audit --project shop --outcome denied
mybase audit --follow                         # keep printing new entries
mybase audit retention 30                     # keep 30 days (7–365, default 90; admin key)
```

`GET /audit?project=&action=&actor=&outcome=&since=&before=&limit=` needs `audit:read`. Entries are newest first; pass `next` as `before` for older ones. A key limited to some projects sees only their entries. MCP: `audit_events`.

Each entry has who (`session` = the admin's browser, `token` = an API key by name, `anonymous`, or `system`), the IP, the action, its outcome (`ok`, `denied`, `failed`), the project, a target (a key id, an env name, a table, a file), and a few counts or flags. Secret values, passwords, SQL text, row values, and request bodies are never recorded.

Entries are buffered and written every 10 seconds (fewer writes on an SD card) and on shutdown. A crash can lose the last few seconds. Old entries are deleted hourly.

## Alerts

Built-in rules watch the audit log and send a message when one fires. Each rule sends at most once per 15 minutes.

| Rule | Fires when |
| --- | --- |
| `login.failed_burst` | 10+ failed admin sign-ins within 10 minutes |
| `login.new_ip` | the admin signs in from an IP not seen in 30 days |
| `mfa.disabled`, `mfa.recovery_used` | 2FA turned off, or a recovery code used |
| `auth.password_changed` | the admin password changed |
| `token.admin_created` | a new admin API key |
| `secrets.new_reader` | an API key reads a secrets env it hadn't read in 30 days |
| `key.rejected_burst`, `dbproxy.rejected_burst` | many wrong API keys or rejected database connections |
| `advisor.critical` | the daily advisor run finds a new critical problem |

Send them to an [ntfy](https://ntfy.sh) topic (push notifications to your phone) or a webhook:

```sh
mybase alerts add ntfy https://ntfy.sh/<long-random-topic> [--token tk_…]
mybase alerts add webhook https://example.com/hooks/mybase
mybase alerts test <channel-id>
mybase alerts rule login.new_ip off
```

Webhooks get a JSON POST, `{ rule, title, detail, at, instance }`, signed like cron calls. Verify it with the channel's secret:

```ts
import { verifyCronSignature } from "@mybase-dev/sdk/cron";

const body = await req.text();
await verifyCronSignature({ body, signature: req.headers.get("X-Mybase-Signature"), secret: process.env.MYBASE_ALERT_SECRET! });
```

Failed sends are retried twice (10 s, 60 s). Sends are audit entries too (`alert.sent`, `alert.failed`). ntfy access tokens are encrypted with `MYBASE_SECRETS_KEY` when it's set.

## What mybase does for you

- **Public files can't act as the dashboard.** `/storage/<p>/public/*` shares the dashboard's origin, so every stored file is served with `X-Content-Type-Options: nosniff` and a `sandbox` CSP, and HTML, SVG, XML, and JavaScript download instead of rendering.
- **Security headers:** the dashboard has a strict Content Security Policy, refuses to be framed, and sends HSTS over https. Signed-in API answers aren't cached.
- **Default deny:** every route needs a signed-in admin or an API key with the right permission, unless it's deliberately public. Cross-site writes are refused (CSRF).
- **Throttling:** sign-ins and wrong API keys back off per IP; 2FA is available for the admin.

## Agent notes

- Run `security_advisor` (MCP) or `mybase doctor <project> --json` after changing grants, RLS, or functions; fix `critical` and `warn` findings first.
- The audit log never holds secret values or SQL; don't expect to find them there.
- Alert channels and audit retention need an admin key; reading the audit log needs `audit:read`.

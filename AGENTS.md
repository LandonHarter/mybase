<!-- mybase:start -->
## mybase (backend)

This app's backend is the mybase project `testing` at https://mybase.hangdong.lol (self-hosted: Postgres + S3 storage + cron, analytics, ratelimit, cache, queue).

- **Before changing backend code, ground yourself:** `mybase context testing` (tables, jobs, queues, env vars; no secrets) or the MCP tool `get_project_context`.
- **Docs:** https://mybase.hangdong.lol/llms.txt is the index. Search with `mybase docs --search "<words>"` (or MCP `search_docs`); read a page with `mybase docs <slug>`. Don't guess SDK APIs.
- **CLI:** `mybase <command> --json` for machine-readable output. Commands that delete data need `--yes`; ask the user before running them.
- **Env vars:** `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MYBASE_API_KEY`, `MYBASE_CRON_SECRET`, `REDIS_URL`. Values live in env files that aren't committed; secrets are shown once at creation and can't be fetched again.
- **SDK** (`npm i @mybase/sdk`):
  - `@mybase/sdk/cron` (verify + handle cron calls, schedule one-off tasks)
  - `@mybase/sdk/analytics` (page views, events, errors)
  - `@mybase/sdk/ratelimit` (check limits)
  - `@mybase/sdk/cache` (HTTP cache client)
  - `@mybase/sdk/queue` (send, receive, consume)
- **Config in code:** cron jobs, rate limit rules, and queues the app depends on go in `mybase.config.ts` (`defineConfig` from `@mybase/sdk/config`) and are applied with `mybase cron|ratelimit|queue sync` (`--dry-run` first).
- `MYBASE_API_KEY` is server-side only. Browser code may use only the analytics write key.
<!-- mybase:end -->

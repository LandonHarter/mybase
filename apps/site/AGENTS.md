<!-- mybase:start -->
## mybase (backend)

This app's backend is the mybase project `usemybase` at https://mybase.hangdong.lol (self-hosted: Postgres + S3 storage + secrets, registry, hosting, analytics).

- **Before changing backend code, ground yourself:** `mybase context usemybase` (tables, jobs, queues, env vars; no secrets) or the MCP tool `get_project_context`.
- **Docs:** https://mybase.hangdong.lol/llms.txt is the index. Search with `mybase docs --search "<words>"` (or MCP `search_docs`); read a page with `mybase docs <slug>`. Don't guess SDK APIs.
- **CLI:** `mybase <command> --json` for machine-readable output. Commands that delete data need `--yes`; ask the user before running them.
- **Env vars:** `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PORT`, `MYBASE_SITE_URL`, `MYBASE_ENV`. Values live in env files that aren't committed; secrets are shown once at creation and can't be fetched again.
- **SDK** (`npm i @mybase-dev/sdk`):
  - `@mybase-dev/sdk/analytics` (page views, events, errors)
- **Config in code:** cron jobs, rate limit rules, queues, and vector indexes the app depends on go in `mybase.config.ts` (`defineConfig` from `@mybase-dev/sdk/config`) and are applied with `mybase cron|ratelimit|queue|vector sync` (`--dry-run` first).
- `MYBASE_API_KEY` is server-side only. Browser code may use only the analytics write key.
<!-- mybase:end -->

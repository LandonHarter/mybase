---
title: Using mybase with AI agents
summary: Connect coding agents (Claude Code, Cursor, VS Code, …) via MCP, llms.txt, the --json CLI, and `mybase agent init`.
section: Start here
order: 4
---

# Using mybase with AI agents

mybase gives agents four ways in. Use as many as the agent supports.

## 1. MCP server

Streamable HTTP at `{{MYBASE_URL}}/mcp`, authenticated with an API key. The tool list is filtered to what the key may do.

```sh
mybase token create agent --project shop --perm database:read,storage:read,queue:write,cron:write
export MYBASE_API_KEY=mb_…
claude mcp add --transport http mybase {{MYBASE_URL}}/mcp --header "Authorization: Bearer $MYBASE_API_KEY"
```

Or in `.mcp.json` (Cursor: `.cursor/mcp.json`); the key stays in the environment:

```json
{
  "mcpServers": {
    "mybase": { "type": "http", "url": "{{MYBASE_URL}}/mcp", "headers": { "Authorization": "Bearer ${MYBASE_API_KEY}" } }
  }
}
```

Tools: `search_docs`, `read_doc`, `whoami`, `list_projects`, `get_project_context`, `create_project`, `enable_service`, `describe_schema`, `query_rows`, `run_sql` (admin), `list_files`, `list_cron_jobs`, `create_cron_job`, `run_cron_job`, `list_cron_runs`, `list_queues`, `create_queue`, `send_message`, `peek_messages`, `cache_command`, `list_ratelimit_rules`, `create_ratelimit_rule`, `analytics_stats`, `list_secret_envs`, `list_secret_keys`, `set_secrets`, `create_secret_env` (names only; no tool returns a secret value). Docs pages are MCP resources (`mybase://docs/<slug>`), and prompts `setup_project`, `add_queue_worker`, `add_cron_job`, `add_analytics`, `use_secrets` walk through common tasks.

Deleting projects, turning services off, purging or deleting queues, and managing keys are **not** exposed over MCP. Those stay with the dashboard and CLI.

## 2. Docs for agents

- `{{MYBASE_URL}}/llms.txt`: index with a short "how to act" primer ([llmstxt.org](https://llmstxt.org) format)
- `{{MYBASE_URL}}/llms-full.txt`: every page in one file
- `{{MYBASE_URL}}/docs/<slug>.md`: one page as markdown, with this instance's URL filled in
- `{{MYBASE_URL}}/docs/search?q=<words>`: best matching sections as JSON
- `mybase docs`, `mybase docs <slug>`, `mybase docs --search "<words>"`

## 3. CLI for scripts and agents

- `--json` on any command prints the API's answer as JSON; errors are JSON on stderr: `{"error", "status", "exitCode"}`.
- Exit codes: 0 ok, 1 failure, 2 usage (including a missing `--yes`), 3 not signed in / bad key, 4 not found.
- Without a terminal, destructive commands refuse to run unless `--yes` is given; they never hang on a prompt.
- `MYBASE_API_URL` + `MYBASE_TOKEN` configure it without `mybase login`.
- `mybase context <project>` prints the project as markdown (or JSON): services, tables and columns, jobs, queues, rules, env var names, docs to read.

## 4. `mybase agent init`

Run in an app repo:

```sh
mybase agent init --project shop          # add --key to also make a project-limited key in .env.local
```

It writes (and on re-runs, replaces) a marked mybase section in `AGENTS.md` (and `CLAUDE.md` if the repo has one), a Claude Code skill at `.claude/skills/mybase/SKILL.md`, and a `mybase` entry in `.mcp.json`. `--key` writes the key to `.env.local` only if git ignores that file.

## Agent notes

- Give agents the narrowest key that works. `run_sql` and the SQL route need `admin`.
- Secrets in tool results (from `create_project`, `enable_service` for the cache) are shown once: save them to the user's env right away.

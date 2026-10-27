// `mybase agent init`: sets up an app repo so coding agents know how to use mybase. Writes a
// marked section into AGENTS.md (and CLAUDE.md when present), a Claude Code skill, and an
// .mcp.json entry. Running it again replaces what it wrote, nothing else.
import type { CreateApiTokenResponse, KeyPermission, Project, ProjectContext } from "@mybase/shared";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { api } from "./api";
import { getContext } from "./context";
import { flagString, parseArgs } from "./cron";
import { mcpServerEntry } from "./mcp";
import { print, usageError } from "./output";

export const agentUsage = `  agent init [--project <name>] [--dir .] [--key] [--no-agents-md] [--no-skill] [--no-mcp]
                                 Teach coding agents about mybase in an app repo: AGENTS.md notes,
                                 a Claude skill, and .mcp.json. --key also makes a project-limited
                                 API key and puts it in .env.local (only if git ignores it)`;

const START = "<!-- mybase:start -->";
const END = "<!-- mybase:end -->";

/** `body` between the markers in `existing`, replacing an earlier copy, or appended. */
export function upsertSection(existing: string, body: string): string {
  const block = `${START}\n${body.trim()}\n${END}`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) return existing.slice(0, start) + block + existing.slice(end + END.length);
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

const SDK_ENTRY: Record<string, string> = {
  cron: "`@mybase-dev/sdk/cron` (verify + handle cron calls, schedule one-off tasks)",
  analytics: "`@mybase-dev/sdk/analytics` (page views, events, errors)",
  cache: "`@mybase-dev/sdk/cache` (HTTP cache client)",
  ratelimit: "`@mybase-dev/sdk/ratelimit` (check limits)",
  queue: "`@mybase-dev/sdk/queue` (send, receive, consume)",
  search: "`@mybase-dev/sdk/search` (web search + page reads, `searchTools` for LLM agents)",
};

function agentsSection(c: ProjectContext): string {
  const sdk = c.services.filter((s) => SDK_ENTRY[s]).map((s) => `  - ${SDK_ENTRY[s]}`);
  return `## mybase (backend)

This app's backend is the mybase project \`${c.project}\` at ${c.apiUrl} (self-hosted: Postgres + S3 storage${c.services.length ? ` + ${c.services.join(", ")}` : ""}).

- **Before changing backend code, ground yourself:** \`mybase context ${c.project}\` (tables, jobs, queues, env vars; no secrets) or the MCP tool \`get_project_context\`.
- **Docs:** ${c.docsUrl} is the index. Search with \`mybase docs --search "<words>"\` (or MCP \`search_docs\`); read a page with \`mybase docs <slug>\`. Don't guess SDK APIs.
- **CLI:** \`mybase <command> --json\` for machine-readable output. Commands that delete data need \`--yes\`; ask the user before running them.
- **Env vars:** ${c.env.map((e) => `\`${e.name}\``).join(", ")}. Values live in env files that aren't committed; secrets are shown once at creation and can't be fetched again.
${sdk.length ? `- **SDK** (\`npm i @mybase-dev/sdk\`):\n${sdk.join("\n")}\n` : ""}- **Config in code:** cron jobs, rate limit rules, and queues the app depends on go in \`mybase.config.ts\` (\`defineConfig\` from \`@mybase-dev/sdk/config\`) and are applied with \`mybase cron|ratelimit|queue sync\` (\`--dry-run\` first).
- \`MYBASE_API_KEY\` is server-side only. Browser code may use only the analytics write key.`;
}

function skill(c: ProjectContext): string {
  return `---
name: mybase
description: Use for anything touching this app's backend on mybase (self-hosted Postgres, S3 storage, cron, queues, cache, rate limits, analytics), project "${c.project}". Covers the mybase CLI, MCP tools, @mybase-dev/sdk, and mybase.config.ts.
---

# mybase

Project \`${c.project}\` on ${c.apiUrl}. Services: database, storage${c.services.length ? `, ${c.services.join(", ")}` : ""}.

## Workflow

1. Ground yourself: \`mybase context ${c.project} --json\` or MCP \`get_project_context\` (project "${c.project}").
2. Look up the exact API before writing code: \`mybase docs --search "<words>"\`, then \`mybase docs <slug>\`. Index: ${c.docsUrl}
3. Declare cron jobs, queues, and rate limit rules in \`mybase.config.ts\`; preview with \`mybase <service> sync --dry-run\`, then sync.
4. Verify against the live project: \`mybase queue peek\`, \`mybase cron runs\`, MCP \`list_cron_runs\`, \`peek_messages\`, \`analytics_stats\`.

## Rules

- Never print, log, or commit secrets (database password, S3 secret key, cache password, \`mb_…\` API keys). They are shown once; if lost, the user rotates them.
- Destructive commands (\`project delete\`, \`<service> disable\`, \`queue purge|delete\`) need \`--yes\` and the user's explicit OK.
- Use \`--json\` when parsing CLI output. Exit codes: 1 failure, 2 usage, 3 not signed in, 4 not found.
- An API key that can't do something gets 403 with the permission it needs (e.g. \`queue:write\`): ask the user for a key with it, don't work around it.

## Read next

${c.docs.map((d) => `- [${d.title}](${d.url})`).join("\n")}
`;
}

async function readText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

async function writeText(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

/** Picks the project: --project, mybase.config.ts, or the only one the key can see. */
async function chooseProject(flag: string | undefined, dir: string): Promise<string> {
  if (flag) return flag;
  const config = await readText(join(dir, "mybase.config.ts"));
  const fromConfig = config && /project:\s*["'`]([a-z][a-z0-9_]*)["'`]/.exec(config)?.[1];
  if (fromConfig) return fromConfig;
  const projects = await api<Project[]>("/projects");
  if (projects.length === 1) return projects[0]!.name;
  throw usageError(`which project? Pass --project <name> (${projects.map((p) => p.name).join(", ") || "none yet: mybase project create <name>"})`);
}

/** Whether git ignores `path` (so a secret can go there). False outside a git repo. */
async function gitIgnores(dir: string, path: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "check-ignore", "-q", path], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** A key limited to the project: read on database and storage, write on its optional services. */
async function createAgentKey(c: ProjectContext): Promise<CreateApiTokenResponse> {
  const permissions = ["database:read", "storage:read", ...c.services.map((s) => `${s}:write`)] as KeyPermission[];
  return api<CreateApiTokenResponse>("/auth/tokens", {
    method: "POST",
    body: JSON.stringify({ name: `${c.project} agent`, permissions, projects: [c.project] }),
  });
}

export async function agent(sub: string, args: string[]): Promise<boolean> {
  if (sub !== "init") return false;
  const { flags } = parseArgs(args);
  const dir = resolve(flagString(flags, "dir") ?? ".");
  const c = await getContext(await chooseProject(flagString(flags, "project"), dir));
  const written: string[] = [];
  const notes: string[] = [];

  if (!flags.has("no-agents-md")) {
    const section = agentsSection(c);
    const agentsPath = join(dir, "AGENTS.md");
    await writeText(agentsPath, upsertSection((await readText(agentsPath)) ?? "", section));
    written.push("AGENTS.md");
    // Claude Code reads CLAUDE.md, not AGENTS.md: keep a copy there when the repo has one.
    const claudePath = join(dir, "CLAUDE.md");
    const claude = await readText(claudePath);
    if (claude !== null && !claude.includes("@AGENTS.md")) {
      await writeText(claudePath, upsertSection(claude, section));
      written.push("CLAUDE.md");
    }
  }

  if (!flags.has("no-skill")) {
    await writeText(join(dir, ".claude/skills/mybase/SKILL.md"), skill(c));
    written.push(".claude/skills/mybase/SKILL.md");
  }

  if (!flags.has("no-mcp")) {
    const mcpPath = join(dir, ".mcp.json");
    const existing = await readText(mcpPath);
    let config: { mcpServers?: Record<string, unknown> };
    try {
      config = existing ? JSON.parse(existing) : {};
    } catch {
      throw new Error(`${mcpPath} isn't valid JSON; fix it or pass --no-mcp`);
    }
    config.mcpServers = { ...config.mcpServers, mybase: mcpServerEntry("MYBASE_API_KEY", c.apiUrl) };
    await writeText(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
    written.push(".mcp.json");
  }

  let key: CreateApiTokenResponse | null = null;
  if (flags.has("key")) {
    key = await createAgentKey(c);
    if (await gitIgnores(dir, ".env.local")) {
      const envPath = join(dir, ".env.local");
      const env = (await readText(envPath)) ?? "";
      const line = `MYBASE_API_KEY=${key.token}`;
      const next = /^MYBASE_API_KEY=.*$/m.test(env) ? env.replace(/^MYBASE_API_KEY=.*$/m, line) : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
      await writeText(envPath, next);
      written.push(".env.local (MYBASE_API_KEY)");
    } else {
      notes.push(`.env.local isn't ignored by git, so the key wasn't written. Set it yourself:\n  MYBASE_API_KEY=${key.token}`);
    }
  } else if (!flags.has("no-mcp")) {
    notes.push(`The MCP entry reads MYBASE_API_KEY from the environment. Make one with: mybase agent init --key (or mybase token create)`);
  }

  print({ project: c.project, url: c.apiUrl, written, key: key ? { id: key.id, name: key.name, permissions: key.permissions, projects: key.projects } : null, notes }, () => {
    console.log(`Set up agents for project "${c.project}" (${c.apiUrl}):`);
    for (const w of written) console.log(`  wrote ${w}`);
    if (key) console.log(`  key "${key.name}": ${key.permissions.join(",")} on ${c.project}`);
    for (const n of notes) console.log(`\n${n}`);
  });
  return true;
}

// `mybase context <project>`: one project at a glance, as markdown an agent (or you) can read.
import type { ProjectContext } from "@mybase/shared";
import { api } from "./api";
import { need, parseArgs } from "./cron";
import { print } from "./output";

export const contextUsage = `  context <project>              Services, connection details, tables, jobs, queues, env vars (no secrets)`;

export const getContext = (project: string) => api<ProjectContext>(`/projects/${encodeURIComponent(project)}/context`);

const duration = (ms: number) => {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
};

/** The context as markdown. */
export function contextMarkdown(c: ProjectContext): string {
  const out = [`# mybase project "${c.project}"`, "", `API: ${c.apiUrl} · docs: ${c.docsUrl}`, `Services: database, storage${c.services.length ? `, ${c.services.join(", ")}` : ""}`, ""];
  if (c.database) {
    const d = c.database;
    out.push("## Database", "", `Postgres ${d.host}:${d.port}, database \`${d.name}\`, role \`${d.user}\`. WebSocket (serverless): ${d.wsUrl}`, "");
    if (d.tables.length === 0) out.push("No tables yet.", "");
    for (const t of d.tables) {
      const cols = t.columns.map((col) => `${col.name} ${col.type}${col.primaryKey ? " pk" : ""}${col.nullable ? "" : " not null"}`).join(", ");
      out.push(`- \`${t.schema}.${t.name}\`${t.kind === "table" ? "" : ` (${t.kind})`}: ${cols}`);
    }
    if (d.tables.length) out.push("");
  }
  if (c.storage) out.push("## Storage", "", `S3 ${c.storage.endpoint} (region ${c.storage.region}), bucket \`${c.storage.bucket}\`. Public objects (under public/): ${c.storage.publicUrl}<key>`, "");
  if (c.cron) {
    out.push("## Cron jobs", "");
    if (c.cron.jobs.length === 0) out.push("None yet.");
    for (const j of c.cron.jobs) out.push(`- \`${j.name}\` ${j.schedule} (${j.timezone}) → ${j.url} [${j.source}${j.enabled ? "" : ", paused"}${j.lastRun ? `, last ${j.lastRun.status}` : ""}]`);
    out.push("");
  }
  if (c.queue) {
    out.push("## Queues", "");
    if (c.queue.queues.length === 0) out.push("None yet.");
    for (const q of c.queue.queues) {
      const dlq = q.deadLetter ? `, dead letters → ${q.deadLetter.queue} after ${q.deadLetter.maxReceives}` : "";
      out.push(`- \`${q.name}\` ${q.fifo ? "FIFO" : "standard"}: ${q.counts.visible} visible, ${q.counts.inFlight} in flight${dlq} [${q.source}]`);
    }
    out.push("");
  }
  if (c.ratelimit) {
    out.push("## Rate limit rules", "");
    if (c.ratelimit.rules.length === 0) out.push("None yet (inline limits still work).");
    for (const r of c.ratelimit.rules) out.push(`- \`${r.name}\`: ${r.limit} per ${duration(r.windowMs)} (${r.algorithm}) [${r.source}]`);
    out.push("");
  }
  if (c.cache) out.push("## Cache", "", `TCP ${c.cache.url} (password shown once at enable), HTTP ${c.cache.httpUrl}. Every key starts with \`${c.cache.keyPrefix}\`.`, "");
  if (c.search) out.push("## Web search", "", `GET ${c.search.searchUrl}?q=… and ${c.search.fetchUrl}?url=… with a \`search:read\` key.`, "");
  if (c.analytics) out.push("## Analytics", "", `Public write key \`${c.analytics.writeKey}\`, script ${c.analytics.scriptUrl}`, "");
  out.push("## Env vars", "", ...c.env.map((e) => `- \`${e.name}\`: ${e.description}`), "");
  out.push("## Read next", "", ...c.docs.map((d) => `- [${d.title}](${d.url})`));
  return out.join("\n");
}

export async function context(args: string[]): Promise<boolean> {
  const { positional } = parseArgs(args);
  const c = await getContext(need(positional[0], "project name"));
  print(c, () => console.log(contextMarkdown(c)));
  return true;
}

// `mybase memory …`: long-term memory for agents (mem0-style), on top of the AI gateway.
import type { AddMemoryResponse, ListMemoriesResponse, MemoryHistoryEntry, MemoryScopeCount, MemorySettings, SearchMemoryResponse } from "@mybase-dev/sdk/memory";
import { api } from "./api";
import { flagInt, flagString, need, parseArgs } from "./cron";
import { confirm, print, usageError } from "./output";
import { enableService, printLinked } from "./service-enable";

export const memoryUsage = `  memory enable <project>        Turn on memory (turns on the AI gateway first)
  memory disable <project> [--yes]  Turn it off, deleting every memory
  memory settings <project> [--llm <model>] [--embed <model>] [--dims <n>] [--ttl <days>|off] [--prompt <text>|off]
  memory add <project> <text> (--user <id> | --agent <id> | --run <id>) [--raw]  Extract and store facts (--raw: as is)
  memory search <project> <query> [--user <id>] [--agent <id>] [--top 10] [--mode hybrid|vector|text]
  memory list <project> [--user <id>] [--agent <id>] [--limit 50]
  memory scopes <project>        Users and agents with memories
  memory history <project> <id>  ADD/UPDATE/DELETE events of one memory
  memory delete <project> <id>
  memory delete-all <project> (--user <id> | --agent <id> | --run <id>) [--yes]`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/memory`;

function scope(flags: Map<string, string | true>) {
  return { userId: flagString(flags, "user"), agentId: flagString(flags, "agent"), runId: flagString(flags, "run") };
}

export async function memory(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, a] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "memory", flags);
      const s = await api<MemorySettings>(base(p));
      print({ enabled: "memory", project: p, linked, ...s }, () => {
        console.log(`Memory enabled for "${p}": facts by ${s.llmModel}, embeddings by ${s.embedModel} (${s.dimensions}d)\n`);
        console.log("In your app (@mybase-dev/sdk), with an API key that has memory:write:");
        console.log(`  const memory = createMemoryClient({ apiUrl: "${s.apiUrl}", project: "${p}", apiKey: process.env.MYBASE_API_KEY! })`);
        console.log(`  await memory.add({ messages, userId })`);
        console.log(`\nSet the provider key for those models: mybase ai key set ${p} ${s.llmModel.split("/")[0]}`);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This deletes every memory of "${p}".`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/memory`, { method: "DELETE" });
      print({ disabled: "memory", project: p }, () => console.log(`Memory disabled for "${p}"`));
      return true;
    }
    case "settings": {
      const p = need(project, "project name");
      const body: Record<string, unknown> = {};
      const llm = flagString(flags, "llm");
      if (llm) body.llmModel = llm;
      const embed = flagString(flags, "embed");
      if (embed) body.embedModel = embed;
      const dims = flagInt(flags, "dims");
      if (dims !== undefined) body.dimensions = dims;
      const ttl = flagString(flags, "ttl");
      if (ttl !== undefined) body.defaultTtlDays = ttl === "off" ? null : Number(ttl);
      const prompt = flagString(flags, "prompt");
      if (prompt !== undefined) body.customPrompt = prompt === "off" ? null : prompt;
      const s = Object.keys(body).length ? await api<MemorySettings>(base(p), { method: "PUT", body: JSON.stringify(body) }) : await api<MemorySettings>(base(p));
      print(s, () => {
        console.log(`llm         ${s.llmModel}`);
        console.log(`embeddings  ${s.embedModel} (${s.dimensions}d)`);
        console.log(`ttl         ${s.defaultTtlDays ? `${s.defaultTtlDays} days` : "keep"}`);
        console.log(`prompt      ${s.customPrompt ?? "default"}`);
        console.log(`memories    ${s.memories}`);
      });
      return true;
    }
    case "add": {
      const p = need(project, "project name");
      const s = scope(flags);
      if (!s.userId && !s.agentId && !s.runId) throw usageError("give --user, --agent, or --run: memories belong to someone");
      const res = await api<AddMemoryResponse>(`${base(p)}/memories`, { method: "POST", body: JSON.stringify({ ...s, text: need(a, "text"), infer: !flags.has("raw") }) });
      print(res, () => {
        if (res.results.length === 0) console.log("Nothing new to remember.");
        for (const r of res.results) console.log(`${r.event.padEnd(6)} ${r.memory}${r.previous ? `  (was: ${r.previous})` : ""}`);
      });
      return true;
    }
    case "search": {
      const p = need(project, "project name");
      const res = await api<SearchMemoryResponse>(`${base(p)}/search`, {
        method: "POST",
        body: JSON.stringify({ ...scope(flags), query: need(a, "query"), topK: flagInt(flags, "top"), mode: flagString(flags, "mode") }),
      });
      print(res, () => {
        if (res.results.length === 0) console.log("No memories match.");
        for (const m of res.results)
          console.log(`${m.score.toFixed(4)}  ${m.memory}  [${[m.userId && `user ${m.userId}`, m.agentId && `agent ${m.agentId}`].filter(Boolean).join(", ")}]`);
      });
      return true;
    }
    case "list": {
      const p = need(project, "project name");
      const params = new URLSearchParams({ limit: String(flagInt(flags, "limit") ?? 50) });
      for (const [k, v] of Object.entries(scope(flags))) if (v) params.set(k, v);
      const res = await api<ListMemoriesResponse>(`${base(p)}/memories?${params}`);
      print(res, () => {
        if (res.memories.length === 0) console.log("No memories.");
        for (const m of res.memories) console.log(`${m.id}  ${m.updatedAt.slice(0, 10)}  ${m.memory}`);
      });
      return true;
    }
    case "scopes": {
      const p = need(project, "project name");
      const res = await api<MemoryScopeCount[]>(`${base(p)}/scopes`);
      print(res, () => {
        for (const s of res) console.log(`${(s.userId ?? "-").padEnd(30)} ${(s.agentId ?? "-").padEnd(20)} ${String(s.memories).padStart(6)}  ${s.lastAt.slice(0, 10)}`);
      });
      return true;
    }
    case "history": {
      const p = need(project, "project name");
      const res = await api<MemoryHistoryEntry[]>(`${base(p)}/memories/${encodeURIComponent(need(a, "memory id"))}/history`);
      print(res, () => {
        for (const h of res) console.log(`${h.at.slice(0, 19).replace("T", " ")}  ${h.event.padEnd(6)} ${h.old ? `${h.old} → ` : ""}${h.new ?? ""}`);
      });
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const id = need(a, "memory id");
      await api(`${base(p)}/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
      print({ deleted: id }, () => console.log(`Deleted memory ${id}`));
      return true;
    }
    case "delete-all": {
      const p = need(project, "project name");
      const s = scope(flags);
      if (!s.userId && !s.agentId && !s.runId) throw usageError("give --user, --agent, or --run");
      confirm(
        flags.has("yes"),
        `This deletes every memory of ${Object.entries(s)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}.`,
        "yes",
      );
      const res = await api<{ deleted: number }>(`${base(p)}/memories/delete`, { method: "POST", body: JSON.stringify(s) });
      print(res, () => console.log(`Deleted ${res.deleted} memories`));
      return true;
    }
  }
  return false;
}

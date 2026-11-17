// `mybase vector …`: vector + full-text indexes apps use with @mybase-dev/sdk/vector.
import type { IngestResponse, VectorSource } from "@mybase-dev/sdk/vector";
import type {
  ListDocumentsResponse,
  SyncVectorIndexesRequest,
  SyncVectorIndexesResponse,
  UpdateVectorSettingsRequest,
  UpsertDocumentsResponse,
  VectorIndex,
  VectorQueryResponse,
  VectorServiceSettings,
} from "@mybase/shared";
import { api } from "./api";
import { readSecret } from "./auth";
import { flagInt, flagString, need, parseArgs, printSync, readConfigFile } from "./cron";
import { confirm, print, usageError } from "./output";
import { enableService, printLinked } from "./service-enable";

export const vectorUsage = `  vector enable <project>        Turn on vector + full-text search
  vector disable <project> [--yes]  Turn it off, deleting every index and document
  vector settings <project>      Show the embedding provider
  vector embedding <project> --url <url> --model <m> --dims <n> [--key]  Set it (--key prompts for an API key)
  vector embedding <project> --ai <model> [--dims <n>]  Embed through the project's AI gateway (logged and priced there)
  vector embedding <project> --off  Remove it
  vector list <project>          List indexes with document counts
  vector create <project> <index> [--dims <n>] [--metric cosine|l2|ip] [--lang english] [--embed]
  vector delete <project> <index> [--yes]  Delete an index and its documents
  vector upsert <project> <index> <file.jsonl>  Upsert documents, one JSON object per line
  vector documents <project> <index> [--limit 20] [--after <id>]  List documents in id order
  vector query <project> <index> [<text>] [--mode text|vector|hybrid] [--top 10] [--filter <json>]
  vector sources <project> <index>  Sources that fill an index (storage prefix, table, push) and their sync status
  vector source add <project> <index> <id> --storage <prefix> [--include '*.md,*.pdf'] | --table <schema.table> --id-col <c> --text <c1,c2> [--title <c>] [--meta <c,…>] [--updated <c>] | --push  [--chunk 1000] [--overlap 150] [--every 15]
  vector source remove <project> <index> <id> [--yes]  Remove it and every chunk it made
  vector source sync <project> <index> <id> [--full]  Sync now (--full also finds deleted rows)
  vector ingest <project> <index> <file|-> [--id <id>] [--title <t>]  Chunk + embed a text/markdown file as one document
  vector sync [--config <file>] [--dry-run] [--yes]  Make code-defined indexes (and their sources) match mybase.config.ts`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/vector`;
const indexPath = (project: string, name: string, rest = "") => `${base(project)}/indexes/${encodeURIComponent(name)}${rest}`;

function describe(i: VectorIndex): string {
  const vectors = i.dimensions ? `${i.dimensions}d ${i.metric}` : "text only";
  return [i.name, vectors, i.language, i.embed ? "embeds" : "", `${i.documents} docs`, i.source].filter(Boolean).join("\t");
}

function printUsage(project: string, settings: VectorServiceSettings) {
  console.log("In your app (@mybase-dev/sdk), with an API key that has vector:write for this project:");
  console.log(`  mybase token create ${project}-app --project ${project} --perm vector:write\n`);
  console.log(`  const vector = createVectorClient({ apiUrl: "${settings.apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! })`);
  console.log(`  const { matches } = await vector.index("<index>").query("search text")`);
}

/** Handles `mybase vector <sub> …`. False when `sub` isn't a vector command. */
export async function vector(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, name, third] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "vector", flags);
      const settings = await api<VectorServiceSettings>(base(p));
      print({ enabled: "vector", project: p, linked, ...settings }, () => {
        console.log(`Vector search enabled for "${p}"\n`);
        printUsage(p, settings);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This deletes every vector index and document of "${p}".`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/vector`, { method: "DELETE" });
      print({ disabled: "vector", project: p }, () => console.log(`Vector search disabled for "${p}"`));
      return true;
    }
    case "settings": {
      const p = need(project, "project name");
      const settings = await api<VectorServiceSettings>(base(p));
      print(settings, () => {
        const e = settings.embedding;
        console.log(
          e
            ? e.via === "ai"
              ? `embedding  ${e.model} (${e.dimensions}d) through the AI gateway`
              : `embedding  ${e.model} (${e.dimensions}d) at ${e.url}${e.hasKey ? ", API key stored" : ""}`
            : "embedding  none (apps send their own vectors)",
        );
      });
      return true;
    }
    case "embedding": {
      const p = need(project, "project name");
      let body: UpdateVectorSettingsRequest;
      if (flags.has("off")) body = { embedding: null };
      else if (flags.has("ai")) body = { embedding: { via: "ai", model: need(flagString(flags, "ai"), "--ai <model>"), dimensions: flagInt(flags, "dims") } };
      else {
        const dims = flagInt(flags, "dims");
        if (dims === undefined) throw new Error("--dims is required (the model's vector length, e.g. 1536)");
        // Prompted, so the key stays out of shell history.
        const apiKey = flags.has("key") ? await readSecret("API key: ") : undefined;
        body = { embedding: { url: need(flagString(flags, "url"), "--url"), model: need(flagString(flags, "model"), "--model"), dimensions: dims, apiKey } };
      }
      const settings = await api<VectorServiceSettings>(base(p), { method: "PUT", body: JSON.stringify(body) });
      print(settings, () => console.log(settings.embedding ? `Embedding with ${settings.embedding.model} (${settings.embedding.dimensions}d)` : "Embedding provider removed"));
      return true;
    }
    case "list": {
      const p = need(project, "project name");
      const indexes = await api<VectorIndex[]>(`${base(p)}/indexes`);
      print(indexes, () => {
        if (indexes.length === 0) console.log("No indexes yet.");
        for (const i of indexes) console.log(describe(i));
      });
      return true;
    }
    case "create": {
      const p = need(project, "project name");
      const body = {
        name: need(name, "index name"),
        dimensions: flagInt(flags, "dims"),
        metric: flagString(flags, "metric"),
        language: flagString(flags, "lang"),
        embed: flags.has("embed") || undefined,
      };
      const index = await api<VectorIndex>(`${base(p)}/indexes`, { method: "POST", body: JSON.stringify(body) });
      print(index, () => console.log(`Created index "${index.name}" (${index.dimensions ? `${index.dimensions}d ${index.metric}` : "text only"}, ${index.language})`));
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      confirm(flags.has("yes"), `This deletes index "${n}" and every document in it.`, n, "the index name");
      await api(indexPath(p, n), { method: "DELETE" });
      print({ deleted: n }, () => console.log(`Deleted index "${n}"`));
      return true;
    }
    case "upsert": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      const file = need(third, "JSONL file");
      const lines = (await Bun.file(file).text()).split(/\r?\n/).filter((l) => l.trim());
      const documents = lines.map((line, i) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new Error(`${file}:${i + 1} is not JSON`);
        }
      });
      let upserted = 0;
      let embedded = 0;
      for (let i = 0; i < documents.length; i += 100) {
        const res = await api<UpsertDocumentsResponse>(indexPath(p, n, "/documents"), { method: "POST", body: JSON.stringify({ documents: documents.slice(i, i + 100) }) });
        upserted += res.upserted;
        embedded += res.embedded;
      }
      print({ upserted, embedded }, () => console.log(`Upserted ${upserted} documents into "${n}"${embedded ? ` (${embedded} embedded)` : ""}`));
      return true;
    }
    case "query": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      const rawFilter = flagString(flags, "filter");
      let filter: unknown;
      try {
        filter = rawFilter === undefined ? undefined : JSON.parse(rawFilter);
      } catch {
        throw new Error("--filter must be JSON, e.g. '{\"lang\":\"en\"}'");
      }
      const body = { text: third, mode: flagString(flags, "mode"), topK: flagInt(flags, "top"), filter, highlight: true };
      const res = await api<VectorQueryResponse>(indexPath(p, n, "/query"), { method: "POST", body: JSON.stringify(body) });
      print(res, () => {
        if (res.matches.length === 0) console.log(`No matches (${res.mode}).`);
        for (const m of res.matches) {
          console.log(`${m.score.toFixed(4)}  ${m.id}${m.title ? `  ${m.title}` : ""}`);
          const snippet = m.highlight ?? m.text?.slice(0, 160);
          if (snippet) console.log(`        ${snippet.replace(/\s+/g, " ")}`);
        }
      });
      return true;
    }
    case "documents": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      const params = new URLSearchParams({ limit: String(flagInt(flags, "limit") ?? 20) });
      const after = flagString(flags, "after");
      if (after) params.set("after", after);
      const res = await api<ListDocumentsResponse>(indexPath(p, n, `/documents?${params}`));
      print(res, () => {
        for (const d of res.documents) console.log(`${d.id}\t${d.title ?? d.text.slice(0, 80).replace(/\s+/g, " ")}`);
        if (res.next) console.log(`more: --after ${res.next}`);
      });
      return true;
    }
    case "sync":
      await sync(flagString(flags, "config") ?? "mybase.config.ts", flags.has("dry-run"), flags.has("yes"));
      return true;
    case "sources": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      const list = await api<VectorSource[]>(indexPath(p, n, "/sources"));
      print(list, () => {
        if (list.length === 0) console.log(`No sources. Add one: mybase vector source add ${p} ${n} docs --storage docs/`);
        for (const s of list) {
          const where = s.kind === "storage" ? `storage ${String(s.config.prefix) || "/"}` : s.kind === "table" ? `table ${s.config.schema}.${s.config.table}` : "push";
          console.log(`${s.id.padEnd(20)} ${where.padEnd(30)} ${s.status.padEnd(8)} ${s.items} items, ${s.chunks} chunks  ${s.lastSyncAt ? `synced ${s.lastSyncAt.slice(0, 19).replace("T", " ")}` : "never synced"}${s.lastError ? `  error: ${s.lastError}` : ""}`);
        }
      });
      return true;
    }
    case "source": {
      // mybase vector source add|remove|sync <project> <index> <id>
      const [action, p0, n0, id0] = positional;
      const p = need(p0, "project name");
      const n = need(n0, "index name");
      const id = need(id0, "source id");
      const path = indexPath(p, n, `/sources/${encodeURIComponent(id)}`);
      if (action === "add") {
        const list = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean);
        let body: Record<string, unknown>;
        if (flags.has("storage")) body = { kind: "storage", config: { prefix: flagString(flags, "storage") ?? "", include: list(flagString(flags, "include")) } };
        else if (flags.has("table")) {
          const [schema, table] = need(flagString(flags, "table"), "--table").includes(".") ? flagString(flags, "table")!.split(".") : ["public", flagString(flags, "table")!];
          body = {
            kind: "table",
            config: { schema, table, id: flagString(flags, "id-col") ?? "id", text: list(need(flagString(flags, "text"), "--text <columns>")), title: flagString(flags, "title"), metadata: list(flagString(flags, "meta")), updatedAt: flagString(flags, "updated") },
          };
        } else if (flags.has("push")) body = { kind: "push" };
        else throw usageError("give --storage <prefix>, --table <schema.table>, or --push");
        Object.assign(body, { chunkSize: flagInt(flags, "chunk"), chunkOverlap: flagInt(flags, "overlap"), intervalMin: flagInt(flags, "every") });
        const s = await api<VectorSource>(path, { method: "PUT", body: JSON.stringify(body) });
        print(s, () => console.log(`Source "${s.id}" saved${s.kind === "push" ? "" : "; first sync queued (mybase vector sources to watch it)"}`));
      } else if (action === "remove") {
        confirm(flags.has("yes"), `This removes source "${id}" and every chunk it added to "${n}".`, id, "the source id");
        await api(path, { method: "DELETE" });
        print({ removed: id }, () => console.log(`Removed source "${id}"`));
      } else if (action === "sync") {
        const s = await api<VectorSource>(`${path}/sync`, { method: "POST", body: JSON.stringify({ full: flags.has("full") }) });
        print(s, () => console.log(`Sync of "${id}" queued`));
      } else throw usageError("use: mybase vector source add|remove|sync <project> <index> <id>");
      return true;
    }
    case "ingest": {
      const p = need(project, "project name");
      const n = need(name, "index name");
      const file = need(third, "file (or - for stdin)");
      const text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
      const id = flagString(flags, "id") ?? (file === "-" ? "stdin" : file.replace(/^\.\//, ""));
      const res = await api<IngestResponse>(indexPath(p, n, "/ingest"), { method: "POST", body: JSON.stringify({ id, title: flagString(flags, "title") ?? null, text }) });
      print(res, () => console.log(`Ingested "${id}": ${res.chunks} chunks${res.removed ? `, ${res.removed} old ones removed` : ""}`));
      return true;
    }
  }
  return false;
}

async function sync(file: string, dryRun: boolean, yes: boolean) {
  const config = await readConfigFile(file);
  const indexes = Object.entries(config.vector?.indexes ?? {}).map(([name, i]) => ({ ...i, name })) as SyncVectorIndexesRequest["indexes"];
  const path = `${base(config.project)}/indexes`;
  // Deleting an index deletes its documents: show what would go and confirm first.
  const plan = await api<SyncVectorIndexesResponse>(path, { method: "PUT", body: JSON.stringify({ indexes, dryRun: true } satisfies SyncVectorIndexesRequest) });
  if (dryRun) return printSync(config.project, true, plan);
  if (plan.deleted.length > 0) {
    confirm(yes, `This deletes ${plan.deleted.map((n) => `"${n}"`).join(", ")} and every document in ${plan.deleted.length === 1 ? "it" : "them"}.`, "yes");
  }
  printSync(config.project, false, await api<SyncVectorIndexesResponse>(path, { method: "PUT", body: JSON.stringify({ indexes } satisfies SyncVectorIndexesRequest) }));
  // Then each code index's sources (an index without `sources` keeps none from code).
  for (const [name, index] of Object.entries(config.vector?.indexes ?? {})) {
    const sources = (index as { sources?: Record<string, unknown> }).sources ?? {};
    const res = await api<{ created: string[]; updated: string[]; deleted: string[] }>(indexPath(config.project, name, "/sources/sync"), { method: "POST", body: JSON.stringify({ sources }) });
    if (res.created.length + res.updated.length + res.deleted.length > 0) {
      print(res, () => console.log(`  ${name} sources: ${res.created.length} created, ${res.updated.length} updated, ${res.deleted.length} deleted`));
    }
  }
}

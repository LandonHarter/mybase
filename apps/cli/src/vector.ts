// `mybase vector …`: vector + full-text indexes apps use with @mybase-dev/sdk/vector.
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
import { confirm, print } from "./output";

export const vectorUsage = `  vector enable <project>        Turn on vector + full-text search
  vector disable <project> [--yes]  Turn it off, deleting every index and document
  vector settings <project>      Show the embedding provider
  vector embedding <project> --url <url> --model <m> --dims <n> [--key]  Set it (--key prompts for an API key)
  vector embedding <project> --off  Remove it
  vector list <project>          List indexes with document counts
  vector create <project> <index> [--dims <n>] [--metric cosine|l2|ip] [--lang english] [--embed]
  vector delete <project> <index> [--yes]  Delete an index and its documents
  vector upsert <project> <index> <file.jsonl>  Upsert documents, one JSON object per line
  vector documents <project> <index> [--limit 20] [--after <id>]  List documents in id order
  vector query <project> <index> [<text>] [--mode text|vector|hybrid] [--top 10] [--filter <json>]
  vector sync [--config <file>] [--dry-run] [--yes]  Make code-defined indexes match mybase.config.ts`;

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
      await api(`/projects/${encodeURIComponent(p)}/services/vector`, { method: "PUT" });
      const settings = await api<VectorServiceSettings>(base(p));
      print({ enabled: "vector", project: p, ...settings }, () => {
        console.log(`Vector search enabled for "${p}"\n`);
        printUsage(p, settings);
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
        console.log(e ? `embedding  ${e.model} (${e.dimensions}d) at ${e.url}${e.hasKey ? ", API key stored" : ""}` : "embedding  none (apps send their own vectors)");
      });
      return true;
    }
    case "embedding": {
      const p = need(project, "project name");
      let body: UpdateVectorSettingsRequest;
      if (flags.has("off")) body = { embedding: null };
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
}

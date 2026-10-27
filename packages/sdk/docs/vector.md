# Vector search

Search your app's documents by meaning, by keywords, or both at once: help centers, product catalogs, memory for an AI agent (RAG). mybase stores them in your project's own database (pgvector + Postgres full-text search).

Turn vector search on from the project's page or with `mybase vector enable <project>`. Your server authenticates with a mybase API key that has `vector:write` for the project (`vector:read` is enough to search): `mybase token create shop-app --project shop --perm vector:write`. Keep it server-side, as `MYBASE_API_KEY`.

## Index and search

```ts
import { createVectorClient } from "@mybase-dev/sdk/vector";

const vector = createVectorClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!,
});

// Once (or in mybase.config.ts): 1536 dimensions, cosine, English keywords, mybase embeds text.
await vector.createIndex("docs", { dimensions: 1536, language: "english", embed: true });

type Meta = { lang: string; url: string };
const docs = vector.index<Meta>("docs");

await docs.upsert([
  { id: "faq-1", title: "Reset your password", text: "Open Settings → Security…", metadata: { lang: "en", url: "/help/reset" } },
  { id: "faq-2", title: "Refunds", text: "Refunds are issued within 30 days…", metadata: { lang: "en", url: "/help/refunds" } },
]);

const { matches } = await docs.query("forgot my password", { topK: 5, filter: { lang: "en" } });
// [{ id: "faq-1", score, title, text, metadata: { lang, url } }, …]
```

`upsert(documents)` inserts or replaces up to 100 documents by id. A document is `{ id, title?, text?, metadata?, vector? }`; `title` and `text` are searched by keyword (title counts more), `metadata` is free-form JSON for filters.

`query(text, options)` or `query({ text?, vector?, ... })`:

- `mode`: `"hybrid"` (vector + keywords, the default when both are possible), `"vector"`, or `"text"`.
- `topK` (1–100, default 10), `filter` (metadata containment: `{ lang: "en" }`), `alpha` (hybrid weight of the vector side, 0–1, default 0.5).
- `includeText` (default true), `includeVectors`, `highlight` (a snippet with matched words in `<b>…</b>`).

Also: `get(ids)`, `delete(ids)` or `delete({ filter })`, `list({ limit, after })` (pages in id order), `info()`; on the client, `listIndexes()`, `getIndex(name)`, `updateIndex(name, { embed })`, `deleteIndex(name)`.

Every call throws `MybaseApiError` (with `status`) when mybase answers with an error: 400 for bad input (wrong vector length, bad filter), 404 for a missing index or when the service is off, 409 for a name taken with other settings, 502/503 when the embedding provider fails.

## Your own vectors

Without an embedding model in the project's settings, send vectors yourself, from any model:

```ts
const embedding = await embed("forgot my password"); // your model, 768 numbers
await vector.createIndex("notes", { dimensions: 768 });
await vector.index("notes").upsert({ id: "n1", text: "…", vector: await embed("…") });
await vector.index("notes").query({ vector: embedding, text: "forgot my password" }); // hybrid
```

With an embedding model set (dashboard or `mybase vector embedding`), indexes with `embed: true` embed documents and query text for you. Any OpenAI-compatible endpoint works: OpenAI, or Ollama on another machine (`http://ollama.lan:11434/v1`, `nomic-embed-text`, 768).

## Keywords only

An index with no `dimensions` is a plain full-text index: `query("refund policy")` ranks by keyword relevance, with stemming for the index's `language` (`simple` turns stemming off). Queries understand `"quoted phrases"`, `or`, and `-excluded` words.

## A tool for an agent

`retrievalTool(index, options)` returns a provider-neutral tool definition (`name`, `description`, `inputSchema`, `run`) for any LLM tool-use loop:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createVectorClient, retrievalTool } from "@mybase-dev/sdk/vector";

const tool = retrievalTool(vector.index("docs"), { about: "the help center", topK: 5, filter: { lang: "en" } });
const anthropic = new Anthropic();
const response = await anthropic.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }],
  messages: [{ role: "user", content: "How do I get a refund?" }],
});
// For each tool_use block: { type: "tool_result", tool_use_id, content: await tool.run(block.input) }
```

`run` returns numbered passages with their ids. Problems the model can work around come back as text starting with `Error:`; a wrong key or a missing index throws.

## Indexes in code

```ts
// mybase.config.ts, then: mybase vector sync
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "shop",
  vector: {
    indexes: {
      docs: { dimensions: 1536, metric: "cosine", language: "english", embed: true },
      notes: { language: "simple" },
    },
  },
});
```

Dimensions, metric, and language can't change once an index exists: remove it, sync, and add it back (its documents are deleted).

## From SQL

Each index is a table, `mybase_vector.<index>` (`id`, `title`, `content`, `metadata`, `embedding`, `tsv`, `updated_at`), readable by the project's role:

```sql
select p.*, d.metadata
from products p join mybase_vector.docs d on d.id = p.id::text
where d.metadata->>'lang' = 'en';
```

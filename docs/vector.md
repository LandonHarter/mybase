---
title: Vector search
summary: Vector, full-text, and hybrid search over your app's documents, on pgvector and Postgres full-text search in the project's own database.
section: Services
order: 19
---

# Vector search

An **index** holds documents (`{ id, title, text, metadata, vector }`) your app searches three ways:

- **vector**: by meaning, nearest vectors first (pgvector, HNSW index).
- **text**: by keywords, with stemming for the index's language (Postgres full-text search; title weighted above text).
- **hybrid**: both, merged with reciprocal rank fusion. The default when both are possible.

Documents live in the project's own database, one table per index in schema `mybase_vector`. The project's role can read them, so SQL can join documents with your own tables. Writes go through the API.

```sh
mybase vector enable shop
mybase token create shop-app --project shop --perm vector:write   # vector:read is enough to search
mybase vector create shop docs --dims 1536 --lang english
```

In apps: `createVectorClient` from `@mybase-dev/sdk/vector`, then `vector.index("docs").upsert([...])` and `.query("text")`. `retrievalTool(index)` turns an index into a tool for an LLM agent. Guide: [SDK vector search](sdk/vector.md).

## Embeddings

Either your app sends vectors (`vector` on documents and queries), or mybase embeds text for you:

1. Set the project's embedding model: any OpenAI-compatible `POST <url>/embeddings` (OpenAI, or Ollama/LM Studio/TEI on another machine). `mybase vector embedding shop --url https://api.openai.com/v1 --model text-embedding-3-small --dims 1536 --key` (prompts for the key), or the dashboard.
2. Create indexes with `embed: true` (`--embed`). Their dimensions default to the model's.

Or embed through the project's [AI gateway](ai.md): `mybase vector embedding shop --ai openai/text-embedding-3-small` (dimensions come from the price catalog, or pass `--dims`). No URL or key here: the gateway uses the provider key from the secrets env `ai`, and every embedding call is logged and priced there under the tag `vector`.

Then documents with text and no vector get embedded (`title` + `text`, cut at 16,000 characters), and text queries are embedded too (cached in Valkey for a day). The API key is encrypted with `MYBASE_SECRETS_KEY`; storing one needs it set. Keyless endpoints (Ollama) work without it. Changing the model's dimensions needs every embedding index turned off first.

Nothing runs a model on the mybase host: a Raspberry Pi has no room for one.

## Indexes

- Name: 1–48 lowercase letters, digits, `_`, starting with a letter (it's a table name). Up to 50 per project.
- `dimensions` (1–2000) or none for a keywords-only index. `metric`: `cosine` (default), `l2`, `ip`. `language`: a Postgres text search config (`english` default, `simple` for no stemming, `french`, `german`, …).
- Dimensions, metric, and language are fixed at creation; only `embed` can change.
- Indexes have a source like queues: `dashboard`, `code` (`mybase.config.ts` + `mybase vector sync`, which confirms before deleting indexes), or `api` (created by app code; `createIndex` is idempotent for identical settings).

## Sources (pipeline)

Instead of upserting chunks yourself, let mybase fill an index. A **source** is read, split into chunks (markdown headings, then paragraphs, then sentences; ~1000 characters with 150 of overlap by default), and upserted; with `embed` on, chunks are embedded too. Each chunk is a document `<item>#<n>` with metadata `{ source, item, chunk, … }`. When an item changes its old chunks are replaced; when it disappears they're deleted.

| Kind | Reads | Notes |
|------|-------|-------|
| `storage` | Files under a prefix of the project's bucket | Markdown, text, CSV, JSON as text; HTML through Readability; **PDF** and **docx** extracted. Up to 25 MB a file. Changed files are found by ETag |
| `table` | Rows of a table in the project's database, as the project role | `text` columns become the document; `metadata` columns are copied; with `updatedAt` only changed rows are read, and a daily full pass finds deleted ones |
| `push` | Text your app sends | `POST /vector/<p>/indexes/<i>/ingest { id, title?, text, metadata? }` (or `{ documents: […] }`, ≤ 100): mybase chunks and embeds it. Re-sending an id replaces its chunks |

```sh
mybase vector source add shop docs handbook --storage handbook/ --include '*.md,*.pdf'
mybase vector source add shop docs products --table public.products --id-col id --text name,description --meta category --updated updated_at
mybase vector sources shop docs                 # status, items, chunks, last error
mybase vector source sync shop docs handbook    # now (apps: POST /vector/<p>/indexes/<i>/sources/<id>/sync after an upload)
mybase vector ingest shop docs ./notes.md
```

Storage and table sources sync every `intervalMin` minutes (default 15; 0 = only when asked). Syncs are jobs: two run at a time, failures retry after 10 s, 60 s, and 5 minutes, and the error shows on the source. Sources can live in `mybase.config.ts` next to their index (`vector.indexes.docs.sources.handbook = { kind: "storage", config: { prefix: "handbook/" } }`); `mybase vector sync` applies them.

## HTTP

Apps call `{{MYBASE_URL}}/vector/<project>/indexes/…` with `Authorization: Bearer <key>`:

- `GET /indexes`, `POST /indexes` `{ name, dimensions?, metric?, language?, embed? }`, `GET|PATCH|DELETE /indexes/<index>`.
- `POST /indexes/<index>/documents` `{ documents: [{ id, title?, text?, metadata?, vector? }] }` (≤ 100, replaces by id) → `{ upserted, embedded }`.
- `GET /indexes/<index>/documents?id=a&id=b` (by id) or `?limit=50&after=<id>` (pages in id order; `includeVectors=true`).
- `POST /indexes/<index>/documents/delete` `{ ids }` or `{ filter }`; `DELETE /indexes/<index>/documents/<id>`.
- `POST /indexes/<index>/query` `{ text?, vector?, mode?, topK?, filter?, alpha?, includeText?, includeVectors?, highlight? }` → `{ mode, matches: [{ id, score, title, text, metadata, highlight? }] }`. Needs only `vector:read`.

`filter` matches metadata by containment: `{ "lang": "en", "tags": ["faq"] }` matches documents whose metadata has `lang = "en"` and a `tags` array containing `"faq"`.

## Limits

- 100 documents per upsert or delete, 10 MB per request. Text ≤ 100,000 characters, title ≤ 1,000, metadata ≤ 16 KB, ids ≤ 256 characters.
- `topK` 1–100. Query text ≤ 2,000 characters. 15 s per query.

## Security

- The project's database role can read every indexed document: only index what that app may see.
- Build metadata filters on the server from values your app trusts. Don't create `mybase_vector` yourself: mybase refuses a schema it didn't make.
- A storage source indexes every matching file under its prefix, and a table source every row the project role can read: point them only at what the index's readers may see.

More: [Security best practices](security-best-practices.md#vector-search).

## Agent notes

- MCP tools: `list_vector_indexes`, `create_vector_index`, `upsert_vector_documents`, `query_vector_index`, `list_vector_sources` (no delete tools).
- For RAG over files or a table, prefer a source (or `/ingest`) over hand-rolled chunking: chunk ids and stale-chunk cleanup come for free.
- A query with text on an index without `embed` (and no vector) runs as keyword search. Ask for `mode: "hybrid"` explicitly to get an error instead when a vector was expected.
- Hybrid scores are small (≈ 1/60) by design: compare them within one result list, not across modes.
- Upserts with embedding call the provider from the mybase server; slow models make upserts slow. Batch documents (up to 100 per call).
- HNSW builds and updates write a lot; on an SD card, prefer fewer, larger upserts.
- Document text and queries are never logged.

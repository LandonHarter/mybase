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

Then documents with text and no vector get embedded (`title` + `text`, cut at 16,000 characters), and text queries are embedded too (cached in Valkey for a day). The API key is encrypted with `MYBASE_SECRETS_KEY`; storing one needs it set. Keyless endpoints (Ollama) work without it. Changing the model's dimensions needs every embedding index turned off first.

Nothing runs a model on the mybase host: a Raspberry Pi has no room for one.

## Indexes

- Name: 1–48 lowercase letters, digits, `_`, starting with a letter (it's a table name). Up to 50 per project.
- `dimensions` (1–2000) or none for a keywords-only index. `metric`: `cosine` (default), `l2`, `ip`. `language`: a Postgres text search config (`english` default, `simple` for no stemming, `french`, `german`, …).
- Dimensions, metric, and language are fixed at creation; only `embed` can change.
- Indexes have a source like queues: `dashboard`, `code` (`mybase.config.ts` + `mybase vector sync`, which confirms before deleting indexes), or `api` (created by app code; `createIndex` is idempotent for identical settings).

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

## Agent notes

- MCP tools: `list_vector_indexes`, `create_vector_index`, `upsert_vector_documents`, `query_vector_index` (no delete tools).
- A query with text on an index without `embed` (and no vector) runs as keyword search. Ask for `mode: "hybrid"` explicitly to get an error instead when a vector was expected.
- Hybrid scores are small (≈ 1/60) by design: compare them within one result list, not across modes.
- Upserts with embedding call the provider from the mybase server; slow models make upserts slow. Batch documents (up to 100 per call).
- HNSW builds and updates write a lot; on an SD card, prefer fewer, larger upserts.
- Document text and queries are never logged.

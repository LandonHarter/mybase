// The vector service: named indexes of documents, searched by meaning (pgvector), keywords
// (Postgres full-text search), or both (hybrid, reciprocal rank fusion).
//
// Documents live in the project's own database, one table per index in schema `mybase_vector`,
// so apps can join them in SQL (the project role gets SELECT). Writes go through the API, which
// keeps embeddings and the generated tsvector consistent. Index settings and the embedding
// provider live in `mybase.vector_*`. Document text and queries are end-user data: never logged.
import {
  VECTOR_INDEX_PATTERN,
  VECTOR_INDEX_RULES,
  VECTOR_LANGUAGES,
  VECTOR_LIMITS,
  VECTOR_METRICS,
  VECTOR_QUERY_MODES,
  type DeleteDocumentsResponse,
  type ListDocumentsResponse,
  type StoredDocument,
  type UpsertDocumentsResponse,
  type VectorIndex,
  type VectorIndexSource,
  type VectorLanguage,
  type VectorMatch,
  type VectorMetadata,
  type VectorMetric,
  type VectorQueryMode,
  type VectorQueryResponse,
  type VectorServiceSettings,
} from "@mybase-dev/sdk/vector";
import type { ProjectContext, SyncVectorIndexesResponse } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors";
import { sql } from "./postgres";
import { projectSql, quoteIdent, userError } from "./project-db";
import { decryptValue, encryptValue, sameId } from "./secrets-crypto";
import { secretsMaster } from "./secrets";
import type { ServiceModule } from "./services";
import { unlinkMatching } from "./valkey";
import { cachePrefix, embed, embedQuery, type Provider } from "./vector-embed";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const SCHEMA = "mybase_vector";
const table = (index: string) => `${SCHEMA}.${quoteIdent(index)}`;

/** Reciprocal rank fusion constant: dampens the gap between the top ranks. */
const RRF_K = 60;
/** Hybrid: candidates taken from each ranking before fusing. */
const HYBRID_CANDIDATES = 4;

const OPERATORS: Record<VectorMetric, string> = { cosine: "<=>", l2: "<->", ip: "<#>" };
// Distance → score, higher is better. `<#>` is the negative inner product.
const SCORES: Record<VectorMetric, string> = { cosine: "1 - dist", l2: "-dist", ip: "-dist" };

// ---- service ----------------------------------------------------------------

const enabled = new Set<string>();

interface IndexRow {
  name: string;
  dimensions: number | null;
  metric: VectorMetric;
  language: VectorLanguage;
  embed: boolean;
  source: VectorIndexSource;
  createdAt: Date;
}

const indexCache = new Map<string, Map<string, IndexRow>>();
const providerCache = new Map<string, Provider | null>();

function forget(project: string) {
  indexCache.delete(project);
  providerCache.delete(project);
}

/** The schema and the extension; safe to repeat (index creation calls it too, in case someone dropped them). */
async function prepareSchema(project: string) {
  const role = quoteIdent(project);
  await projectSql(project).unsafe(`
    create extension if not exists vector;
    create schema if not exists ${SCHEMA};
    grant usage on schema ${SCHEMA} to ${role};
    grant select on all tables in schema ${SCHEMA} to ${role};
    alter default privileges in schema ${SCHEMA} grant select on tables to ${role};`);
}

export const vectorService: ServiceModule = {
  id: "vector",
  async enable(project, log) {
    await prepareSchema(project);
    await sql`insert into mybase.vector_projects (project) values (${project}) on conflict do nothing`;
    log.info("vector search enabled");
  },
  async disable(project, log) {
    // Documents first: if this fails, the service stays on and disabling can be retried.
    await projectSql(project).unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql`delete from mybase.vector_projects where project = ${project}`;
    enabled.delete(project);
    forget(project);
    const cleared = await unlinkMatching(`${cachePrefix(project)}*`).catch(() => 0);
    log.info("vector search disabled", { cleared });
  },
};

export async function requireEnabled(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.vector_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("vector search is not enabled for this project");
  enabled.add(project);
}

// ---- settings (embedding provider) ------------------------------------------

interface ProjectRow {
  url: string | null;
  model: string | null;
  dims: number | null;
  key: Uint8Array | null;
  keyMaster: Uint8Array | null;
  createdAt: Date;
}

async function projectRow(project: string): Promise<ProjectRow> {
  const [row]: ProjectRow[] = await sql`
    select embed_url as url, embed_model as model, embed_dims as dims, embed_key as key, embed_key_master as "keyMaster", created_at as "createdAt"
    from mybase.vector_projects where project = ${project}`;
  if (!row) throw new NotFoundError("vector search is not enabled for this project");
  return row;
}

export async function getSettings(project: string): Promise<VectorServiceSettings> {
  const row = await projectRow(project);
  return {
    apiUrl: publicApiUrl,
    embedding: row.url && row.model && row.dims ? { url: row.url, model: row.model, dimensions: row.dims, hasKey: row.key !== null } : null,
    enabledAt: row.createdAt.toISOString(),
  };
}

const KEY_AAD = ["vector", "embed"] as const;

/** Admin only: the URL is called from this server, with document text. */
export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<VectorServiceSettings> {
  await requireEnabled(project);
  const input = body.embedding;
  if (input === null) {
    await sql`update mybase.vector_projects set embed_url = null, embed_model = null, embed_dims = null, embed_key = null, embed_key_master = null where project = ${project}`;
  } else {
    if (typeof input !== "object" || input === undefined || Array.isArray(input)) throw new BadRequestError("embedding must be an object or null");
    const { url, model, dimensions, apiKey } = input as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\/[^\s/]+/.test(url) || url.length > 500) throw new BadRequestError("embedding.url must be an http(s) URL, e.g. https://api.openai.com/v1");
    if (typeof model !== "string" || !model.trim() || model.length > 200) throw new BadRequestError("embedding.model is required");
    const dims = readDimensions(dimensions, "embedding.dimensions");
    if (dims === null) throw new BadRequestError("embedding.dimensions is required");
    const embedded = [...(await indexRows(project)).values()].filter((i) => i.embed && i.dimensions !== dims);
    if (embedded.length > 0) throw new ConflictError(`index "${embedded[0]!.name}" embeds with ${embedded[0]!.dimensions} dimensions; turn its embedding off first`);
    const cleanUrl = url.trim().replace(/\/+$/, "");
    if (apiKey === undefined) {
      await sql`update mybase.vector_projects set embed_url = ${cleanUrl}, embed_model = ${model.trim()}, embed_dims = ${dims} where project = ${project}`;
    } else if (apiKey === null || apiKey === "") {
      await sql`update mybase.vector_projects set embed_url = ${cleanUrl}, embed_model = ${model.trim()}, embed_dims = ${dims}, embed_key = null, embed_key_master = null where project = ${project}`;
    } else {
      if (typeof apiKey !== "string" || apiKey.length > 1000) throw new BadRequestError("embedding.apiKey must be a string");
      const master = secretsMaster();
      if (!master) throw new ServiceUnavailableError("storing an API key needs MYBASE_SECRETS_KEY (openssl rand -base64 32); keyless providers like Ollama work without it");
      const sealed = await encryptValue(master.key, project, ...KEY_AAD, apiKey);
      await sql`
        update mybase.vector_projects set embed_url = ${cleanUrl}, embed_model = ${model.trim()}, embed_dims = ${dims},
          embed_key = ${Buffer.from(sealed)}, embed_key_master = ${Buffer.from(master.id)}
        where project = ${project}`;
    }
  }
  providerCache.delete(project);
  log.info("vector settings updated", { embedding: input !== null });
  return getSettings(project);
}

async function provider(project: string): Promise<Provider | null> {
  if (providerCache.has(project)) return providerCache.get(project)!;
  const row = await projectRow(project);
  let value: Provider | null = null;
  if (row.url && row.model && row.dims) {
    let apiKey: string | null = null;
    if (row.key) {
      const master = secretsMaster();
      if (!master) throw new ServiceUnavailableError("the embedding API key needs MYBASE_SECRETS_KEY to be set");
      if (!row.keyMaster || !sameId(row.keyMaster, master.id)) {
        throw new ServiceUnavailableError("the embedding API key was stored with a different MYBASE_SECRETS_KEY; enter it again in the vector settings");
      }
      apiKey = await decryptValue(master.key, project, ...KEY_AAD, row.key);
    }
    value = { url: row.url, model: row.model, dimensions: row.dims, apiKey };
  }
  providerCache.set(project, value);
  return value;
}

async function requireProvider(project: string): Promise<Provider> {
  const p = await provider(project);
  if (!p) throw new BadRequestError("this needs an embedding provider: set one in the project's vector settings, or send vectors yourself");
  return p;
}

// ---- indexes ----------------------------------------------------------------

async function indexRows(project: string): Promise<Map<string, IndexRow>> {
  const cached = indexCache.get(project);
  if (cached) return cached;
  const rows: IndexRow[] = await sql`
    select name, dimensions, metric, language, embed, source, created_at as "createdAt"
    from mybase.vector_indexes where project = ${project} order by name`;
  const map = new Map(rows.map((r) => [r.name, r]));
  indexCache.set(project, map);
  return map;
}

async function indexRow(project: string, name: string): Promise<IndexRow> {
  const row = (await indexRows(project)).get(name);
  if (!row) throw new NotFoundError(`no index named "${name}"`);
  return row;
}

/** Document counts: exact for small tables, the planner's estimate for big ones. */
async function documentCounts(project: string, names: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (names.length === 0) return counts;
  const stats: { name: string; tuples: number }[] = await projectSql(project)`
    select c.relname as name, c.reltuples::float8 as tuples from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${SCHEMA} and c.relkind = 'r'`;
  const estimate = new Map(stats.map((s) => [s.name, s.tuples]));
  const small = names.filter((n) => estimate.has(n) && estimate.get(n)! < 10_000);
  for (const n of names) if (estimate.has(n)) counts.set(n, Math.max(0, Math.round(estimate.get(n)!)));
  if (small.length > 0) {
    // Names are checked against VECTOR_INDEX_PATTERN and quoted.
    const rows: { name: string; count: number }[] = await projectSql(project).unsafe(
      small.map((n) => `select '${n}' as name, count(*)::int as count from ${table(n)}`).join(" union all "),
    );
    for (const r of rows) counts.set(r.name, r.count);
  }
  return counts;
}

const toIndex = (row: IndexRow, documents: number): VectorIndex => ({
  name: row.name,
  dimensions: row.dimensions,
  metric: row.metric,
  language: row.language,
  embed: row.embed,
  source: row.source,
  documents,
  createdAt: row.createdAt.toISOString(),
});

export async function listIndexes(project: string): Promise<VectorIndex[]> {
  await requireEnabled(project);
  const rows = [...(await indexRows(project)).values()];
  const counts = await documentCounts(project, rows.map((r) => r.name));
  return rows.map((r) => toIndex(r, counts.get(r.name) ?? 0));
}

export async function getIndex(project: string, name: string): Promise<VectorIndex> {
  await requireEnabled(project);
  const row = await indexRow(project, name);
  const counts = await documentCounts(project, [name]);
  return toIndex(row, counts.get(name) ?? 0);
}

function indexName(value: unknown): string {
  if (typeof value !== "string" || !VECTOR_INDEX_PATTERN.test(value)) throw new BadRequestError(`invalid index name. ${VECTOR_INDEX_RULES}`);
  return value;
}

function readDimensions(value: unknown, field = "dimensions"): number | null {
  if (value === undefined || value === null) return null;
  const { min, max } = VECTOR_LIMITS.dimensions;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  return value as number;
}

type Spec = Pick<IndexRow, "dimensions" | "metric" | "language" | "embed">;

async function readSpec(project: string, body: Record<string, unknown>): Promise<Spec> {
  const metric = body.metric ?? "cosine";
  if (!VECTOR_METRICS.includes(metric as VectorMetric)) throw new BadRequestError(`metric must be one of: ${VECTOR_METRICS.join(", ")}`);
  const language = body.language ?? "english";
  if (!VECTOR_LANGUAGES.includes(language as VectorLanguage)) throw new BadRequestError(`language must be one of: ${VECTOR_LANGUAGES.join(", ")}`);
  const embedOn = body.embed ?? false;
  if (typeof embedOn !== "boolean") throw new BadRequestError("embed must be true or false");
  let dimensions = readDimensions(body.dimensions);
  if (embedOn) {
    const p = await requireProvider(project);
    dimensions ??= p.dimensions;
    if (dimensions !== p.dimensions) throw new BadRequestError(`embed needs dimensions to match the embedding model (${p.dimensions})`);
  }
  return { dimensions, metric: metric as VectorMetric, language: language as VectorLanguage, embed: embedOn };
}

const sameFixed = (a: Spec, b: Spec) => a.dimensions === b.dimensions && a.metric === b.metric && a.language === b.language;

/** The index's table. `language` and `metric` come from fixed lists; the name matches VECTOR_INDEX_PATTERN. */
function tableDdl(name: string, spec: Spec): string {
  const t = table(name);
  const lang = `'${spec.language}'::regconfig`;
  const ddl = [
    `create table ${t} (
      id text primary key,
      title text,
      content text not null default '',
      metadata jsonb not null default '{}',
      ${spec.dimensions ? `embedding vector(${spec.dimensions}),` : ""}
      tsv tsvector generated always as (
        setweight(to_tsvector(${lang}, coalesce(title, '')), 'A') || setweight(to_tsvector(${lang}, content), 'B')
      ) stored,
      updated_at timestamptz not null default now()
    )`,
    `create index on ${t} using gin (tsv)`,
    `create index on ${t} using gin (metadata jsonb_path_ops)`,
  ];
  if (spec.dimensions) ddl.push(`create index on ${t} using hnsw (embedding vector_${spec.metric}_ops)`);
  return ddl.join(";\n");
}

async function createTable(project: string, name: string, spec: Spec) {
  await prepareSchema(project);
  await projectSql(project).begin(async (tx) => {
    await tx.unsafe(`drop table if exists ${table(name)}`);
    await tx.unsafe(tableDdl(name, spec));
  });
}

const dropTable = (project: string, name: string) => projectSql(project).unsafe(`drop table if exists ${table(name)}`);

export async function createIndex(project: string, body: Record<string, unknown>, source: VectorIndexSource, log: Logger): Promise<{ index: VectorIndex; created: boolean }> {
  await requireEnabled(project);
  const name = indexName(body.name);
  const spec = await readSpec(project, body);
  const rows = await indexRows(project);
  const existing = rows.get(name);
  if (existing) {
    if (sameFixed(existing, spec) && existing.embed === spec.embed) return { index: await getIndex(project, name), created: false };
    throw new ConflictError(`an index named "${name}" already exists with different settings`);
  }
  if (rows.size >= VECTOR_LIMITS.indexesPerProject) throw new ConflictError(`a project can have at most ${VECTOR_LIMITS.indexesPerProject} indexes`);
  // Registry row first: it reserves the name, and a failed table is dropped with it.
  try {
    await sql`
      insert into mybase.vector_indexes (project, name, dimensions, metric, language, embed, source)
      values (${project}, ${name}, ${spec.dimensions}, ${spec.metric}, ${spec.language}, ${spec.embed}, ${source})`;
  } catch (err) {
    if ((err as { errno?: string }).errno === "23505") throw new ConflictError(`an index named "${name}" already exists`);
    throw err;
  } finally {
    indexCache.delete(project);
  }
  try {
    await createTable(project, name, spec);
  } catch (err) {
    await sql`delete from mybase.vector_indexes where project = ${project} and name = ${name}`;
    indexCache.delete(project);
    throw err;
  }
  log.info("vector index created", { index: name, dimensions: spec.dimensions, source });
  return { index: await getIndex(project, name), created: true };
}

function codeManaged(name: string, what: string): ConflictError {
  return new ConflictError(`"${name}" is managed in code. ${what} mybase.config.ts and run \`mybase vector sync\``);
}

export async function updateIndex(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<VectorIndex> {
  await requireEnabled(project);
  const row = await indexRow(project, name);
  if (row.source === "code") throw codeManaged(name, "Edit it in");
  for (const field of ["name", "dimensions", "metric", "language"]) {
    if (field in body && body[field] !== row[field as keyof IndexRow]) throw new BadRequestError(`an index's ${field} can't change; create a new index`);
  }
  if (typeof body.embed !== "boolean") throw new BadRequestError("embed must be true or false");
  if (body.embed) {
    const p = await requireProvider(project);
    if (row.dimensions !== p.dimensions) throw new BadRequestError(`this index has ${row.dimensions ?? "no"} dimensions; the embedding model makes ${p.dimensions}`);
  }
  await sql`update mybase.vector_indexes set embed = ${body.embed} where project = ${project} and name = ${name}`;
  indexCache.delete(project);
  log.info("vector index updated", { index: name, embed: body.embed });
  return getIndex(project, name);
}

export async function deleteIndex(project: string, name: string, log: Logger) {
  await requireEnabled(project);
  const row = await indexRow(project, name);
  if (row.source === "code") throw codeManaged(name, "Remove it from");
  await dropTable(project, name);
  await sql`delete from mybase.vector_indexes where project = ${project} and name = ${name}`;
  indexCache.delete(project);
  log.info("vector index deleted", { index: name });
}

/** Makes the project's code-defined indexes match `input` (`mybase vector sync`). */
export async function syncIndexes(project: string, input: unknown, dryRun: boolean, log: Logger): Promise<SyncVectorIndexesResponse> {
  await requireEnabled(project);
  if (!Array.isArray(input)) throw new BadRequestError("indexes must be an array");
  const rows = await indexRows(project);
  const wanted = new Map<string, Spec>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) throw new BadRequestError("each index must be an object");
    const body = item as Record<string, unknown>;
    const name = indexName(body.name);
    if (wanted.has(name)) throw new BadRequestError(`index "${name}" is listed twice`);
    try {
      wanted.set(name, await readSpec(project, body));
    } catch (err) {
      if (err instanceof BadRequestError) throw new BadRequestError(`index "${name}": ${err.message}`);
      throw err;
    }
  }

  const result: SyncVectorIndexesResponse = { created: [], updated: [], deleted: [], unchanged: [] };
  for (const [name, spec] of wanted) {
    const row = rows.get(name);
    if (row && row.source !== "code") throw new ConflictError(`"${name}" already exists as a ${row.source === "api" ? "index created by your app" : "dashboard index"}. Delete it first`);
    if (row && !sameFixed(row, spec)) {
      throw new ConflictError(`"${name}" can't change its dimensions, metric, or language. Remove it, sync, then add it back (its documents are deleted)`);
    }
    if (!row) result.created.push(name);
    else if (row.embed === spec.embed) result.unchanged.push(name);
    else result.updated.push(name);
  }
  for (const row of rows.values()) if (row.source === "code" && !wanted.has(row.name)) result.deleted.push(row.name);
  if (rows.size - result.deleted.length + result.created.length > VECTOR_LIMITS.indexesPerProject) {
    throw new ConflictError(`a project can have at most ${VECTOR_LIMITS.indexesPerProject} indexes`);
  }
  if (dryRun) return result;

  for (const name of result.deleted) {
    await dropTable(project, name);
    await sql`delete from mybase.vector_indexes where project = ${project} and name = ${name}`;
  }
  for (const name of result.updated) await sql`update mybase.vector_indexes set embed = ${wanted.get(name)!.embed} where project = ${project} and name = ${name}`;
  indexCache.delete(project);
  for (const name of result.created) {
    const spec = wanted.get(name)!;
    await sql`
      insert into mybase.vector_indexes (project, name, dimensions, metric, language, embed, source)
      values (${project}, ${name}, ${spec.dimensions}, ${spec.metric}, ${spec.language}, ${spec.embed}, 'code')`;
    indexCache.delete(project);
    await createTable(project, name, spec);
  }
  indexCache.delete(project);
  log.info("vector indexes synced", { created: result.created.length, updated: result.updated.length, deleted: result.deleted.length });
  return result;
}

// ---- documents --------------------------------------------------------------

interface DocInput {
  id: string;
  title: string | null;
  content: string;
  metadata: VectorMetadata;
  vector: number[] | null;
}

function readVector(value: unknown, dims: number | null, field: string): number[] {
  if (dims === null) throw new BadRequestError(`${field}: this index is text only (no dimensions), so it takes no vectors`);
  if (!Array.isArray(value) || !value.every((x) => typeof x === "number" && Number.isFinite(x))) throw new BadRequestError(`${field} must be an array of numbers`);
  if (value.length !== dims) throw new BadRequestError(`${field} has ${value.length} dimensions; the index has ${dims}`);
  return value;
}

function readMetadata(value: unknown, field: string): VectorMetadata {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(`${field} must be an object`);
  if (JSON.stringify(value).length > VECTOR_LIMITS.metadataBytes) throw new BadRequestError(`${field} must be at most ${VECTOR_LIMITS.metadataBytes} bytes as JSON`);
  return value as VectorMetadata;
}

function readId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > VECTOR_LIMITS.idLength) {
    throw new BadRequestError(`${field} must be a string of 1–${VECTOR_LIMITS.idLength} characters`);
  }
  return value;
}

function readDocument(value: unknown, i: number, dims: number | null): DocInput {
  const field = `documents[${i}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestError(`${field} must be an object`);
  const d = value as Record<string, unknown>;
  const title = d.title ?? null;
  if (title !== null && (typeof title !== "string" || title.length > VECTOR_LIMITS.titleLength)) {
    throw new BadRequestError(`${field}.title must be a string of at most ${VECTOR_LIMITS.titleLength} characters`);
  }
  const text = d.text ?? "";
  if (typeof text !== "string" || text.length > VECTOR_LIMITS.textLength) throw new BadRequestError(`${field}.text must be a string of at most ${VECTOR_LIMITS.textLength} characters`);
  return {
    id: readId(d.id, `${field}.id`),
    title: title as string | null,
    content: text,
    metadata: readMetadata(d.metadata, `${field}.metadata`),
    vector: d.vector === undefined || d.vector === null ? null : readVector(d.vector, dims, `${field}.vector`),
  };
}

const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;
const embedText = (d: DocInput) => (d.title ? `${d.title}\n\n${d.content}` : d.content);

export async function upsertDocuments(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<UpsertDocumentsResponse> {
  await requireEnabled(project);
  const index = await indexRow(project, name);
  const input = body.documents;
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestError("documents must be a non-empty array");
  if (input.length > VECTOR_LIMITS.batch) throw new BadRequestError(`at most ${VECTOR_LIMITS.batch} documents per upsert`);
  // Last one wins, like separate upserts (and Postgres can't update one row twice in a statement).
  const docs = [...new Map(input.map((d, i) => readDocument(d, i, index.dimensions)).map((d) => [d.id, d])).values()];

  const toEmbed = index.embed ? docs.filter((d) => !d.vector && embedText(d).trim()) : [];
  if (toEmbed.length > 0) {
    const vectors = await embed(await requireProvider(project), toEmbed.map(embedText), log);
    toEmbed.forEach((d, i) => (d.vector = vectors[i]!));
  }

  const hasVector = index.dimensions !== null;
  const rows = docs.map((d) => ({ id: d.id, title: d.title, content: d.content, metadata: d.metadata, ...(hasVector && { embedding: d.vector && vectorLiteral(d.vector) }) }));
  const cols = hasVector ? "id, title, content, metadata, embedding" : "id, title, content, metadata";
  const select = hasVector ? "id, title, content, metadata, embedding::vector" : "id, title, content, metadata";
  const recordset = `id text, title text, content text, metadata jsonb${hasVector ? ", embedding text" : ""}`;
  const updates = cols
    .split(", ")
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  try {
    await projectSql(project).unsafe(
      `insert into ${table(name)} (${cols})
       select ${select} from jsonb_to_recordset($1::text::jsonb) as x(${recordset})
       on conflict (id) do update set ${updates}, updated_at = now()`,
      [JSON.stringify(rows)],
    );
  } catch (err) {
    userError(err);
  }
  log.info("vector documents upserted", { index: name, documents: docs.length, embedded: toEmbed.length });
  return { upserted: docs.length, embedded: toEmbed.length };
}

interface DocRow {
  id: string;
  title: string | null;
  content: string;
  metadata: VectorMetadata;
  vector?: string | null;
  updatedAt: Date;
}

const toStored = (r: DocRow): StoredDocument => ({
  id: r.id,
  title: r.title,
  text: r.content,
  metadata: r.metadata,
  ...(r.vector !== undefined && { vector: r.vector === null ? null : (JSON.parse(r.vector) as number[]) }),
  updatedAt: r.updatedAt.toISOString(),
});

/** `GET …/documents`: by `id` (repeated), or a page in id order (`limit`, `after`). */
export async function listDocuments(project: string, name: string, params: URLSearchParams): Promise<ListDocumentsResponse> {
  await requireEnabled(project);
  const index = await indexRow(project, name);
  const withVectors = params.get("includeVectors") === "true" && index.dimensions !== null;
  const columns = `id, title, content, metadata, updated_at as "updatedAt"${withVectors ? ", embedding::text as vector" : ""}`;
  const ids = params.getAll("id");
  if (ids.length > 0) {
    if (ids.length > VECTOR_LIMITS.batch) throw new BadRequestError(`at most ${VECTOR_LIMITS.batch} ids at once`);
    const rows: DocRow[] = await projectSql(project).unsafe(`select ${columns} from ${table(name)} where id in (select jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(ids)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { documents: ids.flatMap((id) => (byId.has(id) ? [toStored(byId.get(id)!)] : [])), next: null };
  }
  const raw = params.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > VECTOR_LIMITS.batch) throw new BadRequestError(`limit must be an integer from 1 to ${VECTOR_LIMITS.batch}`);
  const after = params.get("after");
  const rows: DocRow[] = await projectSql(project).unsafe(
    `select ${columns} from ${table(name)} where ($1::text is null or id > $1) order by id limit $2`,
    [after, limit + 1],
  );
  const page = rows.slice(0, limit);
  return { documents: page.map(toStored), next: rows.length > limit ? page.at(-1)!.id : null };
}

export async function deleteDocuments(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<DeleteDocumentsResponse> {
  await requireEnabled(project);
  await indexRow(project, name);
  const { ids, filter } = body;
  let result: { count: number };
  if (ids !== undefined) {
    if (filter !== undefined) throw new BadRequestError("send ids or filter, not both");
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > VECTOR_LIMITS.batch) throw new BadRequestError(`ids must be an array of 1–${VECTOR_LIMITS.batch} ids`);
    const checked = ids.map((id, i) => readId(id, `ids[${i}]`));
    result = await projectSql(project).unsafe(`delete from ${table(name)} where id in (select jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(checked)]);
  } else {
    const f = readMetadata(filter, "filter");
    // An empty filter matches everything: deleting the whole index is deleteIndex's job.
    if (Object.keys(f).length === 0) throw new BadRequestError("send ids or a non-empty filter");
    result = await projectSql(project).unsafe(`delete from ${table(name)} where metadata @> $1::text::jsonb`, [JSON.stringify(f)]);
  }
  log.info("vector documents deleted", { index: name, documents: result.count });
  return { deleted: result.count };
}

export async function deleteDocument(project: string, name: string, id: string, log: Logger) {
  const { deleted } = await deleteDocuments(project, name, { ids: [id] }, log);
  if (deleted === 0) throw new NotFoundError(`no document "${id}" in index "${name}"`);
}

// ---- query ------------------------------------------------------------------

interface Query {
  text: string | null;
  vector: number[] | null;
  mode: VectorQueryMode | null;
  topK: number;
  filter: VectorMetadata | null;
  alpha: number;
  includeText: boolean;
  includeVectors: boolean;
  highlight: boolean;
}

function readQuery(body: Record<string, unknown>, index: IndexRow): Query {
  const text = body.text ?? null;
  if (text !== null && (typeof text !== "string" || text.length > VECTOR_LIMITS.queryLength)) {
    throw new BadRequestError(`text must be a string of at most ${VECTOR_LIMITS.queryLength} characters`);
  }
  const mode = body.mode ?? null;
  if (mode !== null && !VECTOR_QUERY_MODES.includes(mode as VectorQueryMode)) throw new BadRequestError(`mode must be one of: ${VECTOR_QUERY_MODES.join(", ")}`);
  const { min, max, default: fallback } = VECTOR_LIMITS.topK;
  const topK = body.topK ?? fallback;
  if (!Number.isInteger(topK) || (topK as number) < min || (topK as number) > max) throw new BadRequestError(`topK must be an integer from ${min} to ${max}`);
  const alpha = body.alpha ?? 0.5;
  if (typeof alpha !== "number" || alpha < 0 || alpha > 1) throw new BadRequestError("alpha must be a number from 0 to 1");
  const flag = (key: string, fallbackValue: boolean) => {
    const v = body[key] ?? fallbackValue;
    if (typeof v !== "boolean") throw new BadRequestError(`${key} must be true or false`);
    return v;
  };
  const filter = body.filter === undefined || body.filter === null ? null : readMetadata(body.filter, "filter");
  return {
    text: (text as string | null)?.trim() || null,
    vector: body.vector === undefined || body.vector === null ? null : readVector(body.vector, index.dimensions, "vector"),
    mode: mode as VectorQueryMode | null,
    topK: topK as number,
    filter: filter && Object.keys(filter).length > 0 ? filter : null,
    alpha,
    includeText: flag("includeText", true),
    includeVectors: flag("includeVectors", false) && index.dimensions !== null,
    highlight: flag("highlight", false),
  };
}

/** Which mode runs, given what the request and index allow. */
export function pickMode(requested: VectorQueryMode | null, hasText: boolean, canVector: boolean): VectorQueryMode {
  if (requested === "text" && !hasText) throw new BadRequestError("text search needs text");
  if (requested === "vector" && !canVector) throw new BadRequestError("vector search needs a vector, or text and an index with embed on");
  if (requested === "hybrid" && !(hasText && canVector)) throw new BadRequestError("hybrid search needs text, plus a vector or an index with embed on");
  if (requested) return requested;
  if (hasText && canVector) return "hybrid";
  if (canVector) return "vector";
  if (hasText) return "text";
  throw new BadRequestError("send text, a vector, or both");
}

export async function query(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<VectorQueryResponse> {
  await requireEnabled(project);
  const index = await indexRow(project, name);
  const q = readQuery(body, index);
  const canVector = index.dimensions !== null && (q.vector !== null || (q.text !== null && index.embed));
  const mode = pickMode(q.mode, q.text !== null, canVector);
  let vector = q.vector;
  if (mode !== "text" && !vector) vector = await embedQuery(project, await requireProvider(project), q.text!, log);

  const params: unknown[] = [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const t = table(name);
  const lang = `'${index.language}'::regconfig`;
  // Only bound when used: Postgres can't type a parameter the statement never mentions.
  const textQuery = q.text && (mode !== "vector" || q.highlight) ? p(q.text) : null;
  const tsq = textQuery && `websearch_to_tsquery(${lang}, ${textQuery})`;
  const filter = q.filter ? `and metadata @> ${p(JSON.stringify(q.filter))}::text::jsonb` : "";
  const vec = vector ? `${p(vectorLiteral(vector))}::vector` : null;
  const op = OPERATORS[index.metric];

  const textHits = (limit: string) => `
    select id, ts_rank_cd(tsv, ${tsq})::float8 as score from ${t}
    where tsv @@ ${tsq} ${filter} order by score desc limit ${limit}`;
  const vectorHits = (limit: string) => `
    select id, (embedding ${op} ${vec})::float8 as dist from ${t}
    where embedding is not null ${filter} order by embedding ${op} ${vec} limit ${limit}`;

  let hits: string;
  if (mode === "text") hits = textHits(p(q.topK));
  else if (mode === "vector") hits = `select id, ${SCORES[index.metric]} as score from (${vectorHits(p(q.topK))}) v`;
  else {
    const candidates = p(q.topK * HYBRID_CANDIDATES);
    const alpha = p(q.alpha);
    hits = `
      select id, coalesce(${alpha}::float8 / (${RRF_K} + v.r), 0) + coalesce((1 - ${alpha}::float8) / (${RRF_K} + x.r), 0) as score
      from (select id, row_number() over (order by dist) as r from (${vectorHits(candidates)}) v0) v
      full join (select id, row_number() over (order by score desc) as r from (${textHits(candidates)}) x0) x using (id)
      order by score desc limit ${p(q.topK)}`;
  }
  const columns = [
    "d.id",
    "d.title",
    "d.metadata",
    "h.score",
    q.includeText ? "d.content" : null,
    q.includeVectors ? "d.embedding::text as vector" : null,
    q.highlight && tsq ? `ts_headline(${lang}, d.content, ${tsq}, 'MaxFragments=2, MaxWords=30, MinWords=10') as highlight` : null,
  ].filter(Boolean);
  const statement = `with h as (${hits}) select ${columns.join(", ")} from h join ${t} d using (id) order by h.score desc`;

  type Row = { id: string; title: string | null; metadata: VectorMetadata; score: number; content?: string; vector?: string | null; highlight?: string };
  let rows: Row[];
  try {
    rows = await projectSql(project).begin(async (tx) => {
      // Filtered HNSW scans keep going until they find enough rows (pgvector ≥ 0.8).
      await tx.unsafe(`set local statement_timeout = '15s'; set local hnsw.ef_search = ${Math.max(40, q.topK * 2)}; set local hnsw.iterative_scan = relaxed_order`);
      return tx.unsafe(statement, params);
    });
  } catch (err) {
    userError(err);
  }
  const matches: VectorMatch[] = rows.map((r) => ({
    id: r.id,
    score: r.score,
    title: r.title,
    metadata: r.metadata,
    ...(r.content !== undefined && { text: r.content }),
    ...(r.vector !== undefined && { vector: r.vector === null ? null : (JSON.parse(r.vector) as number[]) }),
    ...(r.highlight !== undefined && { highlight: r.highlight }),
  }));
  log.info("vector query", { index: name, mode, matches: matches.length, filtered: q.filter !== null });
  return { mode, matches };
}

// ---- context ----------------------------------------------------------------

export async function vectorContext(project: string): Promise<NonNullable<ProjectContext["vector"]>> {
  const [settings, indexes] = await Promise.all([getSettings(project), listIndexes(project)]);
  return {
    embedding: settings.embedding && { model: settings.embedding.model, dimensions: settings.embedding.dimensions },
    indexes: indexes.map(({ name, dimensions, metric, language, embed, documents, source }) => ({ name, dimensions, metric, language, embed, documents, source })),
  };
}

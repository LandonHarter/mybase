// The memory service (`memory`): mem0-style long-term memory for agents. `add` sends the
// conversation through the AI gateway twice (extract facts, then reconcile them with the
// closest existing memories: ADD/UPDATE/DELETE/NONE) and applies the result in one transaction,
// with history. Search is vector, keyword, or hybrid (RRF) within a user/agent/run scope.
//
// Memories live in the project's own database, schema `mybase_memory`, owned by the project's
// internal role like vector indexes (the project role can read them). Settings are in
// `mybase.memory_projects`. Memory text is end-user data: never logged (counts only).
import {
  MEMORY_LIMITS,
  type AddMemoryResponse,
  type ListMemoriesResponse,
  type Memory,
  type MemoryHistoryEntry,
  type MemoryMatch,
  type MemoryMetadata,
  type MemoryScopeCount,
  type MemorySettings,
  type SearchMemoryResponse,
} from "@mybase-dev/sdk/memory";
import type { ProjectContext } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { createHash } from "node:crypto";
import { requireEnabled as requireAi } from "./ai";
import { chatInternal, embedInternal, embeddingDimensions } from "./ai-gateway";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { conversationText, DECISIONS_SCHEMA, decisionsPrompt, FACTS_SCHEMA, factsPrompt, parseDecisions, parseFacts, type Decision } from "./memory-prompts";
import { sql } from "./postgres";
import { internalRole, internalSql, projectSql, quoteIdent, schemaOwner, userError } from "./project-db";
import type { ServiceModule } from "./services";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const SCHEMA = "mybase_memory";
const T = `${SCHEMA}.memories`;
const H = `${SCHEMA}.memory_history`;
const RRF_K = 60;
const SIMILAR = 5;

export const DEFAULT_LLM = "openai/gpt-5-mini";
export const DEFAULT_EMBED = "openai/text-embedding-3-small";
const DEFAULT_DIMS = 1536;

// ---- settings ---------------------------------------------------------------

interface Settings {
  llmModel: string;
  embedModel: string;
  dims: number;
  customPrompt: string | null;
  defaultTtlDays: number | null;
  createdAt: Date;
}

const settingsCache = new Map<string, Settings>();

async function settings(project: string): Promise<Settings> {
  const hit = settingsCache.get(project);
  if (hit) return hit;
  const [row]: Settings[] = await sql`
    select llm_model as "llmModel", embed_model as "embedModel", dims, custom_prompt as "customPrompt", default_ttl_days as "defaultTtlDays", created_at as "createdAt"
    from mybase.memory_projects where project = ${project}`;
  if (!row) throw new NotFoundError("memory is not enabled for this project");
  settingsCache.set(project, row);
  return row;
}

export async function requireEnabled(project: string) {
  await settings(project);
}

// ---- schema -------------------------------------------------------------------

const prepared = new Map<string, Promise<void>>();

async function prepareSchema(project: string, dims: number) {
  const role = quoteIdent(project);
  const internal = quoteIdent(internalRole(project));
  const su = projectSql(project);
  await su.unsafe(`create extension if not exists vector`);
  const owner = await schemaOwner(project, SCHEMA);
  if (!owner) await su.unsafe(`create schema if not exists ${SCHEMA} authorization ${internal}`);
  else if (owner.owner !== internalRole(project)) {
    throw new ConflictError(`schema "${SCHEMA}" already exists in this database and belongs to "${owner.owner}"; memory needs it for itself. Drop or rename it first`);
  }
  const db = await internalSql(project);
  await db.unsafe(`
    create table if not exists ${T} (
      id uuid primary key default gen_random_uuid(),
      user_id text,
      agent_id text,
      run_id text,
      content text not null,
      metadata jsonb not null default '{}',
      hash text not null,
      embedding vector(${dims}),
      tsv tsvector generated always as (to_tsvector('simple', content)) stored,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      expires_at timestamptz
    );
    create index if not exists memories_embedding on ${T} using hnsw (embedding vector_cosine_ops);
    create index if not exists memories_tsv on ${T} using gin (tsv);
    create index if not exists memories_metadata on ${T} using gin (metadata jsonb_path_ops);
    create index if not exists memories_scope on ${T} (user_id, agent_id, created_at desc);
    create table if not exists ${H} (
      id bigserial primary key,
      memory_id uuid not null,
      event text not null check (event in ('ADD','UPDATE','DELETE')),
      old text,
      new text,
      at timestamptz not null default now()
    );
    create index if not exists memory_history_memory on ${H} (memory_id, at);
    grant usage on schema ${SCHEMA} to ${role};
    grant select on all tables in schema ${SCHEMA} to ${role};
    alter default privileges in schema ${SCHEMA} grant select on tables to ${role};`);
}

async function msql(project: string) {
  let ready = prepared.get(project);
  if (!ready) {
    ready = settings(project).then((s) => prepareSchema(project, s.dims));
    ready.catch(() => prepared.delete(project));
    prepared.set(project, ready);
  }
  await ready;
  return internalSql(project);
}

export const memoryService: ServiceModule = {
  id: "memory",
  async enable(project, log) {
    // The AI gateway is on by now (SERVICE_REQUIRES).
    const dims = (await embeddingDimensions(project, DEFAULT_EMBED).catch(() => null)) ?? DEFAULT_DIMS;
    await sql`insert into mybase.memory_projects (project, llm_model, embed_model, dims) values (${project}, ${DEFAULT_LLM}, ${DEFAULT_EMBED}, ${dims}) on conflict do nothing`;
    settingsCache.delete(project);
    const s = await settings(project);
    await prepareSchema(project, s.dims);
    log.info("memory enabled");
  },
  async disable(project, log) {
    await projectSql(project).unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql`delete from mybase.memory_projects where project = ${project}`;
    settingsCache.delete(project);
    prepared.delete(project);
    log.info("memory disabled");
  },
};

async function countMemories(project: string): Promise<number> {
  const [row]: { count: number }[] = await (await msql(project)).unsafe(`select count(*)::int as count from ${T} where expires_at is null or expires_at > now()`);
  return row?.count ?? 0;
}

export async function getSettings(project: string): Promise<MemorySettings> {
  const s = await settings(project);
  return {
    apiUrl: publicApiUrl,
    llmModel: s.llmModel,
    embedModel: s.embedModel,
    dimensions: s.dims,
    customPrompt: s.customPrompt,
    defaultTtlDays: s.defaultTtlDays,
    memories: await countMemories(project),
    enabledAt: s.createdAt.toISOString(),
  };
}

function readModel(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new BadRequestError(`${field} must be a gateway model id or alias`);
  return value.trim();
}

export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<MemorySettings> {
  const s = await settings(project);
  await requireAi(project);
  const sets: Record<string, unknown> = {};
  if (body.llmModel !== undefined) sets.llm_model = readModel(body.llmModel, "llmModel");
  if (body.customPrompt !== undefined) {
    if (body.customPrompt !== null && (typeof body.customPrompt !== "string" || body.customPrompt.length > 4000))
      throw new BadRequestError("customPrompt must be up to 4000 characters, or null");
    sets.custom_prompt = body.customPrompt || null;
  }
  if (body.defaultTtlDays !== undefined) {
    const v = body.defaultTtlDays;
    if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 3650)) throw new BadRequestError("defaultTtlDays must be 1–3650, or null to keep memories");
    sets.default_ttl_days = v;
  }
  let reembed = false;
  if (body.embedModel !== undefined || body.dimensions !== undefined) {
    const model = body.embedModel === undefined ? s.embedModel : readModel(body.embedModel, "embedModel");
    const dims = body.dimensions === undefined ? ((await embeddingDimensions(project, model).catch(() => null)) ?? s.dims) : body.dimensions;
    if (!Number.isInteger(dims) || (dims as number) < 1 || (dims as number) > 2000) throw new BadRequestError("dimensions must be 1–2000");
    if (dims !== s.dims && (await countMemories(project)) > 0)
      throw new ConflictError(`the new model makes ${dims} dimensions and memories have ${s.dims}: delete the memories first, or pick a model with ${s.dims}`);
    if (dims !== s.dims) {
      await (await msql(project)).unsafe(`alter table ${T} alter column embedding type vector(${dims as number})`);
    }
    reembed = model !== s.embedModel;
    sets.embed_model = model;
    sets.dims = dims;
  }
  if (Object.keys(sets).length === 0) throw new BadRequestError("nothing to change");
  await sql`update mybase.memory_projects set ${sql(sets)} where project = ${project}`;
  settingsCache.delete(project);
  if (reembed) await reembedAll(project, log);
  log.info("memory settings updated", { fields: Object.keys(sets).join(","), reembedded: reembed });
  return getSettings(project);
}

/** After an embedding model change: every memory gets a new vector. */
async function reembedAll(project: string, log: Logger) {
  const db = await msql(project);
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows: { id: string; content: string }[] = await db.unsafe(`select id::text, content from ${T} where id > $1::uuid order by id limit 64`, [after]);
    if (rows.length === 0) break;
    const vectors = await embed(
      project,
      rows.map((r) => r.content),
      log,
    );
    await db.unsafe(`update ${T} m set embedding = x.embedding::vector from jsonb_to_recordset($1::text::jsonb) as x(id uuid, embedding text) where m.id = x.id`, [
      JSON.stringify(rows.map((r, i) => ({ id: r.id, embedding: vectorLiteral(vectors[i]!) }))),
    ]);
    after = rows.at(-1)!.id;
  }
}

// ---- helpers --------------------------------------------------------------------

interface Scope {
  userId: string | null;
  agentId: string | null;
  runId: string | null;
}

function readScope(source: Record<string, unknown> | URLSearchParams, required: boolean): Scope {
  const get = (k: string) => (source instanceof URLSearchParams ? source.get(k) : source[k]);
  const scope: Scope = { userId: null, agentId: null, runId: null };
  for (const k of ["userId", "agentId", "runId"] as const) {
    const v = get(k);
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > MEMORY_LIMITS.scopeIdLength) throw new BadRequestError(`${k} must be a string of up to ${MEMORY_LIMITS.scopeIdLength} characters`);
    scope[k] = v;
  }
  if (required && !scope.userId && !scope.agentId && !scope.runId) throw new BadRequestError("send a userId, agentId, or runId: memories belong to someone");
  return scope;
}

function readMetadata(value: unknown, field = "metadata"): MemoryMetadata {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(`${field} must be an object`);
  if (JSON.stringify(value).length > MEMORY_LIMITS.metadataBytes) throw new BadRequestError(`${field} must be at most ${MEMORY_LIMITS.metadataBytes} bytes as JSON`);
  return value as MemoryMetadata;
}

const hashOf = (text: string) => createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 32);
const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

async function embed(project: string, texts: string[], log: Logger): Promise<number[][]> {
  const s = await settings(project);
  const vectors = await embedInternal(project, s.embedModel, texts, { tag: "memory", log, dimensions: s.dims });
  for (const v of vectors) if (v.length !== s.dims) throw new BadRequestError(`the embedding model returned ${v.length} dimensions; memory is set to ${s.dims}`);
  return vectors;
}

/** `and user_id = $n …` for the ids in the scope. */
function scopeWhere(scope: Scope, p: (v: unknown) => string, alias = ""): string {
  const parts = ["(" + alias + "expires_at is null or " + alias + "expires_at > now())"];
  if (scope.userId) parts.push(`${alias}user_id = ${p(scope.userId)}`);
  if (scope.agentId) parts.push(`${alias}agent_id = ${p(scope.agentId)}`);
  if (scope.runId) parts.push(`${alias}run_id = ${p(scope.runId)}`);
  return parts.join(" and ");
}

interface Row {
  id: string;
  content: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  metadata: MemoryMetadata;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  score?: number;
}

const COLUMNS = `id::text, content, user_id as "userId", agent_id as "agentId", run_id as "runId", metadata, created_at as "createdAt", updated_at as "updatedAt", expires_at as "expiresAt"`;

const toMemory = (r: Row): Memory => ({
  id: r.id,
  memory: r.content,
  userId: r.userId,
  agentId: r.agentId,
  runId: r.runId,
  metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
});

// ---- add --------------------------------------------------------------------------

function readInput(body: Record<string, unknown>): { messages: { role: string; content: string }[] | null; text: string | null } {
  if (body.messages !== undefined) {
    const m = body.messages;
    if (!Array.isArray(m) || m.length === 0 || m.length > MEMORY_LIMITS.messages) throw new BadRequestError(`messages must be a list of 1–${MEMORY_LIMITS.messages} messages`);
    const messages = m.map((x, i) => {
      const msg = x as { role?: unknown; content?: unknown };
      if (typeof msg?.role !== "string" || typeof msg.content !== "string") throw new BadRequestError(`messages[${i}] needs a role and string content`);
      return { role: msg.role, content: msg.content };
    });
    if (messages.reduce((n, x) => n + x.content.length, 0) > MEMORY_LIMITS.inputChars) throw new BadRequestError(`messages are over ${MEMORY_LIMITS.inputChars} characters`);
    return { messages, text: null };
  }
  if (typeof body.text !== "string" || !body.text.trim()) throw new BadRequestError("send messages or text");
  if (body.text.length > MEMORY_LIMITS.inputChars) throw new BadRequestError(`text is over ${MEMORY_LIMITS.inputChars} characters`);
  return { messages: null, text: body.text };
}

function contentOf(json: Record<string, unknown>): unknown {
  return (json.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
}

async function llmJson(project: string, system: string, user: string, schema: object, name: string, log: Logger): Promise<unknown> {
  const s = await settings(project);
  const json = await chatInternal(
    project,
    {
      model: s.llmModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
    },
    { tag: "memory", log },
  );
  return contentOf(json);
}

export async function add(project: string, body: Record<string, unknown>, log: Logger, _signal?: AbortSignal): Promise<AddMemoryResponse> {
  const s = await settings(project);
  const scope = readScope(body, true);
  const metadata = readMetadata(body.metadata);
  const input = readInput(body);
  const infer = body.infer ?? true;
  if (typeof infer !== "boolean") throw new BadRequestError("infer must be true or false");
  const ttl = body.ttlDays ?? s.defaultTtlDays;
  if (ttl !== null && (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 3650)) throw new BadRequestError("ttlDays must be 1–3650");
  const expires = ttl === null ? null : new Date(Date.now() + (ttl as number) * 86_400_000);
  const db = await msql(project);
  await db.unsafe(`delete from ${T} where expires_at < now()`);

  if (!infer) {
    const text = (input.text ?? conversationText(input.messages!)).trim().slice(0, MEMORY_LIMITS.contentLength);
    const [vector] = await embed(project, [text], log);
    const hash = hashOf(text);
    const result = await db.begin(async (tx): Promise<AddMemoryResponse["results"]> => {
      const p: unknown[] = [];
      const ph = (v: unknown) => (p.push(v), `$${p.length}`);
      const [dup]: { id: string }[] = await tx.unsafe(`select id::text from ${T} where hash = ${ph(hash)} and ${scopeWhere(scope, ph)} limit 1`, p);
      if (dup) return [];
      const [row]: { id: string }[] = await tx.unsafe(
        `insert into ${T} (user_id, agent_id, run_id, content, metadata, hash, embedding, expires_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7::vector, $8) returning id::text`,
        [scope.userId, scope.agentId, scope.runId, text, JSON.stringify(metadata), hash, vectorLiteral(vector!), expires],
      );
      await tx.unsafe(`insert into ${H} (memory_id, event, new) values ($1::uuid, 'ADD', $2)`, [row!.id, text]);
      return [{ id: row!.id, memory: text, event: "ADD" }];
    });
    log.info("memories added", { added: result.length, inferred: false });
    return { results: result };
  }

  // 1. Facts.
  const conversation = input.messages ? conversationText(input.messages) : `user: ${input.text}`;
  const facts = parseFacts(
    await llmJson(project, factsPrompt(s.customPrompt, new Date().toISOString().slice(0, 10)), conversation, FACTS_SCHEMA, "facts", log),
    MEMORY_LIMITS.contentLength,
  );
  if (facts.length === 0) return { results: [] };

  // 2. Their vectors, and 3. the closest existing memories in the scope.
  const factVectors = await embed(project, facts, log);
  const existing = new Map<string, string>();
  for (const v of factVectors) {
    const p: unknown[] = [];
    const ph = (x: unknown) => (p.push(x), `$${p.length}`);
    const vec = ph(vectorLiteral(v));
    const rows: { id: string; content: string }[] = await db.unsafe(
      `select id::text, content from ${T} where embedding is not null and ${scopeWhere(scope, ph)} order by embedding <=> ${vec}::vector limit ${SIMILAR}`,
      p,
    );
    for (const r of rows) existing.set(r.id, r.content);
  }
  const tempIds = [...existing.keys()];

  // 4. Decisions, with small integer ids.
  let decisions: Decision[];
  if (tempIds.length === 0) decisions = facts.map((text) => ({ event: "ADD", text }));
  else {
    const prompt = decisionsPrompt(
      tempIds.map((id, i) => ({ id: String(i), text: existing.get(id)! })),
      facts,
    );
    decisions = parseDecisions(
      await llmJson(project, "You keep a user's memory store accurate and free of duplicates.", prompt, DECISIONS_SCHEMA, "memory_decisions", log),
      tempIds,
      existing,
      MEMORY_LIMITS.contentLength,
    );
  }

  // Vectors for new texts (reused when the text is one of the facts).
  const needs = decisions.filter((d): d is Extract<Decision, { text: string }> => d.event === "ADD" || d.event === "UPDATE").map((d) => d.text);
  const known = new Map(facts.map((f, i) => [f, factVectors[i]!]));
  const missing = [...new Set(needs.filter((t) => !known.has(t)))];
  if (missing.length) (await embed(project, missing, log)).forEach((v, i) => known.set(missing[i]!, v));

  // 5. Applied in one transaction, with history.
  const results: AddMemoryResponse["results"] = [];
  try {
    await db.begin(async (tx) => {
      for (const d of decisions) {
        if (d.event === "ADD") {
          const hash = hashOf(d.text);
          const p: unknown[] = [];
          const ph = (v: unknown) => (p.push(v), `$${p.length}`);
          const [dup] = await tx.unsafe(`select 1 from ${T} where hash = ${ph(hash)} and ${scopeWhere(scope, ph)} limit 1`, p);
          if (dup) continue;
          const [row]: { id: string }[] = await tx.unsafe(
            `insert into ${T} (user_id, agent_id, run_id, content, metadata, hash, embedding, expires_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7::vector, $8) returning id::text`,
            [scope.userId, scope.agentId, scope.runId, d.text, JSON.stringify(metadata), hash, vectorLiteral(known.get(d.text)!), expires],
          );
          await tx.unsafe(`insert into ${H} (memory_id, event, new) values ($1::uuid, 'ADD', $2)`, [row!.id, d.text]);
          results.push({ id: row!.id, memory: d.text, event: "ADD" });
        } else if (d.event === "UPDATE") {
          await tx.unsafe(`update ${T} set content = $2, hash = $3, embedding = $4::vector, metadata = metadata || $5::text::jsonb, updated_at = now() where id = $1::uuid`, [
            d.id,
            d.text,
            hashOf(d.text),
            vectorLiteral(known.get(d.text)!),
            JSON.stringify(metadata),
          ]);
          await tx.unsafe(`insert into ${H} (memory_id, event, old, new) values ($1::uuid, 'UPDATE', $2, $3)`, [d.id, d.old, d.text]);
          results.push({ id: d.id, memory: d.text, event: "UPDATE", previous: d.old });
        } else if (d.event === "DELETE") {
          await tx.unsafe(`delete from ${T} where id = $1::uuid`, [d.id]);
          await tx.unsafe(`insert into ${H} (memory_id, event, old) values ($1::uuid, 'DELETE', $2)`, [d.id, d.old]);
          results.push({ id: d.id, memory: d.old, event: "DELETE" });
        }
      }
    });
  } catch (err) {
    userError(err);
  }
  log.info("memories added", {
    facts: facts.length,
    added: results.filter((r) => r.event === "ADD").length,
    updated: results.filter((r) => r.event === "UPDATE").length,
    deleted: results.filter((r) => r.event === "DELETE").length,
  });
  return { results };
}

// ---- search -----------------------------------------------------------------------

export async function search(project: string, body: Record<string, unknown>, log: Logger): Promise<SearchMemoryResponse> {
  await settings(project);
  const scope = readScope(body, false);
  const query = body.query;
  if (typeof query !== "string" || !query.trim() || query.length > 2000) throw new BadRequestError("query must be a string of 1–2000 characters");
  const { min, max, default: fallback } = MEMORY_LIMITS.topK;
  const topK = body.topK ?? fallback;
  if (!Number.isInteger(topK) || (topK as number) < min || (topK as number) > max) throw new BadRequestError(`topK must be an integer from ${min} to ${max}`);
  const mode = body.mode ?? "hybrid";
  if (mode !== "hybrid" && mode !== "vector" && mode !== "text") throw new BadRequestError("mode must be hybrid, vector, or text");
  const threshold = body.threshold;
  if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0 || threshold > 1)) throw new BadRequestError("threshold must be from 0 to 1");
  const filter = readMetadata(body.filter, "filter");

  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = `${scopeWhere(scope, p)}${Object.keys(filter).length ? ` and metadata @> ${p(JSON.stringify(filter))}::text::jsonb` : ""}`;
  const vec = mode !== "text" ? `${p(vectorLiteral((await embed(project, [query.trim()], log))[0]!))}::vector` : null;
  const tsq = mode !== "vector" ? `websearch_to_tsquery('simple', ${p(query.trim())})` : null;
  const k = p(topK);
  const cand = p((topK as number) * 4);
  const vectorHits = (limit: string) =>
    `select id, 1 - (embedding <=> ${vec}) as sim from ${T} where embedding is not null and ${where} order by embedding <=> ${vec} limit ${limit}`;
  const textHits = (limit: string) => `select id, ts_rank_cd(tsv, ${tsq})::float8 as score from ${T} where tsv @@ ${tsq} and ${where} order by score desc limit ${limit}`;
  let hits: string;
  if (mode === "vector") hits = `select id, sim as score from (${vectorHits(k)}) v${threshold !== undefined ? ` where sim >= ${p(threshold)}` : ""}`;
  else if (mode === "text") hits = textHits(k);
  else
    hits = `
      select id, coalesce(1.0 / (${RRF_K} + v.r), 0) + coalesce(1.0 / (${RRF_K} + x.r), 0) as score
      from (select id, row_number() over (order by sim desc) as r from (${vectorHits(cand)}) v0${threshold !== undefined ? ` where sim >= ${p(threshold)}` : ""}) v
      full join (select id, row_number() over (order by score desc) as r from (${textHits(cand)}) x0) x using (id)
      order by score desc limit ${k}`;
  let rows: Row[];
  try {
    rows = await (
      await msql(project)
    ).begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = '15s'; set local hnsw.iterative_scan = relaxed_order`);
      return tx.unsafe(
        `with h as (${hits}) select ${COLUMNS.split(", ")
          .map((c) => `m.${c}`)
          .join(", ")}, h.score::float8 as score from h join ${T} m using (id) order by h.score desc`,
        params,
      );
    });
  } catch (err) {
    userError(err);
  }
  log.info("memory search", { mode, matches: rows.length });
  return { results: rows.map((r): MemoryMatch => ({ ...toMemory(r), score: r.score ?? 0 })) };
}

// ---- reads and edits ------------------------------------------------------------------

export async function list(project: string, params: URLSearchParams): Promise<ListMemoriesResponse> {
  await settings(project);
  const scope = readScope(params, false);
  const raw = params.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestError("limit must be an integer from 1 to 200");
  const values: unknown[] = [];
  const p = (v: unknown) => (values.push(v), `$${values.length}`);
  let where = scopeWhere(scope, p);
  const after = params.get("after");
  if (after) {
    const [at, id] = after.split("|");
    if (!at || !id) throw new BadRequestError("after must be the next value from a previous page");
    where += ` and (created_at, id) < (${p(at)}::timestamptz, ${p(id)}::uuid)`;
  }
  const q = params.get("q");
  if (q) where += ` and content ilike ${p(`%${q.replace(/[%_\\]/g, "\\$&")}%`)}`;
  const rows: Row[] = await (await msql(project)).unsafe(`select ${COLUMNS} from ${T} where ${where} order by created_at desc, id desc limit ${limit + 1}`, values);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { memories: page.map(toMemory), next: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function get(project: string, id: string): Promise<Memory> {
  await settings(project);
  if (!isUuid(id)) throw new NotFoundError(`no memory "${id}"`);
  const [row]: Row[] = await (await msql(project)).unsafe(`select ${COLUMNS} from ${T} where id = $1::uuid`, [id]);
  if (!row) throw new NotFoundError(`no memory "${id}"`);
  return toMemory(row);
}

export async function update(project: string, id: string, body: Record<string, unknown>, log: Logger): Promise<Memory> {
  const current = await get(project, id);
  const db = await msql(project);
  const text = body.memory;
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > MEMORY_LIMITS.contentLength)) {
    throw new BadRequestError(`memory must be 1–${MEMORY_LIMITS.contentLength} characters`);
  }
  const metadata = body.metadata === undefined ? null : readMetadata(body.metadata);
  if (text === undefined && metadata === null) throw new BadRequestError("send memory and/or metadata");
  const vector = typeof text === "string" && text.trim() !== current.memory ? (await embed(project, [text.trim()], log))[0]! : null;
  await db.begin(async (tx) => {
    if (vector) {
      await tx.unsafe(`update ${T} set content = $2, hash = $3, embedding = $4::vector, updated_at = now() where id = $1::uuid`, [
        id,
        (text as string).trim(),
        hashOf(text as string),
        vectorLiteral(vector),
      ]);
      await tx.unsafe(`insert into ${H} (memory_id, event, old, new) values ($1::uuid, 'UPDATE', $2, $3)`, [id, current.memory, (text as string).trim()]);
    }
    if (metadata) await tx.unsafe(`update ${T} set metadata = $2::text::jsonb, updated_at = now() where id = $1::uuid`, [id, JSON.stringify(metadata)]);
  });
  log.info("memory updated", { text: vector !== null, metadata: metadata !== null });
  return get(project, id);
}

export async function remove(project: string, id: string, log: Logger) {
  const current = await get(project, id);
  await (
    await msql(project)
  ).begin(async (tx) => {
    await tx.unsafe(`delete from ${T} where id = $1::uuid`, [id]);
    await tx.unsafe(`insert into ${H} (memory_id, event, old) values ($1::uuid, 'DELETE', $2)`, [id, current.memory]);
  });
  log.info("memory deleted");
}

export async function removeAll(project: string, body: Record<string, unknown>, log: Logger): Promise<{ deleted: number }> {
  await settings(project);
  const scope = readScope(body, true);
  const values: unknown[] = [];
  const p = (v: unknown) => (values.push(v), `$${values.length}`);
  const conds = [scope.userId && `user_id = ${p(scope.userId)}`, scope.agentId && `agent_id = ${p(scope.agentId)}`, scope.runId && `run_id = ${p(scope.runId)}`]
    .filter(Boolean)
    .join(" and ");
  const deleted = await (
    await msql(project)
  ).begin(async (tx) => {
    const rows: { id: string; content: string }[] = await tx.unsafe(`delete from ${T} where ${conds} returning id::text, content`, values);
    if (rows.length) {
      await tx.unsafe(`insert into ${H} (memory_id, event, old) select (x->>'id')::uuid, 'DELETE', x->>'content' from jsonb_array_elements($1::text::jsonb) x`, [
        JSON.stringify(rows),
      ]);
    }
    return rows.length;
  });
  log.info("memories deleted", { deleted });
  return { deleted };
}

export async function history(project: string, id: string): Promise<MemoryHistoryEntry[]> {
  await settings(project);
  if (!isUuid(id)) throw new NotFoundError(`no memory "${id}"`);
  const rows: { id: string; memoryId: string; event: MemoryHistoryEntry["event"]; old: string | null; new: string | null; at: Date }[] = await (
    await msql(project)
  ).unsafe(`select id::text, memory_id::text as "memoryId", event, old, new, at from ${H} where memory_id = $1::uuid order by at, id`, [id]);
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

/** Users and agents with memories, for the dashboard. */
export async function scopes(project: string): Promise<MemoryScopeCount[]> {
  await settings(project);
  const rows: { userId: string | null; agentId: string | null; memories: number; lastAt: Date }[] = await (
    await msql(project)
  ).unsafe(`
    select user_id as "userId", agent_id as "agentId", count(*)::int as memories, max(updated_at) as "lastAt" from ${T}
    where expires_at is null or expires_at > now() group by 1, 2 order by 4 desc limit 500`);
  return rows.map((r) => ({ ...r, lastAt: r.lastAt.toISOString() }));
}

export async function memoryContext(project: string): Promise<NonNullable<ProjectContext["memory"]>> {
  const s = await settings(project);
  return { url: `${publicApiUrl}/memory/${project}`, llmModel: s.llmModel, embedModel: s.embedModel, dimensions: s.dims, memories: await countMemories(project) };
}

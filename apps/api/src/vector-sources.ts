// Vector sources: an index filled by the server from a storage prefix, a table in the project's
// database, or text an app pushes. Text is extracted (vector-extract.ts), chunked
// (vector-chunk.ts), and upserted in batches of 100 (vector.ts embeds with the project's
// provider or the AI gateway). Each chunk is a document `<item>#<n>` with metadata
// `{ source, item, chunk, … }`; when an item changes its old chunks go, when it disappears all do.
//
// Syncs are jobs in `mybase.vector_jobs`: claimed with `for update skip locked`, two at a time
// (Pi), retried after 10 s / 60 s / 5 min, put back in the queue at boot. A timer queues sources
// whose interval is up (0 = only on request). Document text is end-user data: never logged.
import {
  VECTOR_SOURCE_ID_PATTERN,
  type IngestResponse,
  type StorageSourceConfig,
  type TableSourceConfig,
  type VectorIndexSource,
  type VectorMetadata,
  type VectorSource,
  type VectorSourceKind,
} from "@mybase-dev/sdk/vector";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { bucketName } from "@mybase/shared";
import { createHash } from "node:crypto";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { asProject, quoteIdent } from "./project-db";
import { internalKey, file } from "./storage";
import { deleteStale, hasIndex, requireEnabled, upsertDocuments } from "./vector";
import { chunkId, chunkText } from "./vector-chunk";
import { DEFAULT_INCLUDE, extract, MAX_FILE_BYTES } from "./vector-extract";
import { globMatch } from "./ai-prices";

const log = createLogger("vector");

const BACKOFF_MS = [10_000, 60_000, 300_000];
const MAX_IN_FLIGHT = 2;
const TICK_MS = 15_000;
const SCHEDULE_MS = 60_000;
const BATCH = 100;
const FULL_EVERY_MS = 86_400_000;
const MAX_SOURCES_PER_INDEX = 20;
const MAX_ITEMS = 50_000;
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

// ---- reading input ------------------------------------------------------------

function intIn(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  return value as number;
}

function ident(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) throw new BadRequestError(`${field} must be a column or table name (letters, digits, _)`);
  return value;
}

function readConfig(kind: VectorSourceKind, raw: unknown): Record<string, unknown> {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c !== "object" || Array.isArray(c)) throw new BadRequestError("config must be an object");
  if (kind === "push") return {};
  if (kind === "storage") {
    const prefix = c.prefix ?? "";
    if (typeof prefix !== "string" || prefix.length > 500 || prefix.startsWith("/") || prefix.split("/").some((s) => s === "..")) {
      throw new BadRequestError("config.prefix must be a key prefix in the project's bucket, e.g. docs/");
    }
    const include = c.include ?? DEFAULT_INCLUDE;
    if (!Array.isArray(include) || include.length === 0 || include.length > 50 || include.some((g) => typeof g !== "string" || !g || g.length > 100)) {
      throw new BadRequestError("config.include must be a list of file name globs like *.md");
    }
    return { prefix, include } satisfies StorageSourceConfig;
  }
  const text = c.text;
  if (!Array.isArray(text) || text.length === 0 || text.length > 20) throw new BadRequestError("config.text must list 1–20 columns");
  const metadata = c.metadata ?? [];
  if (!Array.isArray(metadata) || metadata.length > 20) throw new BadRequestError("config.metadata must list up to 20 columns");
  const out: TableSourceConfig = {
    schema: c.schema === undefined ? "public" : ident(c.schema, "config.schema"),
    table: ident(c.table, "config.table"),
    id: ident(c.id, "config.id"),
    text: text.map((t, i) => ident(t, `config.text[${i}]`)),
    metadata: metadata.map((t, i) => ident(t, `config.metadata[${i}]`)),
  };
  if (c.title !== undefined && c.title !== null) out.title = ident(c.title, "config.title");
  if (c.updatedAt !== undefined && c.updatedAt !== null) out.updatedAt = ident(c.updatedAt, "config.updatedAt");
  return out as unknown as Record<string, unknown>;
}

// ---- rows ---------------------------------------------------------------------

interface SourceRow {
  project: string;
  index: string;
  id: string;
  kind: VectorSourceKind;
  config: Record<string, unknown>;
  chunkSize: number;
  chunkOverlap: number;
  intervalMin: number;
  status: VectorSource["status"];
  lastSyncAt: Date | null;
  lastFullAt: Date | null;
  lastError: string | null;
  cursor: { at: string; id: string } | null;
  items: number;
  chunks: number;
  source: VectorIndexSource;
  createdAt: Date;
}

const COLUMNS = sql`
  project, index, id, kind, config, chunk_size as "chunkSize", chunk_overlap as "chunkOverlap", interval_min as "intervalMin", status,
  last_sync_at as "lastSyncAt", last_full_at as "lastFullAt", last_error as "lastError", cursor, items, chunks, source, created_at as "createdAt"`;

const parseJson = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

const toSource = (r: SourceRow): VectorSource => ({
  id: r.id,
  index: r.index,
  kind: r.kind,
  config: parseJson(r.config),
  chunkSize: r.chunkSize,
  chunkOverlap: r.chunkOverlap,
  intervalMin: r.intervalMin,
  status: r.status,
  lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
  lastError: r.lastError,
  items: r.items,
  chunks: r.chunks,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

async function sourceRow(project: string, index: string, id: string): Promise<SourceRow> {
  const [row]: SourceRow[] = await sql`select ${COLUMNS} from mybase.vector_sources where project = ${project} and index = ${index} and id = ${id}`;
  if (!row) throw new NotFoundError(`no source "${id}" on index "${index}"`);
  return { ...row, config: parseJson(row.config), cursor: parseJson(row.cursor) };
}

async function requireIndex(project: string, index: string) {
  await requireEnabled(project);
  if (!(await hasIndex(project, index))) throw new NotFoundError(`no index named "${index}"`);
}

export async function listSources(project: string, index: string): Promise<VectorSource[]> {
  await requireIndex(project, index);
  const rows: SourceRow[] = await sql`select ${COLUMNS} from mybase.vector_sources where project = ${project} and index = ${index} order by id`;
  return rows.map(toSource);
}

interface SourceSpec {
  kind: VectorSourceKind;
  config: Record<string, unknown>;
  chunkSize: number;
  chunkOverlap: number;
  intervalMin: number;
}

function readSpec(body: Record<string, unknown>): SourceSpec {
  const kind = body.kind;
  if (kind !== "storage" && kind !== "table" && kind !== "push") throw new BadRequestError("kind must be storage, table, or push");
  const chunkSize = intIn(body.chunkSize, "chunkSize", 100, 8000, 1000);
  return {
    kind,
    config: readConfig(kind, body.config),
    chunkSize,
    chunkOverlap: intIn(body.chunkOverlap, "chunkOverlap", 0, Math.floor(chunkSize / 2), Math.min(150, Math.floor(chunkSize / 2))),
    intervalMin: kind === "push" ? 0 : intIn(body.intervalMin, "intervalMin", 0, 10_080, 15),
  };
}

function readSourceId(id: string): string {
  if (!VECTOR_SOURCE_ID_PATTERN.test(id) || id === "sync") throw new BadRequestError("source ids are 1–48 lowercase letters, digits, - or _, starting with a letter");
  return id;
}

async function writeSource(project: string, index: string, id: string, spec: SourceSpec, source: VectorIndexSource) {
  await sql`
    insert into mybase.vector_sources (project, index, id, kind, config, chunk_size, chunk_overlap, interval_min, source)
    values (${project}, ${index}, ${id}, ${spec.kind}, ${JSON.stringify(spec.config)}::text::jsonb, ${spec.chunkSize}, ${spec.chunkOverlap}, ${spec.intervalMin}, ${source})
    on conflict (project, index, id) do update set kind = excluded.kind, config = excluded.config, chunk_size = excluded.chunk_size,
      chunk_overlap = excluded.chunk_overlap, interval_min = excluded.interval_min, cursor = null, last_full_at = null`;
}

/** Creates or replaces a source; storage and table sources sync right away. */
export async function putSource(project: string, index: string, id: string, body: Record<string, unknown>, source: VectorIndexSource, log: Logger): Promise<VectorSource> {
  await requireIndex(project, index);
  readSourceId(id);
  const spec = readSpec(body);
  const existing = (await sql`select source from mybase.vector_sources where project = ${project} and index = ${index} and id = ${id}`) as { source: string }[];
  if (existing[0]?.source === "code" && source !== "code") throw new ConflictError(`source "${id}" is managed in code. Edit it in mybase.config.ts and run \`mybase vector sync\``);
  if (!existing.length) {
    const [{ count }]: { count: number }[] = await sql`select count(*)::int as count from mybase.vector_sources where project = ${project} and index = ${index}`;
    if (count >= MAX_SOURCES_PER_INDEX) throw new ConflictError(`an index can have at most ${MAX_SOURCES_PER_INDEX} sources`);
  }
  if (spec.kind === "table") await checkTable(project, spec.config as unknown as TableSourceConfig);
  await writeSource(project, index, id, spec, source);
  if (spec.kind !== "push") await enqueue(project, index, id, true);
  log.info("vector source saved", { index, source: id, kind: spec.kind });
  return toSource(await sourceRow(project, index, id));
}

/** Removes a source and every chunk it made. */
export async function deleteSource(project: string, index: string, id: string, log: Logger, opts: { code?: boolean } = {}) {
  const row = await sourceRow(project, index, id);
  if (row.source === "code" && !opts.code) throw new ConflictError(`source "${id}" is managed in code. Remove it from mybase.config.ts and run \`mybase vector sync\``);
  const removed = await deleteStale(project, index, { source: id }, []).catch(() => 0);
  await sql`delete from mybase.vector_sources where project = ${project} and index = ${index} and id = ${id}`;
  log.info("vector source deleted", { index, source: id, chunks: removed });
}

/** Makes the code-defined sources of `index` match `input` (`mybase vector sync`). */
export async function syncSources(project: string, index: string, input: unknown, dryRun: boolean, log: Logger) {
  await requireIndex(project, index);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BadRequestError("sources must map ids to source settings");
  const wanted = new Map<string, SourceSpec>();
  for (const [id, spec] of Object.entries(input)) wanted.set(readSourceId(id), readSpec(spec as Record<string, unknown>));
  const rows: SourceRow[] = await sql`select ${COLUMNS} from mybase.vector_sources where project = ${project} and index = ${index}`;
  const result = { created: [] as string[], updated: [] as string[], deleted: [] as string[], unchanged: [] as string[] };
  for (const [id, spec] of wanted) {
    const row = rows.find((r) => r.id === id);
    if (row && row.source !== "code") throw new ConflictError(`source "${id}" already exists outside mybase.config.ts. Delete it first`);
    if (!row) result.created.push(id);
    else if (
      row.kind === spec.kind &&
      JSON.stringify(parseJson(row.config)) === JSON.stringify(spec.config) &&
      row.chunkSize === spec.chunkSize &&
      row.chunkOverlap === spec.chunkOverlap &&
      row.intervalMin === spec.intervalMin
    ) {
      result.unchanged.push(id);
    } else result.updated.push(id);
  }
  for (const r of rows) if (r.source === "code" && !wanted.has(r.id)) result.deleted.push(r.id);
  if (dryRun) return result;
  for (const id of result.deleted) await deleteSource(project, index, id, log, { code: true });
  for (const id of [...result.created, ...result.updated]) {
    const spec = wanted.get(id)!;
    if (spec.kind === "table") await checkTable(project, spec.config as unknown as TableSourceConfig);
    await writeSource(project, index, id, spec, "code");
    if (spec.kind !== "push") await enqueue(project, index, id, true);
  }
  log.info("vector sources synced", { index, created: result.created.length, updated: result.updated.length, deleted: result.deleted.length });
  return result;
}

// ---- push ---------------------------------------------------------------------

/** `POST …/ingest`: one document (`{ id, text, … }`) or up to 100 (`{ documents }`), chunked and embedded. */
export async function ingest(project: string, index: string, body: Record<string, unknown>, log: Logger): Promise<IngestResponse> {
  await requireIndex(project, index);
  const docs = Array.isArray(body.documents) ? body.documents : [body];
  if (docs.length === 0 || docs.length > BATCH) throw new BadRequestError(`send 1–${BATCH} documents`);
  const size = intIn(body.chunkSize, "chunkSize", 100, 8000, 1000);
  const overlap = intIn(body.chunkOverlap, "chunkOverlap", 0, Math.floor(size / 2), Math.min(150, Math.floor(size / 2)));
  let chunks = 0;
  let removed = 0;
  for (const [i, raw] of docs.entries()) {
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id || d.id.length > 200 || d.id.includes("#")) throw new BadRequestError(`documents[${i}].id must be 1–200 characters without #`);
    if (typeof d.text !== "string") throw new BadRequestError(`documents[${i}].text must be a string`);
    if (d.text.length > 2_000_000) throw new BadRequestError(`documents[${i}].text is over 2,000,000 characters`);
    if (d.title !== undefined && d.title !== null && typeof d.title !== "string") throw new BadRequestError(`documents[${i}].title must be a string`);
    const meta = d.metadata ?? {};
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new BadRequestError(`documents[${i}].metadata must be an object`);
    const r = await writeItem(project, index, "push", d.id, (d.title as string | null) ?? null, d.text, meta as VectorMetadata, size, overlap, log);
    chunks += r.chunks;
    removed += r.removed;
  }
  log.info("vector documents ingested", { index, documents: docs.length, chunks });
  return { documents: docs.length, chunks, removed };
}

// ---- one item -------------------------------------------------------------------

/** Chunks and upserts one item's text, then removes its chunks from before. */
async function writeItem(
  project: string,
  index: string,
  source: string,
  item: string,
  title: string | null,
  text: string,
  metadata: VectorMetadata,
  size: number,
  overlap: number,
  log: Logger,
): Promise<{ chunks: number; removed: number }> {
  const pieces = chunkText(text, { size, overlap });
  const ids: string[] = [];
  for (let i = 0; i < pieces.length; i += BATCH) {
    const documents = pieces.slice(i, i + BATCH).map((t, j) => {
      const id = chunkId(item, i + j);
      ids.push(id);
      return { id, title, text: t, metadata: { ...metadata, source, item, chunk: i + j } };
    });
    await upsertDocuments(project, index, { documents }, log);
  }
  const removed = await deleteStale(project, index, { source, item }, ids);
  return { chunks: pieces.length, removed };
}

// ---- sync jobs ------------------------------------------------------------------

async function enqueue(project: string, index: string, id: string, full: boolean) {
  await sql`
    insert into mybase.vector_jobs (project, index, source_id, full_sync) values (${project}, ${index}, ${id}, ${full})
    on conflict (project, index, source_id) where status = 'queued' do update set full_sync = vector_jobs.full_sync or excluded.full_sync, run_at = least(vector_jobs.run_at, now())`;
  await sql`update mybase.vector_sources set status = 'queued' where project = ${project} and index = ${index} and id = ${id} and status <> 'syncing'`;
  kick();
}

/** `POST …/sources/:id/sync`: apps call it after uploading files. `full` also finds deleted rows. */
export async function requestSync(project: string, index: string, id: string, full: boolean, log: Logger): Promise<VectorSource> {
  await requireIndex(project, index);
  const row = await sourceRow(project, index, id);
  if (row.kind === "push") throw new BadRequestError("push sources have nothing to sync: POST documents to …/ingest");
  await enqueue(project, index, id, full);
  log.info("vector source sync requested", { index, source: id, full });
  return toSource(await sourceRow(project, index, id));
}

interface Job {
  id: string;
  project: string;
  index: string;
  sourceId: string;
  full: boolean;
  attempts: number;
}

let running = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let kicking = false;

function kick() {
  if (stopped || kicking) return;
  kicking = true;
  queueMicrotask(() => {
    kicking = false;
    void tick();
  });
}

async function claim(): Promise<Job | null> {
  const [job]: Job[] = await sql`
    update mybase.vector_jobs set status = 'running', attempts = attempts + 1
    where id = (select id from mybase.vector_jobs where status = 'queued' and run_at <= now() order by run_at for update skip locked limit 1)
    returning id::text, project, index, source_id as "sourceId", full_sync as full, attempts`;
  return job ?? null;
}

async function tick() {
  while (!stopped && running < MAX_IN_FLIGHT) {
    let job: Job | null;
    try {
      job = await claim();
    } catch (err) {
      log.warn("vector job claim failed", { err });
      return;
    }
    if (!job) return;
    running++;
    void run(job).finally(() => {
      running--;
      kick();
    });
  }
}

async function run(job: Job) {
  const jlog = log.child({ project: job.project, index: job.index, source: job.sourceId });
  await sql`update mybase.vector_sources set status = 'syncing' where project = ${job.project} and index = ${job.index} and id = ${job.sourceId}`;
  try {
    const row = await sourceRow(job.project, job.index, job.sourceId);
    const stats = row.kind === "storage" ? await syncStorage(row, jlog) : await syncTable(row, job.full, jlog);
    await sql.begin(async (tx) => {
      await tx`delete from mybase.vector_jobs where id = ${job.id}::bigint`;
      await tx`
        update mybase.vector_sources set status = case when exists (select 1 from mybase.vector_jobs where project = ${job.project} and index = ${job.index} and source_id = ${job.sourceId} and status = 'queued') then 'queued' else 'idle' end,
          last_sync_at = now(), last_error = null, items = ${stats.items}, chunks = ${stats.chunks},
          cursor = ${stats.cursor ? JSON.stringify(stats.cursor) : null}::text::jsonb,
          last_full_at = case when ${stats.full} then now() else last_full_at end
        where project = ${job.project} and index = ${job.index} and id = ${job.sourceId}`;
    });
    jlog.info("vector source synced", { items: stats.items, chunks: stats.chunks, changed: stats.changed, removed: stats.removed });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "sync failed";
    const retry = job.attempts <= BACKOFF_MS.length && !(err instanceof NotFoundError);
    jlog.warn("vector source sync failed", { attempt: job.attempts, retry, err });
    try {
      if (retry)
        await sql`update mybase.vector_jobs set status = 'queued', run_at = now() + ${BACKOFF_MS[job.attempts - 1]! / 1000} * interval '1 second' where id = ${job.id}::bigint`.catch(
          async () => {
            // A newer queued job for the same source already exists.
            await sql`delete from mybase.vector_jobs where id = ${job.id}::bigint`;
          },
        );
      else await sql`delete from mybase.vector_jobs where id = ${job.id}::bigint`;
      await sql`update mybase.vector_sources set status = ${retry ? "queued" : "error"}, last_error = ${message} where project = ${job.project} and index = ${job.index} and id = ${job.sourceId}`;
    } catch {
      // the source is gone
    }
  }
}

interface SyncStats {
  items: number;
  chunks: number;
  changed: number;
  removed: number;
  full: boolean;
  cursor: { at: string; id: string } | null;
}

async function storedItems(row: SourceRow): Promise<Map<string, { hash: string; chunks: number }>> {
  const items: { key: string; hash: string; chunks: number }[] = await sql`
    select item_key as key, hash, chunks from mybase.vector_source_items where project = ${row.project} and index = ${row.index} and source_id = ${row.id}`;
  return new Map(items.map((i) => [i.key, i]));
}

async function saveItem(row: SourceRow, key: string, hash: string, chunks: number) {
  await sql`
    insert into mybase.vector_source_items (project, index, source_id, item_key, hash, chunks) values (${row.project}, ${row.index}, ${row.id}, ${key}, ${hash}, ${chunks})
    on conflict (project, index, source_id, item_key) do update set hash = excluded.hash, chunks = excluded.chunks, synced_at = now()`;
}

async function dropItem(row: SourceRow, key: string): Promise<number> {
  const removed = await deleteStale(row.project, row.index, { source: row.id, item: key }, []);
  await sql`delete from mybase.vector_source_items where project = ${row.project} and index = ${row.index} and source_id = ${row.id} and item_key = ${key}`;
  return removed;
}

/** Every object under the prefix; changed ones (etag) re-read, missing ones dropped. */
async function syncStorage(row: SourceRow, jlog: Logger): Promise<SyncStats> {
  const config = row.config as unknown as StorageSourceConfig;
  const include = config.include ?? DEFAULT_INCLUDE;
  const { client } = internalKey();
  const bucket = bucketName(row.project);
  const seen = new Map<string, { etag: string; size: number }>();
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix: config.prefix, continuationToken, maxKeys: 1000 }, { bucket });
    for (const obj of page.contents ?? []) {
      const name = obj.key.split("/").pop() ?? obj.key;
      if (obj.key.endsWith("/") || !include.some((g) => globMatch(g, name) || globMatch(g, obj.key))) continue;
      seen.set(obj.key, { etag: `${obj.eTag ?? ""}:${obj.size ?? 0}`, size: obj.size ?? 0 });
      if (seen.size > MAX_ITEMS) throw new BadRequestError(`more than ${MAX_ITEMS} files under "${config.prefix}"`);
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);

  const known = await storedItems(row);
  let changed = 0;
  let removed = 0;
  let chunks = 0;
  for (const [key, obj] of seen) {
    const prev = known.get(key);
    if (prev?.hash === obj.etag) {
      chunks += prev.chunks;
      continue;
    }
    if (obj.size > MAX_FILE_BYTES) {
      jlog.warn("vector source file skipped", { reason: "too big", size: obj.size });
      continue;
    }
    const handle = file(row.project, key);
    const bytes = new Uint8Array(await handle.arrayBuffer());
    const out = await extract(key, bytes, handle.type);
    if ("skipped" in out) {
      await saveItem(row, key, obj.etag, 0);
      continue;
    }
    const r = await writeItem(row.project, row.index, row.id, key, out.title, out.text, { key }, row.chunkSize, row.chunkOverlap, jlog);
    await saveItem(row, key, obj.etag, r.chunks);
    chunks += r.chunks;
    changed++;
  }
  for (const key of known.keys()) {
    if (!seen.has(key)) removed += await dropItem(row, key);
  }
  return { items: seen.size, chunks, changed, removed, full: true, cursor: null };
}

/** Throws unless the project role can read the table and its columns. */
async function checkTable(project: string, c: TableSourceConfig) {
  const cols = [c.id, c.title, c.updatedAt, ...c.text, ...(c.metadata ?? [])].filter((x): x is string => Boolean(x));
  try {
    await asProject(project, (tx) => tx.unsafe(`select ${cols.map(quoteIdent).join(", ")} from ${quoteIdent(c.schema ?? "public")}.${quoteIdent(c.table)} limit 0`));
  } catch (err) {
    throw new BadRequestError(`can't read ${c.schema ?? "public"}.${c.table} as the project: ${(err as Error).message}`);
  }
}

type TableRow = Record<string, unknown> & { __id: string; __at?: Date | string | null };

/** Changed rows (keyset on `updatedAt, id` when set, else all), with a full id diff once a day or when asked. */
async function syncTable(row: SourceRow, fullRequested: boolean, jlog: Logger): Promise<SyncStats> {
  const c = row.config as unknown as TableSourceConfig;
  const t = `${quoteIdent(c.schema ?? "public")}.${quoteIdent(c.table)}`;
  const full = fullRequested || !c.updatedAt || !row.lastFullAt || Date.now() - row.lastFullAt.getTime() > FULL_EVERY_MS;
  const select = [
    `${quoteIdent(c.id)}::text as __id`,
    ...(c.updatedAt ? [`${quoteIdent(c.updatedAt)} as __at`] : []),
    ...(c.title ? [`${quoteIdent(c.title)}::text as __title`] : []),
    ...c.text.map((col, i) => `${quoteIdent(col)}::text as __t${i}`),
    ...(c.metadata ?? []).map((col) => `${quoteIdent(col)} as ${quoteIdent(`m_${col}`)}`),
  ].join(", ");
  const known = await storedItems(row);
  const seen = new Set<string>();
  let cursor = full ? null : row.cursor;
  let changed = 0;
  for (;;) {
    const order = c.updatedAt ? `${quoteIdent(c.updatedAt)}, ${quoteIdent(c.id)}::text` : `${quoteIdent(c.id)}::text`;
    const where =
      cursor && c.updatedAt
        ? `where (${quoteIdent(c.updatedAt)}, ${quoteIdent(c.id)}::text) > ($1::timestamptz, $2::text)`
        : cursor
          ? `where ${quoteIdent(c.id)}::text > $2::text`
          : "";
    const params = cursor ? [cursor.at, cursor.id] : [];
    const rows = (await asProject(row.project, (tx) => tx.unsafe(`select ${select} from ${t} ${where} order by ${order} limit ${BATCH}`, params))) as TableRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      seen.add(r.__id);
      const text = c.text
        .map((_, i) => r[`__t${i}`])
        .filter((v) => v !== null && v !== undefined && v !== "")
        .join("\n\n");
      const metadata: VectorMetadata = { [c.id]: r.__id };
      for (const col of c.metadata ?? []) metadata[col] = r[`m_${col}`] ?? null;
      const title = (r.__title as string | null | undefined) ?? null;
      const hash = createHash("sha256")
        .update(JSON.stringify([title, text, metadata]))
        .digest("hex")
        .slice(0, 32);
      if (known.get(r.__id)?.hash === hash) continue;
      const out = await writeItem(row.project, row.index, row.id, r.__id, title, text, metadata, row.chunkSize, row.chunkOverlap, jlog);
      await saveItem(row, r.__id, hash, out.chunks);
      changed++;
    }
    const last = rows.at(-1)!;
    const at = last.__at instanceof Date ? last.__at.toISOString() : last.__at ? String(last.__at) : new Date(0).toISOString();
    cursor = { at, id: last.__id };
    if (rows.length < BATCH) break;
  }
  let removed = 0;
  if (full) for (const key of known.keys()) if (!seen.has(key)) removed += await dropItem(row, key);
  const [totals]: { items: number; chunks: number }[] = await sql`
    select count(*)::int as items, coalesce(sum(chunks), 0)::int as chunks from mybase.vector_source_items
    where project = ${row.project} and index = ${row.index} and source_id = ${row.id}`;
  return { items: totals!.items, chunks: totals!.chunks, changed, removed, full, cursor: c.updatedAt ? cursor : null };
}

// ---- lifecycle ----------------------------------------------------------------------

/** Queues sources whose interval is up. */
async function schedule() {
  try {
    await sql`
      insert into mybase.vector_jobs (project, index, source_id, full_sync)
      select s.project, s.index, s.id, s.kind = 'table' and (s.last_full_at is null or s.last_full_at < now() - interval '1 day')
      from mybase.vector_sources s
      where s.kind <> 'push' and s.interval_min > 0 and s.status in ('idle','error')
        and (s.last_sync_at is null or s.last_sync_at < now() - make_interval(mins => s.interval_min))
      on conflict (project, index, source_id) where status = 'queued' do nothing`;
    kick();
  } catch (err) {
    log.warn("vector source schedule failed", { err });
  }
}

export function startVectorSources() {
  stopped = false;
  // Jobs a crash left running go back in the queue.
  void sql`update mybase.vector_jobs set status = 'queued' where status = 'running'`
    .then(() => sql`update mybase.vector_sources set status = 'queued' where status = 'syncing'`)
    .then(() => schedule())
    .catch((err) => log.warn("vector sources start failed", { err }));
  tickTimer ??= setInterval(() => void tick(), TICK_MS);
  scheduleTimer ??= setInterval(() => void schedule(), SCHEDULE_MS);
  tickTimer.unref?.();
  scheduleTimer.unref?.();
}

export function stopVectorSources() {
  stopped = true;
  if (tickTimer) clearInterval(tickTimer);
  if (scheduleTimer) clearInterval(scheduleTimer);
  tickTimer = scheduleTimer = null;
}

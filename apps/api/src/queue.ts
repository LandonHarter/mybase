// The queue service: SQS-style message queues in Postgres. Standard queues deliver at least
// once in roughly send order; FIFO queues deliver each message group strictly in order, one
// batch at a time, and drop repeated sends (deduplication ids, 5-minute window).
//
// A message is a row in `mybase.queue_messages`. Receiving one sets a fresh `receipt` and
// pushes `visible_at` out by the visibility timeout; deleting needs that receipt. When the
// timeout runs out the message is visible again and its old receipt still works until the
// next receive. Messages received `max_receives` times move to the dead-letter queue, if set.
//
// Long polls wait in memory, woken by sends to the queue (this process is the only API
// instance), or by a timer set for the next message to become visible. An idle queue costs
// no queries. Stats are counted in memory and written every 5 minutes (SD card).
import {
  QUEUE_STATS_RANGES,
  type BatchFailure,
  type BatchResult,
  type DeadLetterSettings,
  type Queue,
  type QueueAttributes,
  type QueueMessage,
  type QueueMessageRecord,
  type QueueServiceSettings,
  type QueueSettings,
  type QueueSource,
  type QueueStats,
  type QueueStatsRange,
  type QueueStatsSeries,
  type RedriveResponse,
  type SendMessagesResponse,
  type SentMessage,
  type SyncQueuesResponse,
} from "@mybase/shared";
import { parseDelay } from "@mybase/sdk/cron";
import { QUEUE_LIMITS, QUEUE_NAME_PATTERN, QUEUE_NAME_RULES } from "@mybase/sdk/queue";
import { createLogger, type Logger } from "@mybase/shared/logger";
import type { TransactionSQL } from "bun";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";

const log = createLogger("queue");

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const STATS_FLUSH_MS = 5 * 60_000;
const PEEK_BODY_CHARS = 4096;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;
const GROUP_ID_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${QUEUE_LIMITS.idLength}}$`);
const RECEIPT_PATTERN = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- rows and caches --------------------------------------------------------

interface QueueRow {
  id: string;
  name: string;
  fifo: boolean;
  visibilityTimeoutMs: number;
  delayMs: number;
  retentionMs: number;
  maxMessageBytes: number;
  receiveWaitMs: number;
  contentDedup: boolean;
  deadLetterId: string | null;
  maxReceives: number | null;
  source: QueueSource;
  createdAt: Date;
  updatedAt: Date;
}

/** Projects known to have the service on, so app calls skip a Postgres query. */
const enabled = new Set<string>();
/** Queues by project, then name. */
const queueCache = new Map<string, Map<string, QueueRow>>();

function forget(project: string) {
  enabled.delete(project);
  queueCache.delete(project);
}

async function queueRows(project: string): Promise<Map<string, QueueRow>> {
  let rows = queueCache.get(project);
  if (!rows) {
    const list: QueueRow[] = await sql`
      select id, name, fifo, visibility_timeout_ms as "visibilityTimeoutMs", delay_ms as "delayMs", retention_ms::int as "retentionMs",
        max_message_bytes as "maxMessageBytes", receive_wait_ms as "receiveWaitMs", content_dedup as "contentDedup",
        dead_letter_id as "deadLetterId", max_receives as "maxReceives", source, created_at as "createdAt", updated_at as "updatedAt"
      from mybase.queues where project = ${project} order by name`;
    rows = new Map(list.map((r) => [r.name, r]));
    queueCache.set(project, rows);
  }
  return rows;
}

async function queueRow(project: string, name: string): Promise<QueueRow> {
  const row = (await queueRows(project)).get(name);
  if (!row) throw new NotFoundError(`no queue named "${name}"`);
  return row;
}

async function queueById(project: string, id: string | null): Promise<QueueRow | undefined> {
  if (!id) return undefined;
  for (const row of (await queueRows(project)).values()) if (row.id === id) return row;
  return undefined;
}

// ---- waiting receives -------------------------------------------------------

const waiters = new Map<string, Set<() => void>>();

/** Wakes long polls on a queue: a message may be ready. */
function notify(queueId: string) {
  const set = waiters.get(queueId);
  if (!set) return;
  waiters.delete(queueId);
  for (const wake of set) wake();
}

function waitFor(queueId: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    let set = waiters.get(queueId);
    if (!set) waiters.set(queueId, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      waiters.get(queueId)?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    set.add(done);
  });
}

// ---- stats ------------------------------------------------------------------

type Counter = { sent: number; received: number; deleted: number; dead: number };
/** Unwritten counts, by `<queue id> <hour ISO>`. */
let pendingStats = new Map<string, Counter>();

function count(queueId: string, field: keyof Counter, n: number) {
  if (n <= 0) return;
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const key = `${queueId} ${hour}`;
  const counter = pendingStats.get(key) ?? { sent: 0, received: 0, deleted: 0, dead: 0 };
  counter[field] += n;
  pendingStats.set(key, counter);
}

async function insertStats(rows: { queue_id: string; hour: Date; sent: number; received: number; deleted: number; dead: number }[]) {
  await sql`
    insert into mybase.queue_stats ${sql(rows)}
    on conflict (queue_id, hour) do update set
      sent = queue_stats.sent + excluded.sent, received = queue_stats.received + excluded.received,
      deleted = queue_stats.deleted + excluded.deleted, dead = queue_stats.dead + excluded.dead`;
}

/** Writes counted stats. Called on a timer, before stats reads, and on shutdown. */
export async function flushQueueStats() {
  if (pendingStats.size === 0) return;
  const rows = [...pendingStats].map(([key, c]) => {
    const [queueId, hour] = key.split(" ");
    return { queue_id: queueId!, hour: new Date(hour!), ...c };
  });
  pendingStats = new Map();
  try {
    try {
      await insertStats(rows);
    } catch (err) {
      // A queue was deleted since its counts were taken.
      if ((err as { errno?: string }).errno !== "23503") throw err;
      const live: { id: string }[] = await sql`select id from mybase.queues where id in ${sql([...new Set(rows.map((r) => r.queue_id))])}`;
      const keep = new Set(live.map((r) => r.id));
      const remaining = rows.filter((r) => keep.has(r.queue_id));
      if (remaining.length > 0) await insertStats(remaining);
    }
  } catch (err) {
    // Dropped rather than retried: stats are approximate, and memory must stay bounded.
    log.error("queue stats not written", { rows: rows.length, err });
  }
}

// ---- service ----------------------------------------------------------------

export const queueService: ServiceModule = {
  id: "queue",
  async enable(project, log) {
    await sql`insert into mybase.queue_projects (project) values (${project}) on conflict do nothing`;
    log.info("queues enabled");
  },
  async disable(project, log) {
    const ids = [...(await queueRows(project)).values()].map((q) => q.id);
    // Cascades to queues, messages, dedup ids, and stats.
    await sql`delete from mybase.queue_projects where project = ${project}`;
    forget(project);
    for (const key of pendingStats.keys()) if (ids.includes(key.split(" ")[0]!)) pendingStats.delete(key);
    for (const id of ids) notify(id);
    log.info("queues disabled", { queues: ids.length });
  },
};

export async function requireEnabled(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.queue_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("queues are not enabled for this project");
  enabled.add(project);
}

export async function getSettings(project: string): Promise<QueueServiceSettings> {
  const [row]: { createdAt: Date }[] = await sql`
    select created_at as "createdAt" from mybase.queue_projects where project = ${project}`;
  if (!row) throw new NotFoundError("queues are not enabled for this project");
  return {
    apiUrl: publicApiUrl,
    baseUrl: `${publicApiUrl}/queue/${project}/queues`,
    enabledAt: row.createdAt.toISOString(),
  };
}

// ---- validation -------------------------------------------------------------

/** 30000 → `30s`, 1209600000 → `14d`. */
function human(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function queueName(value: unknown): string {
  if (typeof value !== "string" || !QUEUE_NAME_PATTERN.test(value)) {
    throw new BadRequestError(`invalid queue name "${String(value ?? "")}". ${QUEUE_NAME_RULES}`);
  }
  return value;
}

/** `field` as ms or a duration string, or `<field>Ms` as ms. Undefined when neither is set. */
function duration(body: Record<string, unknown>, field: string, { min, max }: { min: number; max: number }): number | undefined {
  const raw = body[field] !== undefined ? body[field] : body[`${field}Ms`];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") throw new BadRequestError(`${field} must be ms or a duration like "30s"`);
  let ms: number;
  try {
    ms = parseDelay(raw);
  } catch (err) {
    throw new BadRequestError(`${field}: ${(err as Error).message}`);
  }
  if (ms < min || ms > max) throw new BadRequestError(`${field} must be from ${human(min) === "0ms" ? "0" : human(min)} to ${human(max)}`);
  return ms;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new BadRequestError(`${field} must be true or false`);
  return value;
}

function deadLetter(value: unknown): DeadLetterSettings | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("deadLetter must be { queue, maxReceives } or null");
  const { queue, maxReceives } = value as Record<string, unknown>;
  const { min, max } = QUEUE_LIMITS.maxReceives;
  return { queue: queueName(queue), maxReceives: intIn(maxReceives, "deadLetter.maxReceives", min, max) };
}

/** Settings from a body over `base`. Absent fields keep `base`'s value (or the default). */
function readSpec(body: Record<string, unknown>, base: QueueSettings | null): QueueSettings {
  const L = QUEUE_LIMITS;
  const fifo = body.fifo === undefined ? (base?.fifo ?? false) : bool(body.fifo, "fifo");
  if (base && fifo !== base.fifo) throw new ConflictError("a queue can't switch between standard and FIFO. Create a new queue instead");
  const contentDedup = body.contentDedup === undefined ? (base?.contentDedup ?? false) : bool(body.contentDedup, "contentDedup");
  if (contentDedup && !fifo) throw new BadRequestError("contentDedup is for FIFO queues");
  const maxMessageBytes =
    body.maxMessageBytes === undefined
      ? (base?.maxMessageBytes ?? L.maxMessageBytes.default)
      : intIn(body.maxMessageBytes, "maxMessageBytes", L.maxMessageBytes.min, L.maxMessageBytes.max);
  return {
    fifo,
    visibilityTimeoutMs: duration(body, "visibilityTimeout", L.visibilityTimeoutMs) ?? base?.visibilityTimeoutMs ?? L.visibilityTimeoutMs.default,
    delayMs: duration(body, "delay", L.delayMs) ?? base?.delayMs ?? L.delayMs.default,
    retentionMs: duration(body, "retention", L.retentionMs) ?? base?.retentionMs ?? L.retentionMs.default,
    receiveWaitMs: duration(body, "receiveWait", L.waitMs) ?? base?.receiveWaitMs ?? L.waitMs.default,
    maxMessageBytes,
    contentDedup,
    deadLetter: body.deadLetter === undefined ? (base?.deadLetter ?? null) : deadLetter(body.deadLetter),
  };
}

const sameSpec = (a: QueueSettings, b: QueueSettings) =>
  a.fifo === b.fifo &&
  a.visibilityTimeoutMs === b.visibilityTimeoutMs &&
  a.delayMs === b.delayMs &&
  a.retentionMs === b.retentionMs &&
  a.receiveWaitMs === b.receiveWaitMs &&
  a.maxMessageBytes === b.maxMessageBytes &&
  a.contentDedup === b.contentDedup &&
  a.deadLetter?.queue === b.deadLetter?.queue &&
  a.deadLetter?.maxReceives === b.deadLetter?.maxReceives;

/** A row's settings, with its dead-letter queue by name. */
function rowSpec(row: QueueRow, rows: Map<string, QueueRow>): QueueSettings {
  const dlq = row.deadLetterId ? [...rows.values()].find((r) => r.id === row.deadLetterId) : undefined;
  return {
    fifo: row.fifo,
    visibilityTimeoutMs: row.visibilityTimeoutMs,
    delayMs: row.delayMs,
    retentionMs: row.retentionMs,
    receiveWaitMs: row.receiveWaitMs,
    maxMessageBytes: row.maxMessageBytes,
    contentDedup: row.contentDedup,
    deadLetter: dlq && row.maxReceives ? { queue: dlq.name, maxReceives: row.maxReceives } : null,
  };
}

/** The dead-letter target must exist (in `fifoByName`), be the same kind, and not be the queue itself. */
function checkDeadLetter(name: string, spec: QueueSettings, fifoByName: Map<string, boolean>) {
  if (!spec.deadLetter) return;
  const target = spec.deadLetter.queue;
  if (target === name) throw new BadRequestError("a queue can't be its own dead-letter queue");
  const fifo = fifoByName.get(target);
  if (fifo === undefined) throw new BadRequestError(`dead-letter queue "${target}" doesn't exist`);
  if (fifo !== spec.fifo) throw new BadRequestError(`dead-letter queue "${target}" must be ${spec.fifo ? "a FIFO" : "a standard"} queue too`);
}

// ---- queues -----------------------------------------------------------------

interface CountRow {
  queueId: string;
  visible: number;
  inFlight: number;
  delayed: number;
  oldest: Date | null;
}

async function countsFor(ids: string[]): Promise<Map<string, CountRow>> {
  if (ids.length === 0) return new Map();
  const rows: CountRow[] = await sql`
    select queue_id as "queueId",
      count(*) filter (where visible_at <= now())::int as visible,
      count(*) filter (where visible_at > now() and receipt is not null)::int as "inFlight",
      count(*) filter (where visible_at > now() and receipt is null)::int as delayed,
      min(sent_at) as oldest
    from mybase.queue_messages where queue_id in ${sql(ids)} and expires_at > now()
    group by queue_id`;
  return new Map(rows.map((r) => [r.queueId, r]));
}

function toQueue(row: QueueRow, rows: Map<string, QueueRow>, counts: Map<string, CountRow>): Queue {
  const c = counts.get(row.id);
  return {
    name: row.name,
    ...rowSpec(row, rows),
    source: row.source,
    counts: { visible: c?.visible ?? 0, inFlight: c?.inFlight ?? 0, delayed: c?.delayed ?? 0 },
    oldestMessageAt: c?.oldest?.toISOString() ?? null,
    deadLetterFor: [...rows.values()].filter((r) => r.deadLetterId === row.id && r.maxReceives).map((r) => r.name),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listQueues(project: string): Promise<Queue[]> {
  await requireEnabled(project);
  const rows = await queueRows(project);
  const counts = await countsFor([...rows.values()].map((r) => r.id));
  return [...rows.values()].map((r) => toQueue(r, rows, counts));
}

export async function getQueue(project: string, name: string): Promise<Queue> {
  await requireEnabled(project);
  const rows = await queueRows(project);
  const row = await queueRow(project, name);
  return toQueue(row, rows, await countsFor([row.id]));
}

const isUniqueViolation = (err: unknown) => (err as { errno?: string }).errno === "23505";

/** Settings columns, with the dead-letter queue looked up by name. */
async function writeSettings(tx: TransactionSQL | typeof sql, project: string, id: string, spec: QueueSettings) {
  await tx`
    update mybase.queues set
      visibility_timeout_ms = ${spec.visibilityTimeoutMs}, delay_ms = ${spec.delayMs}, retention_ms = ${spec.retentionMs},
      max_message_bytes = ${spec.maxMessageBytes}, receive_wait_ms = ${spec.receiveWaitMs}, content_dedup = ${spec.contentDedup},
      dead_letter_id = (select id from mybase.queues where project = ${project} and name = ${spec.deadLetter?.queue ?? null}),
      max_receives = ${spec.deadLetter?.maxReceives ?? null}, updated_at = now()
    where id = ${id}`;
}

/**
 * Creates a queue. Creating one that already exists with the same settings returns it
 * (`created: false`), so apps can create their queues at startup.
 */
export async function createQueue(project: string, body: Record<string, unknown>, source: QueueSource, log: Logger): Promise<{ queue: Queue; created: boolean }> {
  await requireEnabled(project);
  const name = queueName(body.name);
  const spec = readSpec(body, null);
  const rows = await queueRows(project);
  const existing = rows.get(name);
  if (existing) {
    if (sameSpec(rowSpec(existing, rows), spec)) return { queue: await getQueue(project, name), created: false };
    throw new ConflictError(`a queue named "${name}" already exists with different settings`);
  }
  if (rows.size >= QUEUE_LIMITS.queuesPerProject) throw new ConflictError(`a project can have at most ${QUEUE_LIMITS.queuesPerProject} queues`);
  checkDeadLetter(name, spec, new Map([...rows.values()].map((r) => [r.name, r.fifo])));
  try {
    await sql.begin(async (tx) => {
      const [row]: { id: string }[] = await tx`
        insert into mybase.queues (project, name, fifo, visibility_timeout_ms, delay_ms, retention_ms, max_message_bytes, receive_wait_ms, source)
        values (${project}, ${name}, ${spec.fifo}, 0, 0, 0, 0, 0, ${source})
        returning id`;
      await writeSettings(tx, project, row!.id, spec);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`a queue named "${name}" already exists`);
    throw err;
  } finally {
    queueCache.delete(project);
  }
  log.info("queue created", { queue: name, fifo: spec.fifo, source });
  return { queue: await getQueue(project, name), created: true };
}

function codeManaged(name: string, what: string): ConflictError {
  return new ConflictError(`"${name}" is managed in code. ${what} mybase.config.ts and run \`mybase queue sync\``);
}

export async function updateQueue(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<Queue> {
  await requireEnabled(project);
  const rows = await queueRows(project);
  const row = await queueRow(project, name);
  if (row.source === "code") throw codeManaged(name, "Edit it in");
  if ("name" in body && body.name !== name) throw new BadRequestError("queues can't be renamed");
  const spec = readSpec(body, rowSpec(row, rows));
  checkDeadLetter(name, spec, new Map([...rows.values()].map((r) => [r.name, r.fifo])));
  await writeSettings(sql, project, row.id, spec);
  queueCache.delete(project);
  // A shorter delay can make messages ready sooner.
  notify(row.id);
  log.info("queue updated", { queue: name });
  return getQueue(project, name);
}

export async function deleteQueue(project: string, name: string, log: Logger) {
  await requireEnabled(project);
  const row = await queueRow(project, name);
  if (row.source === "code") throw codeManaged(name, "Remove it from");
  // Cascades to its messages; queues using it as a dead-letter queue lose that setting.
  await sql`delete from mybase.queues where id = ${row.id}`;
  queueCache.delete(project);
  notify(row.id);
  log.info("queue deleted", { queue: name });
}

export async function purgeQueue(project: string, name: string, log: Logger) {
  await requireEnabled(project);
  const row = await queueRow(project, name);
  const result = await sql`delete from mybase.queue_messages where queue_id = ${row.id}`;
  log.info("queue purged", { queue: name, messages: result.count });
}

/**
 * Makes the project's code-defined queues match `input`, like `mybase ratelimit sync`.
 * Dashboard and app-created queues are untouched; a name already used by one is a conflict.
 * Deleting a queue deletes its messages, so the CLI confirms deletions first.
 */
export async function syncQueues(project: string, input: unknown, dryRun: boolean, log: Logger): Promise<SyncQueuesResponse> {
  await requireEnabled(project);
  if (!Array.isArray(input)) throw new BadRequestError("queues must be an array");
  const rows = await queueRows(project);
  const wanted = new Map<string, QueueSettings>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) throw new BadRequestError("each queue must be an object");
    const body = item as Record<string, unknown>;
    const name = queueName(body.name);
    if (wanted.has(name)) throw new BadRequestError(`queue "${name}" is listed twice`);
    try {
      wanted.set(name, readSpec(body, null));
    } catch (err) {
      if (err instanceof BadRequestError) throw new BadRequestError(`queue "${name}": ${err.message}`);
      throw err;
    }
  }

  const result: SyncQueuesResponse = { created: [], updated: [], deleted: [], unchanged: [] };
  for (const [name, spec] of wanted) {
    const row = rows.get(name);
    if (row && row.source !== "code") throw new ConflictError(`"${name}" already exists as a ${row.source === "api" ? "queue created by your app" : "dashboard queue"}. Delete it first`);
    if (row && row.fifo !== spec.fifo) {
      throw new ConflictError(`"${name}" can't switch between standard and FIFO. Remove it, sync, then add it back under the new kind (its messages are deleted)`);
    }
    if (!row) result.created.push(name);
    else if (sameSpec(rowSpec(row, rows), spec)) result.unchanged.push(name);
    else result.updated.push(name);
  }
  for (const row of rows.values()) if (row.source === "code" && !wanted.has(row.name)) result.deleted.push(row.name);

  // Dead-letter targets: queues after the sync, wanted ones included, deleted ones not.
  const after = new Map([...rows.values()].filter((r) => !result.deleted.includes(r.name)).map((r) => [r.name, r.fifo]));
  for (const [name, spec] of wanted) after.set(name, spec.fifo);
  for (const [name, spec] of wanted) {
    try {
      checkDeadLetter(name, spec, after);
    } catch (err) {
      throw new BadRequestError(`queue "${name}": ${(err as Error).message}`);
    }
  }
  if (rows.size - result.deleted.length + result.created.length > QUEUE_LIMITS.queuesPerProject) {
    throw new ConflictError(`a project can have at most ${QUEUE_LIMITS.queuesPerProject} queues`);
  }
  if (dryRun) return result;

  const deletedIds = result.deleted.map((n) => rows.get(n)!.id);
  await sql.begin(async (tx) => {
    for (const name of result.created) {
      await tx`
        insert into mybase.queues (project, name, fifo, visibility_timeout_ms, delay_ms, retention_ms, max_message_bytes, receive_wait_ms, source)
        values (${project}, ${name}, ${wanted.get(name)!.fifo}, 0, 0, 0, 0, 0, 'code')`;
    }
    if (deletedIds.length > 0) await tx`delete from mybase.queues where id in ${tx(deletedIds)}`;
    // Settings last, once every dead-letter target exists.
    for (const name of [...result.created, ...result.updated]) {
      const [row]: { id: string }[] = await tx`select id from mybase.queues where project = ${project} and name = ${name}`;
      await writeSettings(tx, project, row!.id, wanted.get(name)!);
    }
  });
  queueCache.delete(project);
  for (const id of deletedIds) notify(id);
  log.info("queues synced", {
    created: result.created.length,
    updated: result.updated.length,
    deleted: result.deleted.length,
    unchanged: result.unchanged.length,
  });
  return result;
}

// ---- send -------------------------------------------------------------------

interface ValidEntry {
  i: number;
  id: string;
  messageId: string;
  body: string;
  attributes: QueueAttributes | null;
  groupId: string | null;
  dedupId: string | null;
  delayMs: number;
}

function attributes(value: unknown): QueueAttributes | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("attributes must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > QUEUE_LIMITS.attributes) throw new BadRequestError(`at most ${QUEUE_LIMITS.attributes} attributes`);
  for (const [k, v] of entries) {
    if (!ATTRIBUTE_NAME_PATTERN.test(k)) throw new BadRequestError(`invalid attribute name "${k}": use letters, digits, ".", "_", or "-"`);
    const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (!ok) throw new BadRequestError(`attribute "${k}" must be a string, number, or boolean`);
  }
  return entries.length > 0 ? (value as QueueAttributes) : null;
}

function readEntry(q: QueueRow, raw: unknown, i: number): ValidEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadRequestError("each message must be an object");
  const e = raw as Record<string, unknown>;
  const id = e.id === undefined ? String(i) : (e.id as string);
  if (typeof e.body !== "string" || e.body.length === 0) throw new BadRequestError("body must be a non-empty string");
  if (e.body.includes("\u0000")) throw new BadRequestError("body can't contain NUL characters");
  const attrs = attributes(e.attributes);
  const bytes = Buffer.byteLength(e.body) + (attrs ? Buffer.byteLength(JSON.stringify(attrs)) : 0);
  if (bytes > q.maxMessageBytes) throw new BadRequestError(`message is ${bytes} bytes; this queue allows ${q.maxMessageBytes}`);

  let delayMs = q.delayMs;
  if (e.delayMs !== undefined) {
    if (q.fifo) throw new BadRequestError("FIFO queues don't take a per-message delay; set the queue's delay instead");
    delayMs = intIn(e.delayMs, "delayMs", QUEUE_LIMITS.delayMs.min, QUEUE_LIMITS.delayMs.max);
  }

  let groupId: string | null = null;
  let dedupId: string | null = null;
  if (q.fifo) {
    if (typeof e.groupId !== "string" || !GROUP_ID_PATTERN.test(e.groupId)) {
      throw new BadRequestError(`groupId is required on FIFO queues: 1–${QUEUE_LIMITS.idLength} printable ASCII characters`);
    }
    groupId = e.groupId;
    if (e.dedupId !== undefined) {
      if (typeof e.dedupId !== "string" || !GROUP_ID_PATTERN.test(e.dedupId)) {
        throw new BadRequestError(`dedupId must be 1–${QUEUE_LIMITS.idLength} printable ASCII characters`);
      }
      dedupId = e.dedupId;
    } else if (q.contentDedup) {
      dedupId = new Bun.CryptoHasher("sha256").update(e.body).digest("hex");
    } else {
      throw new BadRequestError("dedupId is required on this FIFO queue (or turn on contentDedup)");
    }
  } else if (e.groupId !== undefined || e.dedupId !== undefined) {
    throw new BadRequestError("groupId and dedupId are for FIFO queues");
  }
  return { i, id, messageId: crypto.randomUUID(), body: e.body, attributes: attrs, groupId, dedupId, delayMs };
}

/** Inserts messages in order. Ids are made here, so rows map back to entries. */
async function insertMessages(tx: TransactionSQL | typeof sql, q: QueueRow, entries: ValidEntry[]): Promise<Map<string, string>> {
  const json = JSON.stringify(
    entries.map((e) => ({ i: e.i, id: e.messageId, body: e.body, attributes: e.attributes, group_id: e.groupId, dedup_id: e.dedupId, delay_ms: e.delayMs })),
  );
  const rows: { id: string; seq: string }[] = await tx`
    insert into mybase.queue_messages (id, queue_id, body, attributes, group_id, dedup_id, visible_at, expires_at)
    select x.id, ${q.id}, x.body, x.attributes, x.group_id, x.dedup_id,
      now() + x.delay_ms * interval '1 millisecond', now() + ${q.retentionMs}::bigint * interval '1 millisecond'
    from jsonb_to_recordset(${json}::text::jsonb) as x(i int, id uuid, body text, attributes jsonb, group_id text, dedup_id text, delay_ms int)
    order by x.i
    returning id, seq::text as seq`;
  return new Map(rows.map((r) => [r.id, r.seq]));
}

/** Serializes FIFO sends and receives on one queue: dedup checks and group locks need it. */
const lockQueue = (tx: TransactionSQL, q: QueueRow) => tx`select pg_advisory_xact_lock(hashtext(${`mybase.queue:${q.id}`}))`;

export async function sendMessages(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<SendMessagesResponse> {
  const q = await queueRow(project, name);
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > QUEUE_LIMITS.batch) {
    throw new BadRequestError(`messages must be an array of 1 to ${QUEUE_LIMITS.batch} messages`);
  }
  const ids = raw.map((e, i) => (typeof e === "object" && e !== null && "id" in e ? (e as { id: unknown }).id : String(i)));
  for (const id of ids) if (typeof id !== "string" || !ENTRY_ID_PATTERN.test(id)) throw new BadRequestError(`invalid entry id "${String(id)}": 1–80 letters, digits, "_", or "-"`);
  if (new Set(ids).size !== ids.length) throw new BadRequestError("entry ids must be unique within a batch");

  const failed: BatchFailure[] = [];
  const valid: ValidEntry[] = [];
  let total = 0;
  raw.forEach((entry, i) => {
    try {
      const e = readEntry(q, entry, i);
      total += Buffer.byteLength(e.body);
      valid.push(e);
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err;
      failed.push({ id: ids[i] as string, error: err.message });
    }
  });
  if (total > QUEUE_LIMITS.batchBytes) throw new BadRequestError(`a send can carry at most ${QUEUE_LIMITS.batchBytes} bytes; split it up`);
  if (valid.length === 0) return { successful: [], failed };

  let successful: SentMessage[];
  if (!q.fifo) {
    await insertMessages(sql, q, valid);
    successful = valid.map((e) => ({ id: e.id, messageId: e.messageId, sequence: null, duplicate: false }));
  } else {
    successful = await sql.begin(async (tx) => {
      await lockQueue(tx, q);
      const dedupIds = [...new Set(valid.map((e) => e.dedupId!))];
      await tx`delete from mybase.queue_dedup where queue_id = ${q.id} and dedup_id in ${tx(dedupIds)} and expires_at <= now()`;
      const seen = new Map<string, { messageId: string; seq: string | null }>(
        (
          (await tx`select dedup_id as "dedupId", message_id as "messageId", seq::text as seq from mybase.queue_dedup
            where queue_id = ${q.id} and dedup_id in ${tx(dedupIds)}`) as { dedupId: string; messageId: string; seq: string }[]
        ).map((r) => [r.dedupId, r]),
      );
      const fresh: ValidEntry[] = [];
      const firstOf = new Map<string, ValidEntry>();
      for (const e of valid) {
        if (seen.has(e.dedupId!) || firstOf.has(e.dedupId!)) continue;
        firstOf.set(e.dedupId!, e);
        fresh.push(e);
      }
      const seqs = fresh.length > 0 ? await insertMessages(tx, q, fresh) : new Map<string, string>();
      if (fresh.length > 0) {
        const dedupRows = fresh.map((e) => ({ dedup_id: e.dedupId, message_id: e.messageId, seq: seqs.get(e.messageId)! }));
        await tx`
          insert into mybase.queue_dedup (queue_id, dedup_id, message_id, seq, expires_at)
          select ${q.id}, x.dedup_id, x.message_id, x.seq, now() + ${QUEUE_LIMITS.dedupWindowMs}::bigint * interval '1 millisecond'
          from jsonb_to_recordset(${JSON.stringify(dedupRows)}::text::jsonb) as x(dedup_id text, message_id uuid, seq bigint)`;
      }
      return valid.map((e) => {
        const original = seen.get(e.dedupId!);
        if (original) return { id: e.id, messageId: original.messageId, sequence: original.seq, duplicate: true };
        const first = firstOf.get(e.dedupId!)!;
        return { id: e.id, messageId: first.messageId, sequence: seqs.get(first.messageId) ?? null, duplicate: first !== e };
      });
    });
  }
  const sent = successful.filter((s) => !s.duplicate).length;
  count(q.id, "sent", sent);
  notify(q.id);
  log.debug("messages sent", { queue: name, sent, duplicates: successful.length - sent, failed: failed.length });
  return { successful, failed };
}

// ---- receive ----------------------------------------------------------------

interface ReceivedRow {
  id: string;
  receipt: string;
  body: string;
  attributes: QueueAttributes | null;
  groupId: string | null;
  dedupId: string | null;
  seq: string;
  receiveCount: number;
  sentAt: Date;
  firstReceivedAt: Date;
}

/** Moves messages that used up their receives to the dead-letter queue. */
async function moveDeadLetters(tx: TransactionSQL, project: string, q: QueueRow): Promise<string | null> {
  const dlq = await queueById(project, q.deadLetterId);
  if (!dlq || !q.maxReceives) return null;
  const [{ n }]: { n: number }[] = await tx`
    with picked as (
      select id from mybase.queue_messages
      where queue_id = ${q.id} and visible_at <= now() and receive_count >= ${q.maxReceives}
      for update skip locked
    ), moved as (
      update mybase.queue_messages m set
        queue_id = ${dlq.id}, dead_lettered_from = ${q.id}, receive_count = 0, receipt = null, first_received_at = null,
        visible_at = now(), expires_at = now() + ${dlq.retentionMs}::bigint * interval '1 millisecond'
      from picked where m.id = picked.id
      returning 1
    )
    select count(*)::int as n from moved`;
  if (n === 0) return null;
  count(q.id, "dead", n);
  log.info("messages dead-lettered", { project, queue: q.name, to: dlq.name, messages: n });
  return dlq.id;
}

const RECEIVED_COLUMNS = sql`
  m.id, m.receipt, m.body, m.attributes, m.group_id as "groupId", m.dedup_id as "dedupId", m.seq::text as seq,
  m.receive_count as "receiveCount", m.sent_at as "sentAt", m.first_received_at as "firstReceivedAt"`;

async function receiveOnce(project: string, q: QueueRow, max: number, visibilityMs: number): Promise<ReceivedRow[]> {
  let deadLetterQueue: string | null = null;
  const rows = await sql.begin(async (tx) => {
    if (q.fifo) await lockQueue(tx, q);
    deadLetterQueue = await moveDeadLetters(tx, project, q);
    const take = (picked: unknown) => tx`
      with picked as (${picked})
      update mybase.queue_messages m set
        visible_at = now() + ${visibilityMs}::bigint * interval '1 millisecond',
        receive_count = m.receive_count + 1,
        receipt = replace(gen_random_uuid()::text, '-', ''),
        first_received_at = coalesce(m.first_received_at, now())
      from picked where m.id = picked.id
      returning ${RECEIVED_COLUMNS}`;
    if (!q.fifo) {
      return take(tx`
        select id from mybase.queue_messages
        where queue_id = ${q.id} and visible_at <= now() and expires_at > now()
        order by seq limit ${max}
        for update skip locked`) as Promise<ReceivedRow[]>;
    }
    // A group is blocked while any of its messages is in flight, or an earlier one is delayed.
    return take(tx`
      select c.id from mybase.queue_messages c
      where c.queue_id = ${q.id} and c.visible_at <= now() and c.expires_at > now()
        and not exists (
          select 1 from mybase.queue_messages b
          where b.queue_id = c.queue_id and b.group_id = c.group_id and b.visible_at > now() and b.expires_at > now()
            and (b.receipt is not null or b.seq < c.seq)
        )
      order by c.seq limit ${max}
      for update of c`) as Promise<ReceivedRow[]>;
  });
  if (deadLetterQueue) notify(deadLetterQueue);
  return rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
}

const toMessage = (r: ReceivedRow): QueueMessage => ({
  messageId: r.id,
  receipt: `${r.id}.${r.receipt}`,
  body: r.body,
  attributes: r.attributes ?? {},
  groupId: r.groupId,
  dedupId: r.dedupId,
  sequence: r.groupId === null ? null : r.seq,
  receiveCount: r.receiveCount,
  sentAt: r.sentAt.toISOString(),
  firstReceivedAt: r.firstReceivedAt.toISOString(),
});

/** How long a receive with this body may wait, for the route to extend the connection's idle timeout. */
export function receiveWaitMs(body: Record<string, unknown>): number {
  return Number.isInteger(body.waitMs) ? Math.min(Math.max(body.waitMs as number, 0), QUEUE_LIMITS.waitMs.max) : QUEUE_LIMITS.waitMs.max;
}

/** Receives up to `max` messages, long-polling up to `waitMs` when none are ready. */
export async function receiveMessages(project: string, name: string, body: Record<string, unknown>, signal: AbortSignal): Promise<QueueMessage[]> {
  let q = await queueRow(project, name);
  const L = QUEUE_LIMITS;
  const max = body.max === undefined ? 1 : intIn(body.max, "max", 1, L.batch);
  const waitMs = body.waitMs === undefined ? q.receiveWaitMs : intIn(body.waitMs, "waitMs", L.waitMs.min, L.waitMs.max);
  const visibilityMs =
    body.visibilityTimeoutMs === undefined ? q.visibilityTimeoutMs : intIn(body.visibilityTimeoutMs, "visibilityTimeoutMs", L.visibilityTimeoutMs.min, L.visibilityTimeoutMs.max);
  const deadline = Date.now() + waitMs;

  for (;;) {
    const rows = await receiveOnce(project, q, max, visibilityMs);
    if (rows.length > 0) {
      count(q.id, "received", rows.length);
      return rows.map(toMessage);
    }
    if (Date.now() >= deadline || signal.aborted) return [];
    // Sleep until a send wakes us, the next hidden message becomes visible, or time is up.
    const [{ next }]: { next: Date | null }[] = await sql`
      select min(visible_at) as next from mybase.queue_messages where queue_id = ${q.id} and visible_at > now() and expires_at > now()`;
    const until = Math.min(deadline, next ? next.getTime() + 5 : Infinity);
    await waitFor(q.id, until - Date.now(), signal);
    if (signal.aborted) return [];
    // The queue may have been changed or deleted meanwhile.
    q = await queueRow(project, name);
  }
}

// ---- delete, visibility, redrive ---------------------------------------------

function receipts(values: unknown[], failed: BatchFailure[]): { id: string; receipt: string; raw: string }[] {
  const parsed: { id: string; receipt: string; raw: string }[] = [];
  for (const value of values) {
    const m = typeof value === "string" ? RECEIPT_PATTERN.exec(value) : null;
    if (!m) failed.push({ id: String(value), error: "invalid receipt" });
    else parsed.push({ id: m[1]!, receipt: m[2]!, raw: value as string });
  }
  return parsed;
}

function batchOf(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > QUEUE_LIMITS.batch) {
    throw new BadRequestError(`${field} must be an array of 1 to ${QUEUE_LIMITS.batch} items`);
  }
  return value;
}

export async function deleteMessages(project: string, name: string, body: Record<string, unknown>): Promise<BatchResult> {
  const q = await queueRow(project, name);
  const failed: BatchFailure[] = [];
  const parsed = receipts(batchOf(body.receipts, "receipts"), failed);
  let done = 0;
  if (parsed.length > 0) {
    const rows: { id: string }[] = await sql`
      delete from mybase.queue_messages m using jsonb_to_recordset(${JSON.stringify(parsed)}::text::jsonb) as x(id uuid, receipt text)
      where m.queue_id = ${q.id} and m.id = x.id and m.receipt = x.receipt
      returning m.id`;
    const deleted = new Set(rows.map((r) => r.id));
    done = deleted.size;
    for (const p of parsed) if (!deleted.has(p.id)) failed.push({ id: p.raw, error: "receipt is stale (the message was received again) or the message is gone" });
    count(q.id, "deleted", done);
    // Deleting the last in-flight message of a FIFO group unblocks the group.
    if (q.fifo && done > 0) notify(q.id);
  }
  return { done, failed };
}

export async function changeVisibility(project: string, name: string, body: Record<string, unknown>): Promise<BatchResult> {
  const q = await queueRow(project, name);
  const failed: BatchFailure[] = [];
  const entries: { id: string; receipt: string; raw: string; ms: number }[] = [];
  for (const raw of batchOf(body.entries, "entries")) {
    const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const [parsed] = receipts([e.receipt], failed);
    if (!parsed) continue;
    const { min, max } = QUEUE_LIMITS.visibilityTimeoutMs;
    if (!Number.isInteger(e.visibilityTimeoutMs) || (e.visibilityTimeoutMs as number) < min || (e.visibilityTimeoutMs as number) > max) {
      failed.push({ id: parsed.raw, error: `visibilityTimeoutMs must be an integer from ${min} to ${max}` });
      continue;
    }
    entries.push({ ...parsed, ms: e.visibilityTimeoutMs as number });
  }
  let done = 0;
  if (entries.length > 0) {
    const rows: { id: string }[] = await sql`
      update mybase.queue_messages m set visible_at = now() + x.ms * interval '1 millisecond'
      from jsonb_to_recordset(${JSON.stringify(entries)}::text::jsonb) as x(id uuid, receipt text, ms bigint)
      where m.queue_id = ${q.id} and m.id = x.id and m.receipt = x.receipt and m.visible_at > now()
      returning m.id`;
    const changed = new Set(rows.map((r) => r.id));
    done = changed.size;
    for (const e of entries) if (!changed.has(e.id)) failed.push({ id: e.raw, error: "message isn't in flight (its visibility timeout ran out, it was received again, or it's gone)" });
    if (done > 0) notify(q.id);
  }
  return { done, failed };
}

/** Moves a queue's messages (normally a dead-letter queue's) back to where they came from, or to `to`. */
export async function redrive(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<RedriveResponse> {
  await requireEnabled(project);
  const q = await queueRow(project, name);
  const reset = sql`dead_lettered_from = null, receive_count = 0, receipt = null, first_received_at = null, visible_at = now()`;
  // In-flight messages stay: someone is working on them.
  const movable = sql`m.queue_id = ${q.id} and (m.receipt is null or m.visible_at <= now()) and m.expires_at > now()`;
  let targets: string[];
  if (body.to !== undefined) {
    const target = await queueRow(project, queueName(body.to));
    if (target.id === q.id) throw new BadRequestError("can't redrive a queue into itself");
    if (target.fifo !== q.fifo) throw new BadRequestError(`"${target.name}" must be ${q.fifo ? "a FIFO" : "a standard"} queue too`);
    const rows: { id: string }[] = await sql`
      update mybase.queue_messages m set queue_id = ${target.id}, ${reset},
        expires_at = now() + ${target.retentionMs}::bigint * interval '1 millisecond'
      where ${movable}
      returning m.id`;
    targets = rows.length > 0 ? [target.id] : [];
    count(target.id, "sent", rows.length);
    log.info("queue redriven", { queue: name, to: target.name, messages: rows.length });
    for (const id of targets) notify(id);
    return { moved: rows.length };
  }
  const rows: { queueId: string }[] = await sql`
    update mybase.queue_messages m set queue_id = s.id, ${reset},
      expires_at = now() + s.retention_ms * interval '1 millisecond'
    from mybase.queues s
    where ${movable} and s.id = m.dead_lettered_from and s.project = ${project} and s.fifo = ${q.fifo}
    returning m.queue_id as "queueId"`;
  targets = [...new Set(rows.map((r) => r.queueId))];
  for (const id of targets) count(id, "sent", rows.filter((r) => r.queueId === id).length);
  for (const id of targets) notify(id);
  log.info("queue redriven", { queue: name, to: "sources", messages: rows.length });
  return { moved: rows.length };
}

// ---- dashboard: peek, delete one --------------------------------------------

/** Lists messages without receiving them (no receipt, no visibility change). */
export async function peekMessages(project: string, name: string, limit: number): Promise<QueueMessageRecord[]> {
  await requireEnabled(project);
  const q = await queueRow(project, name);
  const rows: {
    id: string;
    body: string;
    bytes: number;
    truncated: boolean;
    attributes: QueueAttributes | null;
    groupId: string | null;
    dedupId: string | null;
    seq: string;
    ready: boolean;
    received: boolean;
    receiveCount: number;
    sentAt: Date;
    visibleAt: Date;
    expiresAt: Date;
    deadLetteredFrom: string | null;
  }[] = await sql`
    select id, left(body, ${PEEK_BODY_CHARS}) as body, octet_length(body) as bytes, length(body) > ${PEEK_BODY_CHARS} as truncated,
      attributes, group_id as "groupId", dedup_id as "dedupId", seq::text as seq, visible_at <= now() as ready,
      receipt is not null as received, receive_count as "receiveCount", sent_at as "sentAt", visible_at as "visibleAt",
      expires_at as "expiresAt", dead_lettered_from as "deadLetteredFrom"
    from mybase.queue_messages where queue_id = ${q.id} and expires_at > now()
    order by queue_messages.seq limit ${limit}`;
  const all = await queueRows(project);
  const nameOf = (id: string | null) => (id ? ([...all.values()].find((r) => r.id === id)?.name ?? "(deleted queue)") : null);
  return rows.map((r) => ({
    messageId: r.id,
    body: r.body,
    truncated: r.truncated,
    bytes: r.bytes,
    attributes: r.attributes ?? {},
    groupId: r.groupId,
    dedupId: r.dedupId,
    sequence: q.fifo ? r.seq : null,
    state: r.ready ? "visible" : r.received ? "inFlight" : "delayed",
    receiveCount: r.receiveCount,
    sentAt: r.sentAt.toISOString(),
    visibleAt: r.visibleAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    deadLetteredFrom: nameOf(r.deadLetteredFrom),
  }));
}

/** Deletes one message by id, whatever its state. The dashboard's delete button. */
export async function deleteMessageById(project: string, name: string, id: string, log: Logger) {
  await requireEnabled(project);
  const q = await queueRow(project, name);
  if (!UUID_PATTERN.test(id)) throw new NotFoundError("no such message");
  const result = await sql`delete from mybase.queue_messages where queue_id = ${q.id} and id = ${id}`;
  if (result.count === 0) throw new NotFoundError("no such message");
  count(q.id, "deleted", 1);
  if (q.fifo) notify(q.id);
  log.info("queue message deleted", { queue: name });
}

// ---- stats ------------------------------------------------------------------

export function readStatsRange(value: string | null): QueueStatsRange {
  if (value === null) return "24h";
  if (!(QUEUE_STATS_RANGES as readonly string[]).includes(value)) throw new BadRequestError(`range must be one of ${QUEUE_STATS_RANGES.join(", ")}`);
  return value as QueueStatsRange;
}

/** Hourly sent/received/deleted/dead-lettered counts per queue. */
export async function stats(project: string, range: QueueStatsRange): Promise<QueueStats> {
  await requireEnabled(project);
  await flushQueueStats();
  const hours = range === "24h" ? 24 : 168;
  const first = Math.floor(Date.now() / 3_600_000) - hours + 1;
  const rows: { name: string; hour: Date; sent: number; received: number; deleted: number; dead: number }[] = await sql`
    select q.name, s.hour, s.sent, s.received, s.deleted, s.dead
    from mybase.queue_stats s join mybase.queues q on q.id = s.queue_id
    where q.project = ${project} and s.hour >= ${new Date(first * 3_600_000)}`;
  const byQueue = new Map<string, Map<number, (typeof rows)[number]>>();
  for (const name of (await queueRows(project)).keys()) byQueue.set(name, new Map());
  for (const r of rows) byQueue.get(r.name)?.set(Math.floor(r.hour.getTime() / 3_600_000), r);

  const queues: QueueStatsSeries[] = [...byQueue].map(([queue, points]) => {
    const series = Array.from({ length: hours }, (_, i) => {
      const p = points.get(first + i);
      return { t: new Date((first + i) * 3_600_000).toISOString(), sent: p?.sent ?? 0, received: p?.received ?? 0, deleted: p?.deleted ?? 0, dead: p?.dead ?? 0 };
    });
    const sum = (field: "sent" | "received" | "deleted" | "dead") => series.reduce((n, p) => n + p[field], 0);
    return { queue, sent: sum("sent"), received: sum("received"), deleted: sum("deleted"), dead: sum("dead"), series };
  });
  return { range, queues };
}

// ---- lifecycle --------------------------------------------------------------

/** Deletes expired messages and dedup ids, and old stats. Hourly: queries already skip expired rows. */
async function prune() {
  try {
    const messages = await sql`delete from mybase.queue_messages where expires_at <= now()`;
    await sql`delete from mybase.queue_dedup where expires_at <= now()`;
    await sql`delete from mybase.queue_stats where hour < now() - interval '8 days'`;
    if (messages.count > 0) log.info("expired messages pruned", { messages: messages.count });
  } catch (err) {
    log.error("queue prune failed", { err });
  }
}

/** Starts the stats and prune timers. Call once at boot. */
export function startQueues() {
  setInterval(() => void flushQueueStats(), STATS_FLUSH_MS);
  void prune();
  setInterval(() => void prune(), 3_600_000);
}

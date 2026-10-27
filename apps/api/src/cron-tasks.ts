// One-off cron tasks: "call this job once, at this time". Apps schedule them through the
// SDK (`createCronClient`) with an API key (`cron:write`); the
// dashboard and CLI list and cancel them.
//
// Unlike cron ticks, tasks are durable: one due while the API was down runs at the next
// boot, and one that was running when the API stopped runs again (at least once; `runId`
// is the task id, so apps can dedupe). One timer covers all tasks: it sleeps until the
// soonest pending one, so an idle Pi doesn't poll Postgres.
import { CRON_DEFAULTS, CRON_JOB_NAME_PATTERN, CRON_JOB_NAME_RULES, type CronTask, type CronTaskStatus } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { deliver } from "./cron-scheduler";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";

const log = createLogger("cron");

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_DELAY_MS = 366 * 86_400_000;
/** Pending tasks a project may have at once. */
const MAX_PENDING = 10_000;
/** Calls in flight at once, across projects. */
const MAX_CONCURRENT = 10;
/** Longest single sleep; also caps setTimeout's ~24.8-day limit. */
const MAX_SLEEP_MS = 3_600_000;
/** Finished and cancelled tasks are deleted after this long. */
const KEEP_DONE = "7 days";
export const TASK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
/** Largest body an app may send; tasks are small. */
export const MAX_APP_BODY = 64 * 1024;

// ---- rows -------------------------------------------------------------------

interface TaskRow {
  id: string;
  project: string;
  job: string;
  key: string | null;
  url: string;
  payload: string | null;
  runAt: Date;
  timeoutMs: number;
  retries: number;
  status: CronTaskStatus;
  attempts: number;
  httpStatus: number | null;
  durationMs: number | null;
  error: string | null;
  response: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const COLUMNS = sql`
  id, project, job, key, url, payload::text as payload, run_at as "runAt", timeout_ms as "timeoutMs", retries,
  status, attempts, http_status as "httpStatus", duration_ms as "durationMs", error, response,
  created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const toTask = (r: TaskRow): CronTask => ({
  id: r.id,
  job: r.job,
  key: r.key,
  url: r.url,
  payload: r.payload === null ? null : JSON.parse(r.payload),
  runAt: r.runAt.toISOString(),
  timeoutMs: r.timeoutMs,
  retries: r.retries,
  status: r.status,
  attempts: r.attempts,
  httpStatus: r.httpStatus,
  durationMs: r.durationMs,
  error: r.error,
  response: r.response,
  createdAt: r.createdAt.toISOString(),
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A task by id or key (the newest with that key). */
export type TaskRef = { id: string } | { key: string };

async function findTask(project: string, ref: TaskRef): Promise<TaskRow> {
  let rows: TaskRow[] = [];
  if ("id" in ref) {
    if (UUID.test(ref.id)) rows = await sql`select ${COLUMNS} from mybase.cron_tasks where project = ${project} and id = ${ref.id}`;
  } else {
    rows = await sql`select ${COLUMNS} from mybase.cron_tasks where project = ${project} and key = ${ref.key} order by created_at desc limit 1`;
  }
  if (!rows[0]) throw new NotFoundError("no such task");
  return rows[0];
}

// ---- api --------------------------------------------------------------------

function intIn(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/**
 * Creates a task, or returns the pending/running one with the same key. `created` says which.
 * Callers have checked that cron is enabled.
 */
export async function createTask(project: string, body: Record<string, unknown>, log: Logger): Promise<{ task: CronTask; created: boolean }> {
  if (typeof body.job !== "string" || !CRON_JOB_NAME_PATTERN.test(body.job)) {
    throw new BadRequestError(`invalid job "${String(body.job ?? "")}". ${CRON_JOB_NAME_RULES}`);
  }
  const job = body.job;
  let url: URL;
  try {
    url = new URL(String(body.url ?? ""));
  } catch {
    throw new BadRequestError(`invalid url "${String(body.url ?? "")}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError("url must start with http:// or https://");

  if (body.runAt !== undefined && body.delayMs !== undefined) throw new BadRequestError("give runAt or delayMs, not both");
  let runAt = new Date();
  if (body.runAt !== undefined) {
    runAt = new Date(typeof body.runAt === "string" ? body.runAt : NaN);
    if (Number.isNaN(runAt.getTime())) throw new BadRequestError("runAt must be an ISO date");
  } else if (body.delayMs !== undefined) {
    runAt = new Date(Date.now() + intIn(body.delayMs, "delayMs", 0, MAX_DELAY_MS, 0));
  }
  if (runAt.getTime() > Date.now() + MAX_DELAY_MS) throw new BadRequestError("runAt must be within a year");

  const key = body.key ?? null;
  if (key !== null && (typeof key !== "string" || !TASK_KEY_PATTERN.test(key))) {
    throw new BadRequestError("key must be 1–200 letters, digits, or _ . : @ -, starting with a letter or digit");
  }
  const payload = body.payload === undefined || body.payload === null ? null : JSON.stringify(body.payload);
  if (payload !== null && payload.length > MAX_PAYLOAD_BYTES) throw new BadRequestError(`payload must be at most ${MAX_PAYLOAD_BYTES / 1024} KB of JSON`);
  const timeoutMs = intIn(body.timeoutMs, "timeoutMs", 1000, 120_000, CRON_DEFAULTS.timeoutMs);
  const retries = intIn(body.retries, "retries", 0, 5, CRON_DEFAULTS.retries);

  const result = await sql.begin(async (tx) => {
    // Serializes creates per project, so the key check and the pending cap hold.
    await tx`select pg_advisory_xact_lock(hashtext('mybase.cron_tasks'), hashtext(${project}))`;
    if (key !== null) {
      const [existing]: TaskRow[] = await tx`
        select ${COLUMNS} from mybase.cron_tasks where project = ${project} and key = ${key} and status in ('pending', 'running')`;
      if (existing) return { row: existing, created: false };
    }
    const [{ count }]: { count: number }[] = await tx`select count(*)::int as count from mybase.cron_tasks where project = ${project} and status = 'pending'`;
    if (count >= MAX_PENDING) throw new ConflictError(`this project already has ${MAX_PENDING} pending tasks`);
    const [row]: TaskRow[] = await tx`
      insert into mybase.cron_tasks (project, job, key, url, payload, run_at, timeout_ms, retries)
      values (${project}, ${job}, ${key}, ${url.href}, ${payload}::text::jsonb, ${runAt}, ${timeoutMs}, ${retries})
      returning ${COLUMNS}`;
    return { row: row!, created: true };
  });

  if (result.created) {
    log.info("cron task scheduled", { job, task: result.row.id.slice(0, 8), runAt: result.row.runAt.toISOString() });
    arm(result.row.runAt);
  }
  return { task: toTask(result.row), created: result.created };
}

export async function getTask(project: string, ref: TaskRef): Promise<CronTask> {
  return toTask(await findTask(project, ref));
}

/** Newest first. `status` filters; `limit` caps. */
export async function listTasks(project: string, status: CronTaskStatus | null, limit: number): Promise<CronTask[]> {
  const rows: TaskRow[] = await sql`
    select ${COLUMNS} from mybase.cron_tasks
    where project = ${project} and (${status}::text is null or status = ${status})
    order by case when status in ('pending', 'running') then 0 else 1 end, run_at desc
    limit ${limit}`;
  return rows.map(toTask);
}

/** Cancels a pending task. Cancelling a cancelled one is a no-op. */
export async function cancelTask(project: string, ref: TaskRef, log: Logger): Promise<CronTask> {
  const row = "key" in ref
    ? // By key, prefer the active one over older finished tasks with the same key.
      ((await sql`select ${COLUMNS} from mybase.cron_tasks where project = ${project} and key = ${ref.key} and status in ('pending', 'running')`)[0] as TaskRow | undefined) ??
      (await findTask(project, ref))
    : await findTask(project, ref);
  if (row.status === "cancelled") return toTask(row);
  if (row.status !== "pending") throw new ConflictError(`task is ${row.status}, only pending tasks can be cancelled`);
  const [updated]: TaskRow[] = await sql`
    update mybase.cron_tasks set status = 'cancelled', finished_at = now()
    where id = ${row.id} and status = 'pending' returning ${COLUMNS}`;
  if (!updated) throw new ConflictError("task already started");
  log.info("cron task cancelled", { job: row.job, task: row.id.slice(0, 8) });
  return toTask(updated);
}

/** Pending task count, for the overview. */
export async function pendingTasks(project: string): Promise<number> {
  const [{ count }]: { count: number }[] = await sql`select count(*)::int as count from mybase.cron_tasks where project = ${project} and status = 'pending'`;
  return count;
}

// ---- runner -----------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let wakeAt: number | null = null;
let ticking = false;
let tickAgain = false;
let lastPrune = 0;
const inFlight = new Set<string>();

/** Makes sure the runner wakes by `at`. */
function arm(at: Date) {
  const t = Math.max(at.getTime(), Date.now());
  if (wakeAt !== null && wakeAt <= t) return;
  if (timer) clearTimeout(timer);
  wakeAt = t;
  timer = setTimeout(() => void tick(), Math.min(t - Date.now(), MAX_SLEEP_MS));
}

/** Starts due tasks (up to the concurrency cap), then sleeps until the next one. */
async function tick() {
  if (timer) clearTimeout(timer);
  timer = null;
  wakeAt = null;
  if (ticking) {
    tickAgain = true;
    return;
  }
  ticking = true;
  try {
    do {
      tickAgain = false;
      const free = MAX_CONCURRENT - inFlight.size;
      if (free > 0) {
        // skip locked: a second API instance can't claim the same task.
        const claimed: TaskRow[] = await sql`
          update mybase.cron_tasks set status = 'running', started_at = now()
          where id in (
            select id from mybase.cron_tasks where status = 'pending' and run_at <= now()
            order by run_at limit ${free} for update skip locked)
          returning ${COLUMNS}`;
        for (const row of claimed) void runTask(row);
      }
      if (Date.now() - lastPrune > MAX_SLEEP_MS) {
        lastPrune = Date.now();
        const pruned = await sql`
          delete from mybase.cron_tasks
          where status in ('success', 'failed', 'cancelled') and finished_at < now() - ${KEEP_DONE}::interval`;
        if (pruned.count > 0) log.debug("old cron tasks pruned", { tasks: pruned.count });
      }
    } while (tickAgain);

    // Full: a finishing run ticks again. Otherwise sleep until the soonest pending task.
    if (inFlight.size < MAX_CONCURRENT) {
      const [next]: { runAt: Date }[] = await sql`
        select run_at as "runAt" from mybase.cron_tasks where status = 'pending' order by run_at limit 1`;
      if (next) arm(next.runAt);
      else arm(new Date(Date.now() + MAX_SLEEP_MS)); // for pruning
    }
  } catch (err) {
    log.error("cron task tick failed", { err });
    arm(new Date(Date.now() + 30_000));
  } finally {
    ticking = false;
  }
}

async function runTask(row: TaskRow) {
  inFlight.add(row.id);
  const runLog = log.child({ project: row.project, job: row.job, task: row.id.slice(0, 8) });
  const startedAt = Date.now();
  try {
    const result = await deliver(
      row,
      {
        job: row.job,
        runId: row.id,
        trigger: "task",
        scheduledAt: row.runAt.toISOString(),
        payload: row.payload === null ? null : JSON.parse(row.payload),
        key: row.key,
      },
      runLog,
    );
    const durationMs = Date.now() - startedAt;
    const fields = { trigger: "task", status: result.ok ? "success" : "failed", http: result.httpStatus ?? undefined, attempts: result.attempts, ms: durationMs };
    if (result.ok) runLog.info("cron run", fields);
    else runLog.warn("cron run failed", { ...fields, error: result.error });
    // No row (cron turned off mid-run) is fine: nothing to record against.
    await sql`
      update mybase.cron_tasks set
        status = ${result.ok ? "success" : "failed"}, attempts = ${result.attempts}, http_status = ${result.httpStatus},
        duration_ms = ${durationMs}, error = ${result.error}, response = ${result.response}, finished_at = now()
      where id = ${row.id}`;
  } catch (err) {
    runLog.error("task not recorded", { err });
  } finally {
    inFlight.delete(row.id);
    void tick();
  }
}

/** Requeues tasks a previous process left running, then starts the runner. Call once at boot. */
export async function startTaskRunner() {
  const requeued = await sql`update mybase.cron_tasks set status = 'pending', started_at = null where status = 'running'`;
  if (requeued.count > 0) log.warn("cron tasks interrupted by shutdown, running again", { tasks: requeued.count });
  await tick();
  const [{ count }]: { count: number }[] = await sql`select count(*)::int as count from mybase.cron_tasks where status = 'pending'`;
  log.info("task runner started", { pending: count });
}

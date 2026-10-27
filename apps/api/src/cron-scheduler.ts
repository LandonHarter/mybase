// Runs cron jobs: one in-process timer per enabled job, each run POSTs a signed request
// to the job's URL and records one row of history.
//
// Ticks missed while the API is down are not replayed, and a run in flight at shutdown
// is lost. Retries happen inside the run, so ticks that land during a retry are skipped
// (`protect`), same as ticks that land while a slow call is still going.
import { JOB_HEADER, RUN_HEADER, SIGNATURE_HEADER, signCronRequest, type CronRun, type CronTrigger } from "@mybase/sdk/cron";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { Cron } from "croner";
import { sql } from "./postgres";

const log = createLogger("cron");

/** What the scheduler needs of a job row. */
export interface ScheduledJob {
  id: string;
  project: string;
  name: string;
  schedule: string;
  timezone: string;
  url: string;
  payload: unknown;
  timeoutMs: number;
  retries: number;
  enabled: boolean;
}

/** Waits before retry 1, 2, 3+. */
const BACKOFF_MS = [10_000, 60_000, 300_000];
/** Run history kept per job; older rows are pruned after each run. */
const HISTORY = 100;
/** Bytes of the response body kept for the dashboard. */
const RESPONSE_BYTES = 1024;

const timers = new Map<string, Cron>();

/** Builds the timer for a schedule, without starting it. Throws on a bad expression or time zone. */
export const cronFor = (schedule: string, timezone: string, options: { paused?: boolean } = {}) =>
  new Cron(schedule, { timezone, mode: "5-part", paused: options.paused });

/** (Re)starts a job's timer from its current row; stops it if the job is paused. */
export function schedule(job: ScheduledJob) {
  unschedule(job.id);
  if (!job.enabled) return;
  const jobLog = log.child({ project: job.project, job: job.name });
  const timer = new Cron(
    job.schedule,
    {
      timezone: job.timezone,
      mode: "5-part",
      protect: () => jobLog.warn("tick skipped, previous run still going"),
      catch: (err) => jobLog.error("cron run crashed", { err }),
    },
    (self) => runJob(job, "schedule", self.currentRun() ?? new Date()),
  );
  timers.set(job.id, timer);
}

export function unschedule(id: string) {
  timers.get(id)?.stop();
  timers.delete(id);
}

/** When the job's timer fires next, or `null` when it isn't scheduled. */
export const nextRunAt = (id: string): Date | null => timers.get(id)?.nextRun() ?? null;

/** Loads every enabled job and starts its timer. Call once at boot, after migrations. */
export async function startScheduler() {
  const jobs = await loadJobs();
  for (const job of jobs) {
    try {
      schedule(job);
    } catch (err) {
      // A row that no longer parses (e.g. a time zone dropped from the ICU data) shouldn't stop the rest.
      log.error("job not scheduled", { project: job.project, job: job.name, err });
    }
  }
  log.info("scheduler started", { jobs: timers.size });
}

/** Enabled jobs, of one project or all of them. */
export async function loadJobs(project: string | null = null): Promise<ScheduledJob[]> {
  return sql`
    select id, project, name, schedule, timezone, url, payload::text as payload, timeout_ms as "timeoutMs", retries, enabled
    from mybase.cron_jobs
    where enabled and (${project}::text is null or project = ${project})`.then((rows: (Omit<ScheduledJob, "payload"> & { payload: string | null })[]) =>
    rows.map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) })),
  );
}

/** Reads at most `limit` bytes of a body, then drops the rest. */
async function readStart(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, limit));
}

const retryable = (status: number) => status === 429 || status >= 500;

/** Where and how to call: a job's or a task's settings. */
export interface CallTarget {
  project: string;
  url: string;
  timeoutMs: number;
  retries: number;
}

/** How a run's call went, after any retries. */
export interface Delivery {
  ok: boolean;
  attempts: number;
  /** Last attempt's status; `null` when it never got a response. */
  httpStatus: number | null;
  error: string | null;
  response: string | null;
}

/**
 * POSTs the signed run to the target, retrying network errors, timeouts, 429, and 5xx.
 * Never throws. Shared by cron jobs and one-off tasks (cron-tasks.ts).
 */
export async function deliver(target: CallTarget, run: Omit<CronRun, "attempt" | "firedAt">, runLog: Logger): Promise<Delivery> {
  let attempts = 0;
  let httpStatus: number | null = null;
  let error: string | null = null;
  let response: string | null = null;
  let ok = false;

  try {
    // Read per run, so a rotated secret takes effect on the next call.
    const [project]: { secret: string }[] = await sql`select secret from mybase.cron_projects where project = ${target.project}`;
    if (!project) throw new Error("cron is no longer enabled for this project");

    while (attempts <= target.retries) {
      if (attempts > 0) await Bun.sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!);
      attempts++;
      const body = JSON.stringify({ ...run, attempt: attempts, firedAt: new Date().toISOString() } satisfies CronRun);
      try {
        const res = await fetch(target.url, {
          method: "POST",
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(target.timeoutMs),
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "mybase-cron/1",
            [JOB_HEADER]: run.job,
            [RUN_HEADER]: run.runId,
            [SIGNATURE_HEADER]: await signCronRequest(project.secret, body),
          },
        });
        httpStatus = res.status;
        response = (await readStart(res, RESPONSE_BYTES)) || null;
        ok = res.status >= 200 && res.status < 300;
        error = ok ? null : `HTTP ${res.status}`;
        if (ok || !retryable(res.status)) break;
      } catch (err) {
        httpStatus = null;
        response = null;
        const e = err as Error;
        error = e.name === "TimeoutError" ? `timed out after ${target.timeoutMs} ms` : e.message;
      }
      if (attempts <= target.retries) runLog.warn("cron attempt failed, retrying", { attempt: attempts, http: httpStatus ?? undefined, error });
    }
  } catch (err) {
    error = (err as Error).message;
  }
  return { ok, attempts, httpStatus, error, response };
}

/**
 * Calls the job's URL (with retries), then records the run.
 * Resolves when the run is finished; never throws.
 */
export async function runJob(job: ScheduledJob, trigger: CronTrigger, scheduledAt: Date, runId: string = crypto.randomUUID()) {
  const runLog = log.child({ project: job.project, job: job.name, run: runId.slice(0, 8) });
  const startedAt = new Date();
  const { ok, attempts, httpStatus, error, response } = await deliver(
    job,
    { job: job.name, runId, trigger, scheduledAt: scheduledAt.toISOString(), payload: job.payload ?? null },
    runLog,
  );

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const fields = { trigger, status: ok ? "success" : "failed", http: httpStatus ?? undefined, attempts, ms: durationMs };
  if (ok) runLog.info("cron run", fields);
  else runLog.warn("cron run failed", { ...fields, error });

  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into mybase.cron_runs
          (id, job_id, trigger, status, attempts, http_status, duration_ms, error, response, scheduled_at, started_at, finished_at)
        values (${runId}, ${job.id}, ${trigger}, ${ok ? "success" : "failed"}, ${attempts}, ${httpStatus}, ${durationMs},
                ${error}, ${response}, ${scheduledAt}, ${startedAt}, ${finishedAt})`;
      await tx`
        delete from mybase.cron_runs where job_id = ${job.id} and id not in (
          select id from mybase.cron_runs where job_id = ${job.id} order by started_at desc limit ${HISTORY})`;
    });
  } catch (err) {
    // 23503: the job was deleted mid-run, so there's nothing to record it against.
    if ((err as { errno?: string }).errno === "23503") runLog.debug("run not recorded, job deleted");
    else runLog.error("run not recorded", { err });
  }
}

// The cron service: per-project jobs that POST a signed request to a URL on a schedule.
// Jobs live in the control schema (control.ts); cron-scheduler.ts runs them.
import {
  CRON_DEFAULTS,
  CRON_JOB_NAME_PATTERN,
  CRON_JOB_NAME_RULES,
  type CronJob,
  type CronJobSource,
  type CronJobSpec,
  type CronOverview,
  type CronRunRecord,
  type CronSecret,
  type SyncCronJobsResponse,
} from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import type { TransactionSQL } from "bun";
import { cronFor, loadJobs, nextRunAt, runJob, schedule, unschedule, type ScheduledJob } from "./cron-scheduler";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";

const newSecret = () => `mbcron_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;

export const cronService: ServiceModule = {
  id: "cron",
  async enable(project, log) {
    await sql`insert into mybase.cron_projects (project, secret) values (${project}, ${newSecret()}) on conflict do nothing`;
    log.info("cron enabled");
  },
  async disable(project, log) {
    const jobs: { id: string }[] = await sql`select id from mybase.cron_jobs where project = ${project}`;
    for (const { id } of jobs) unschedule(id);
    // Cascades to jobs and run history.
    await sql`delete from mybase.cron_projects where project = ${project}`;
    log.info("cron disabled", { jobs: jobs.length });
  },
};

async function requireEnabled(project: string) {
  const rows = await sql`select 1 from mybase.cron_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("cron is not enabled for this project");
}

// ---- validation -------------------------------------------------------------

const MAX_PAYLOAD_BYTES = 16 * 1024;

/** A whole job spec, defaults applied. */
type FullSpec = Required<Omit<CronJobSpec, "payload">> & { payload: unknown };

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestError(`${field} is required`);
  return value.trim();
}

function jobName(value: unknown): string {
  const name = str(value, "name");
  if (!CRON_JOB_NAME_PATTERN.test(name)) throw new BadRequestError(`invalid job name "${name}". ${CRON_JOB_NAME_RULES}`);
  return name;
}

/** Checks the fields together, since a schedule is only valid in a time zone. */
function validateSpec(spec: FullSpec): FullSpec {
  try {
    new Intl.DateTimeFormat("en", { timeZone: spec.timezone });
  } catch {
    throw new BadRequestError(`unknown time zone "${spec.timezone}"`);
  }
  try {
    cronFor(spec.schedule, spec.timezone, { paused: true }).stop();
  } catch (err) {
    throw new BadRequestError(`invalid schedule "${spec.schedule}": ${(err as Error).message.replace(/\.+$/, "")}. Use 5 fields: minute hour day month weekday`);
  }
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    throw new BadRequestError(`invalid url "${spec.url}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError("url must start with http:// or https://");
  if (spec.payload !== null && JSON.stringify(spec.payload).length > MAX_PAYLOAD_BYTES) {
    throw new BadRequestError(`payload must be at most ${MAX_PAYLOAD_BYTES / 1024} KB of JSON`);
  }
  intIn(spec.timeoutMs, "timeoutMs", 1000, 120_000);
  intIn(spec.retries, "retries", 0, 5);
  return spec;
}

/** Reads the spec fields of a request body over `base`. Absent fields keep `base`'s value. */
function readSpec(body: Record<string, unknown>, base: FullSpec): FullSpec {
  return validateSpec({
    schedule: "schedule" in body ? str(body.schedule, "schedule").replace(/\s+/g, " ") : base.schedule,
    url: "url" in body ? str(body.url, "url") : base.url,
    timezone: "timezone" in body ? str(body.timezone, "timezone") : base.timezone,
    payload: "payload" in body ? (body.payload ?? null) : base.payload,
    timeoutMs: "timeoutMs" in body ? (body.timeoutMs as number) : base.timeoutMs,
    retries: "retries" in body ? (body.retries as number) : base.retries,
  });
}

const EMPTY_SPEC: FullSpec = { schedule: "", url: "", payload: null, ...CRON_DEFAULTS };

// ---- rows -------------------------------------------------------------------

interface JobRow extends ScheduledJob {
  source: CronJobSource;
  createdAt: Date;
  updatedAt: Date;
  lastStatus: "success" | "failed" | null;
  lastHttpStatus: number | null;
  lastFinishedAt: Date | null;
}

async function jobRows(project: string, name: string | null = null): Promise<JobRow[]> {
  const rows: (Omit<JobRow, "payload"> & { payload: string | null })[] = await sql`
    select j.id, j.project, j.name, j.schedule, j.timezone, j.url, j.payload::text as payload,
           j.timeout_ms as "timeoutMs", j.retries, j.enabled, j.source,
           j.created_at as "createdAt", j.updated_at as "updatedAt",
           r.status as "lastStatus", r.http_status as "lastHttpStatus", r.finished_at as "lastFinishedAt"
    from mybase.cron_jobs j
    left join lateral (
      select status, http_status, finished_at from mybase.cron_runs where job_id = j.id order by started_at desc limit 1
    ) r on true
    where j.project = ${project} and (${name}::text is null or j.name = ${name})
    order by j.name`;
  return rows.map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) }));
}

const toJob = (r: JobRow): CronJob => ({
  name: r.name,
  schedule: r.schedule,
  timezone: r.timezone,
  url: r.url,
  payload: r.payload,
  timeoutMs: r.timeoutMs,
  retries: r.retries,
  enabled: r.enabled,
  source: r.source,
  nextRunAt: nextRunAt(r.id)?.toISOString() ?? null,
  lastRun: r.lastStatus && r.lastFinishedAt ? { status: r.lastStatus, httpStatus: r.lastHttpStatus, finishedAt: r.lastFinishedAt.toISOString() } : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function jobRow(project: string, name: string): Promise<JobRow> {
  const [row] = await jobRows(project, name);
  if (!row) throw new NotFoundError(`no cron job "${name}"`);
  return row;
}

const isUniqueViolation = (err: unknown) => (err as { errno?: string }).errno === "23505";
const payloadParam = (payload: unknown) => (payload === null || payload === undefined ? null : JSON.stringify(payload));

/** Starts, restarts, or stops the timer to match the job's current row. */
async function refresh(project: string, name: string) {
  const [row] = await jobRows(project, name);
  if (row) schedule(row);
}

// ---- jobs -------------------------------------------------------------------

export async function listJobs(project: string): Promise<CronJob[]> {
  await requireEnabled(project);
  return (await jobRows(project)).map(toJob);
}

export async function getJob(project: string, name: string): Promise<CronJob> {
  await requireEnabled(project);
  return toJob(await jobRow(project, name));
}

export async function createJob(project: string, body: Record<string, unknown>, log: Logger): Promise<CronJob> {
  await requireEnabled(project);
  const name = jobName(body.name);
  const spec = readSpec(body, EMPTY_SPEC);
  const enabled = body.enabled ?? true;
  if (typeof enabled !== "boolean") throw new BadRequestError("enabled must be true or false");
  try {
    await sql`
      insert into mybase.cron_jobs (project, name, schedule, timezone, url, payload, timeout_ms, retries, enabled, source)
      values (${project}, ${name}, ${spec.schedule}, ${spec.timezone}, ${spec.url}, ${payloadParam(spec.payload)}::text::jsonb,
              ${spec.timeoutMs}, ${spec.retries}, ${enabled}, 'dashboard')`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`a cron job named "${name}" already exists`);
    throw err;
  }
  await refresh(project, name);
  log.info("cron job created", { job: name });
  return getJob(project, name);
}

export async function updateJob(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<CronJob> {
  await requireEnabled(project);
  const row = await jobRow(project, name);
  if ("enabled" in body && typeof body.enabled !== "boolean") throw new BadRequestError("enabled must be true or false");
  const enabled = (body.enabled as boolean | undefined) ?? row.enabled;

  // Code jobs are owned by mybase.config.ts; only pausing is allowed here.
  const edits = Object.keys(body).filter((k) => k !== "enabled");
  if (row.source === "code" && edits.length > 0) {
    throw new ConflictError(`"${name}" is managed in code. Edit mybase.config.ts and run \`mybase cron sync\`, or only change enabled`);
  }
  const newName = "name" in body ? jobName(body.name) : name;
  const spec = readSpec(body, row);
  try {
    await sql`
      update mybase.cron_jobs set
        name = ${newName}, schedule = ${spec.schedule}, timezone = ${spec.timezone}, url = ${spec.url},
        payload = ${payloadParam(spec.payload)}::text::jsonb, timeout_ms = ${spec.timeoutMs}, retries = ${spec.retries},
        enabled = ${enabled}, updated_at = now()
      where id = ${row.id}`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`a cron job named "${newName}" already exists`);
    throw err;
  }
  unschedule(row.id);
  await refresh(project, newName);
  log.info("cron job updated", { job: newName, renamedFrom: newName === name ? undefined : name, enabled });
  return getJob(project, newName);
}

export async function deleteJob(project: string, name: string, log: Logger) {
  await requireEnabled(project);
  const row = await jobRow(project, name);
  unschedule(row.id);
  await sql`delete from mybase.cron_jobs where id = ${row.id}`;
  log.info("cron job deleted", { job: name });
}

/** Starts a run now, in the background. Works on paused jobs too. */
export async function runNow(project: string, name: string, log: Logger): Promise<string> {
  await requireEnabled(project);
  const row = await jobRow(project, name);
  const runId = crypto.randomUUID();
  void runJob(row, "manual", new Date(), runId);
  log.info("cron job run requested", { job: name, run: runId.slice(0, 8) });
  return runId;
}

export async function listRuns(project: string, name: string, limit: number): Promise<CronRunRecord[]> {
  await requireEnabled(project);
  const row = await jobRow(project, name);
  const rows: (Omit<CronRunRecord, "scheduledAt" | "startedAt" | "finishedAt"> & { scheduledAt: Date; startedAt: Date; finishedAt: Date })[] = await sql`
    select id, trigger, status, attempts, http_status as "httpStatus", duration_ms as "durationMs", error, response,
           scheduled_at as "scheduledAt", started_at as "startedAt", finished_at as "finishedAt"
    from mybase.cron_runs where job_id = ${row.id}
    order by started_at desc limit ${limit}`;
  return rows.map((r) => ({
    ...r,
    scheduledAt: r.scheduledAt.toISOString(),
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt.toISOString(),
  }));
}

/** Job count and the soonest next run, for the project page. */
export async function overview(project: string): Promise<CronOverview> {
  await requireEnabled(project);
  const rows: { id: string; enabled: boolean }[] = await sql`select id, enabled from mybase.cron_jobs where project = ${project}`;
  const next = rows
    .map((r) => nextRunAt(r.id))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return { jobs: rows.length, enabled: rows.filter((r) => r.enabled).length, nextRunAt: next?.toISOString() ?? null };
}

// ---- sync (jobs defined in code) --------------------------------------------

const sameSpec = (a: FullSpec, b: FullSpec) =>
  a.schedule === b.schedule &&
  a.url === b.url &&
  a.timezone === b.timezone &&
  a.timeoutMs === b.timeoutMs &&
  a.retries === b.retries &&
  JSON.stringify(a.payload) === JSON.stringify(b.payload);

/**
 * Makes the project's code-defined jobs match `input`: creates new ones, updates changed ones,
 * deletes ones no longer listed. Keeps each existing job's `enabled`. Dashboard jobs are untouched,
 * and a name already used by one is a conflict.
 */
export async function syncJobs(project: string, input: unknown, dryRun: boolean, log: Logger): Promise<SyncCronJobsResponse> {
  await requireEnabled(project);
  if (!Array.isArray(input)) throw new BadRequestError("jobs must be an array");
  const wanted = new Map<string, FullSpec>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) throw new BadRequestError("each job must be an object");
    const body = item as Record<string, unknown>;
    const name = jobName(body.name);
    if (wanted.has(name)) throw new BadRequestError(`job "${name}" is listed twice`);
    try {
      wanted.set(name, readSpec(body, EMPTY_SPEC));
    } catch (err) {
      if (err instanceof BadRequestError) throw new BadRequestError(`job "${name}": ${err.message}`);
      throw err;
    }
  }

  const result: SyncCronJobsResponse = { created: [], updated: [], deleted: [], unchanged: [] };
  const apply = async (tx: TransactionSQL | null) => {
    const existing = await jobRows(project);
    const byName = new Map(existing.map((r) => [r.name, r]));
    for (const [name, spec] of wanted) {
      const row = byName.get(name);
      if (row && row.source === "dashboard") {
        throw new ConflictError(`"${name}" already exists as a dashboard job. Rename or delete it first`);
      }
      if (!row) {
        result.created.push(name);
        if (tx) await tx`
          insert into mybase.cron_jobs (project, name, schedule, timezone, url, payload, timeout_ms, retries, source)
          values (${project}, ${name}, ${spec.schedule}, ${spec.timezone}, ${spec.url}, ${payloadParam(spec.payload)}::text::jsonb,
                  ${spec.timeoutMs}, ${spec.retries}, 'code')`;
      } else if (sameSpec(row, spec)) {
        result.unchanged.push(name);
      } else {
        result.updated.push(name);
        if (tx) await tx`
          update mybase.cron_jobs set
            schedule = ${spec.schedule}, timezone = ${spec.timezone}, url = ${spec.url}, payload = ${payloadParam(spec.payload)}::text::jsonb,
            timeout_ms = ${spec.timeoutMs}, retries = ${spec.retries}, updated_at = now()
          where id = ${row.id}`;
      }
    }
    for (const row of existing) {
      if (row.source !== "code" || wanted.has(row.name)) continue;
      result.deleted.push(row.name);
      if (tx) await tx`delete from mybase.cron_jobs where id = ${row.id}`;
    }
  };

  if (dryRun) {
    await apply(null);
    return result;
  }
  const before = await jobRows(project);
  await sql.begin((tx) => apply(tx));
  for (const row of before) unschedule(row.id);
  for (const job of await loadJobs(project)) schedule(job);
  log.info("cron jobs synced", {
    created: result.created.length,
    updated: result.updated.length,
    deleted: result.deleted.length,
    unchanged: result.unchanged.length,
  });
  return result;
}

// ---- secret -----------------------------------------------------------------

export async function getSecret(project: string): Promise<CronSecret> {
  const [row]: { secret: string; rotatedAt: Date }[] = await sql`
    select secret, rotated_at as "rotatedAt" from mybase.cron_projects where project = ${project}`;
  if (!row) throw new NotFoundError("cron is not enabled for this project");
  return { secret: row.secret, rotatedAt: row.rotatedAt.toISOString() };
}

/** Replaces the secret. The old one stops signing at once. */
export async function rotateSecret(project: string, log: Logger): Promise<CronSecret> {
  const rows = await sql`update mybase.cron_projects set secret = ${newSecret()}, rotated_at = now() where project = ${project} returning 1`;
  if (rows.length === 0) throw new NotFoundError("cron is not enabled for this project");
  log.info("cron secret rotated");
  return getSecret(project);
}

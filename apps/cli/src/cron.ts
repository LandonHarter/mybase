// `mybase cron …`: jobs that call an app's endpoint on a schedule.
import { resolve } from "node:path";
import type { CronJob, CronRunRecord, CronSecret, CronTask, RunCronJobResponse, SyncCronJobsRequest, SyncCronJobsResponse } from "@mybase/shared";
import { parseDelay } from "@mybase/sdk/cron";
import { api } from "./api";

export const cronUsage = `  cron enable <project>          Turn on cron for a project and print its signing secret
  cron disable <project> [--yes] Turn it off, deleting every job and its history
  cron list <project>            List jobs
  cron create <project> <name> --schedule "<cron>" --url <url>
         [--tz <zone>] [--retries <n>] [--timeout <ms>] [--payload '<json>'] [--paused]
  cron delete <project> <name>   Delete a job
  cron run <project> <name>      Run a job now
  cron runs <project> <name>     Show a job's recent runs
  cron tasks <project> [--status <status>]  List one-off tasks (newest first)
  cron schedule <project> <job> --url <url> [--in 15m | --at <iso date>]
         [--key <key>] [--payload '<json>'] [--retries <n>] [--timeout <ms>]
                                 Call <job> once (apps do this with createCronClient)
  cron cancel <project> <task id | --key <key>>  Cancel a pending task
  cron secret <project> [--rotate]  Show (or replace) the signing secret
  cron sync [--config <file>] [--dry-run]  Make code-defined jobs match mybase.config.ts`;

/** Splits `--flag value` / `--flag` pairs from positional args. */
export function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else flags.set(arg.slice(2), true);
  }
  return { positional, flags };
}

export function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} needs a value`);
  return value;
}

export function flagInt(flags: Map<string, string | true>, name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

const jobPath = (project: string, name?: string) =>
  `/projects/${encodeURIComponent(project)}/cron/jobs${name ? `/${encodeURIComponent(name)}` : ""}`;

export function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}`);
  return value;
}

const taskPath = (project: string, id?: string) =>
  `/projects/${encodeURIComponent(project)}/cron/tasks${id ? `/${encodeURIComponent(id)}` : ""}`;

function flagJson(flags: Map<string, string | true>, name: string): unknown {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be JSON`);
  }
}

function printTask(t: CronTask) {
  const result = t.status === "success" || t.status === "failed" ? `${t.httpStatus ?? "-"} ${t.attempts} attempt${t.attempts === 1 ? "" : "s"}` : "";
  console.log([t.id, t.job, t.status, t.runAt, t.key ?? "-", result, t.error ?? ""].join("\t").trimEnd());
}

function printSecret({ secret }: CronSecret) {
  console.log(`Signing secret:\n  ${secret}\n`);
  console.log("Set it in your app, then verify calls with @mybase/sdk/cron:");
  console.log(`  MYBASE_CRON_SECRET=${secret}`);
}

/** Returns false for an unknown subcommand, so the caller prints usage. */
export async function cron(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, name] = positional;

  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      await api(`/projects/${encodeURIComponent(p)}/services/cron`, { method: "PUT" });
      console.log(`Cron enabled for "${p}"\n`);
      printSecret(await api<CronSecret>(`/projects/${encodeURIComponent(p)}/cron/secret`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      if (!flags.has("yes")) {
        console.log(`This deletes every cron job of "${p}" and its run history.`);
        if (prompt("Type the project name to confirm:") !== p) throw new Error("confirmation did not match, nothing changed");
      }
      await api(`/projects/${encodeURIComponent(p)}/services/cron`, { method: "DELETE" });
      console.log(`Cron disabled for "${p}"`);
      return true;
    }
    case "list": {
      const jobs = await api<CronJob[]>(jobPath(need(project, "project name")));
      if (jobs.length === 0) console.log("No cron jobs yet.");
      for (const j of jobs) {
        const next = j.enabled ? (j.nextRunAt ?? "-") : "paused";
        const last = j.lastRun ? `${j.lastRun.status}${j.lastRun.httpStatus ? ` ${j.lastRun.httpStatus}` : ""}` : "never run";
        console.log(`${j.name}\t${j.schedule}${j.timezone === "UTC" ? "" : ` (${j.timezone})`}\tnext ${next}\t${last}\t${j.source}\t${j.url}`);
      }
      return true;
    }
    case "create": {
      const payload = flagJson(flags, "payload");
      const job = await api<CronJob>(jobPath(need(project, "project name")), {
        method: "POST",
        body: JSON.stringify({
          name: need(name, "job name"),
          schedule: need(flagString(flags, "schedule"), "--schedule"),
          url: need(flagString(flags, "url"), "--url"),
          timezone: flagString(flags, "tz"),
          retries: flagInt(flags, "retries"),
          timeoutMs: flagInt(flags, "timeout"),
          payload,
          enabled: !flags.has("paused"),
        }),
      });
      console.log(`Created cron job "${job.name}" (${job.schedule} ${job.timezone})`);
      console.log(job.nextRunAt ? `Next run: ${job.nextRunAt}` : "Paused");
      return true;
    }
    case "delete": {
      await api(jobPath(need(project, "project name"), need(name, "job name")), { method: "DELETE" });
      console.log(`Deleted cron job "${name}"`);
      return true;
    }
    case "run": {
      const { runId } = await api<RunCronJobResponse>(`${jobPath(need(project, "project name"), need(name, "job name"))}/run`, { method: "POST" });
      console.log(`Started run ${runId}. See it with: mybase cron runs ${project} ${name}`);
      return true;
    }
    case "runs": {
      const runs = await api<CronRunRecord[]>(`${jobPath(need(project, "project name"), need(name, "job name"))}/runs?limit=20`);
      if (runs.length === 0) console.log("No runs yet.");
      for (const r of runs) {
        const http = r.httpStatus ?? "-";
        console.log(`${r.startedAt}\t${r.trigger}\t${r.status}\t${http}\t${r.attempts} attempt${r.attempts === 1 ? "" : "s"}\t${r.durationMs} ms${r.error ? `\t${r.error}` : ""}`);
      }
      return true;
    }
    case "tasks": {
      const status = flagString(flags, "status");
      const tasks = await api<CronTask[]>(`${taskPath(need(project, "project name"))}${status ? `?status=${encodeURIComponent(status)}` : ""}`);
      if (tasks.length === 0) console.log("No tasks.");
      tasks.forEach(printTask);
      return true;
    }
    case "schedule": {
      const delay = flagString(flags, "in");
      const at = flagString(flags, "at");
      if (delay !== undefined && at !== undefined) throw new Error("give --in or --at, not both");
      const res = await fetchTask(need(project, "project name"), {
        job: need(name, "job name"),
        url: need(flagString(flags, "url"), "--url"),
        delayMs: delay === undefined ? undefined : parseDelay(delay),
        runAt: at,
        key: flagString(flags, "key"),
        payload: flagJson(flags, "payload"),
        retries: flagInt(flags, "retries"),
        timeoutMs: flagInt(flags, "timeout"),
      });
      console.log(res.created ? `Scheduled task ${res.task.id} for ${res.task.runAt}` : `A task with key "${res.task.key}" is already ${res.task.status}: ${res.task.id}`);
      return true;
    }
    case "cancel": {
      const p = need(project, "project name");
      const key = flagString(flags, "key");
      const ref = key !== undefined ? `by-key/${encodeURIComponent(key)}` : encodeURIComponent(need(name, "task id (or --key)"));
      const task = await api<CronTask>(`${taskPath(p)}/${ref}`, { method: "DELETE" });
      console.log(`Cancelled task ${task.id} (${task.job}, was due ${task.runAt})`);
      return true;
    }
    case "secret": {
      const p = need(project, "project name");
      const base = `/projects/${encodeURIComponent(p)}/cron/secret`;
      if (flags.has("rotate")) {
        const secret = await api<CronSecret>(`${base}/rotate`, { method: "POST" });
        console.log("Rotated. The old secret no longer signs calls; update your app.\n");
        printSecret(secret);
      } else printSecret(await api<CronSecret>(base));
      return true;
    }
    case "sync": {
      await sync(flagString(flags, "config") ?? "mybase.config.ts", flags.has("dry-run"));
      return true;
    }
  }
  return false;
}

/** Creates a task; tells a new one apart from an existing one with the same key (201 vs 200). */
async function fetchTask(project: string, body: Record<string, unknown>): Promise<{ task: CronTask; created: boolean }> {
  let created = false;
  const task = await api<CronTask>(taskPath(project), { method: "POST", body: JSON.stringify(body), onStatus: (s) => (created = s === 201) });
  return { task, created };
}

/** The parts of a mybase.config.ts sync reads (see `defineConfig` in @mybase/sdk/config). */
export interface ConfigFile {
  project: string;
  cron?: { baseUrl?: unknown; jobs?: Record<string, Record<string, unknown>> };
  ratelimit?: { rules?: Record<string, Record<string, unknown>> };
}

/** Imports a mybase.config.ts (or .js) and checks it names a project. */
export async function readConfigFile(file: string): Promise<ConfigFile> {
  const path = resolve(file);
  if (!(await Bun.file(path).exists())) throw new Error(`no config at ${path}`);
  const config = (await import(path)).default as Partial<ConfigFile> | undefined;
  if (typeof config?.project !== "string") throw new Error(`${file} must default-export defineConfig({ project, … })`);
  return config as ConfigFile;
}

/** Prints a sync result: counts, then + created, ~ updated, - deleted. */
export function printSync(project: string, dryRun: boolean, result: SyncCronJobsResponse) {
  const lines = [
    ...result.created.map((n) => `  + ${n}`),
    ...result.updated.map((n) => `  ~ ${n}`),
    ...result.deleted.map((n) => `  - ${n}`),
  ];
  console.log(`${dryRun ? "Would sync" : "Synced"} ${project}: ${result.created.length} created, ${result.updated.length} updated, ${result.deleted.length} deleted, ${result.unchanged.length} unchanged`);
  if (lines.length) console.log(lines.join("\n"));
}

async function sync(file: string, dryRun: boolean) {
  const config = await readConfigFile(file);
  const { baseUrl, jobs = {} } = config.cron ?? {};
  if (config.cron && typeof baseUrl !== "string") throw new Error("cron.baseUrl must be a string");

  const body: SyncCronJobsRequest = {
    dryRun,
    jobs: Object.entries(jobs).map(([name, job]) => ({
      name,
      schedule: job.schedule as string,
      // Concatenated, not new URL(path, base), so a base path like https://x.dev/app is kept.
      url: `${(baseUrl as string).replace(/\/+$/, "")}/${((job.path as string | undefined) ?? "/api/cron").replace(/^\/+/, "")}`,
      timezone: job.timezone as string | undefined,
      payload: job.payload,
      retries: job.retries as number | undefined,
      timeoutMs: job.timeoutMs as number | undefined,
    })),
  };
  printSync(config.project, dryRun, await api<SyncCronJobsResponse>(jobPath(config.project), { method: "PUT", body: JSON.stringify(body) }));
}

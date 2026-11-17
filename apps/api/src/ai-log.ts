// The AI gateway's request log, hourly rollups, and month-to-date spend.
//
// Rows are buffered in memory and written as one insert every 10 s or 500 rows (SD card), like
// analytics events; captured content goes in right after its rows. Hourly rollups are counted in
// memory and upserted every 5 minutes (and before usage reads). Spend per project is kept in
// memory for budgets, loaded from the rollups at boot. Never logs prompts, responses, or keys.
import type { AiCostSource, AiEndpoint } from "@mybase-dev/sdk/ai";
import { createLogger } from "@mybase/shared/logger";
import { sql } from "./postgres";

const log = createLogger("ai");

export interface LogRow {
  id: string;
  project: string;
  at: Date;
  endpoint: AiEndpoint;
  provider: string | null;
  model: string | null;
  alias: string | null;
  status: number;
  error: string | null;
  stream: boolean;
  cached: boolean;
  latency_ms: number;
  ttfb_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  images: number;
  cost_usd: number | null;
  cost_source: AiCostSource | null;
  token_name: string | null;
  user_tag: string | null;
  /** A Postgres array literal (`pgArray`): bulk inserts don't encode JS arrays. */
  tags: string;
  fallback_from: string | null;
  request_id: string | null;
}

export interface ContentRow {
  request_id: string;
  project: string;
  at: Date;
  request: Buffer | null;
  response: Buffer | null;
}

const FLUSH_EVERY_MS = 10_000;
const FLUSH_AT = 500;
const MAX_BUFFERED = 10_000;
const ROLLUP_EVERY_MS = 5 * 60_000;

let rows: LogRow[] = [];
let contents: ContentRow[] = [];
let flushing: Promise<void> | null = null;
let dropped = 0;

/** `{"a","b"}`, for text[] columns in bulk inserts. */
export const pgArray = (items: string[]) => `{${items.map((t) => `"${t.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;

// ---- spend ------------------------------------------------------------------

const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
let month = monthOf();
const spend = new Map<string, number>();

function rollMonth() {
  const now = monthOf();
  if (now !== month) {
    month = now;
    spend.clear();
  }
}

/** USD spent this calendar month (UTC), including unwritten rows. */
export function monthToDate(project: string): number {
  rollMonth();
  return spend.get(project) ?? 0;
}

export const currentMonth = () => {
  rollMonth();
  return month;
};

// ---- rollups ----------------------------------------------------------------

type Rollup = { requests: number; errors: number; input: number; output: number; cached: number; cost: number; unpriced: number; latency_ms: number };
let pending = new Map<string, Rollup>();

function countRollup(row: LogRow) {
  const hour = new Date(Math.floor(row.at.getTime() / 3_600_000) * 3_600_000).toISOString();
  const key = [row.project, hour, row.provider ?? "-", row.model ?? "-"].join("\0");
  const r = pending.get(key) ?? { requests: 0, errors: 0, input: 0, output: 0, cached: 0, cost: 0, unpriced: 0, latency_ms: 0 };
  r.requests++;
  if (row.status >= 400) r.errors++;
  r.input += row.input_tokens;
  r.output += row.output_tokens;
  r.cached += row.cache_read_tokens;
  r.cost += row.cost_usd ?? 0;
  if (row.cost_usd === null && row.status < 400 && !row.cached) r.unpriced++;
  r.latency_ms += row.latency_ms;
  pending.set(key, r);
}

/** Writes counted rollups. On a timer, before usage reads, and on shutdown. */
export async function flushRollups() {
  if (pending.size === 0) return;
  const batch = [...pending].map(([key, r]) => {
    const [project, hour, provider, model] = key.split("\0");
    return { project: project!, hour: new Date(hour!), provider: provider!, model: model!, ...r };
  });
  pending = new Map();
  const upsert = (items: typeof batch) => sql`
    insert into mybase.ai_usage_hourly ${sql(items)}
    on conflict (project, hour, provider, model) do update set
      requests = ai_usage_hourly.requests + excluded.requests, errors = ai_usage_hourly.errors + excluded.errors,
      input = ai_usage_hourly.input + excluded.input, output = ai_usage_hourly.output + excluded.output,
      cached = ai_usage_hourly.cached + excluded.cached, cost = ai_usage_hourly.cost + excluded.cost,
      unpriced = ai_usage_hourly.unpriced + excluded.unpriced, latency_ms = ai_usage_hourly.latency_ms + excluded.latency_ms`;
  try {
    try {
      await upsert(batch);
    } catch (err) {
      if ((err as { errno?: string }).errno !== "23503") throw err;
      const live = await liveProjects(batch.map((b) => b.project));
      const keep = batch.filter((b) => live.has(b.project));
      if (keep.length) await upsert(keep);
    }
  } catch (err) {
    log.error("ai usage rollups not written", { rows: batch.length, err });
  }
}

async function liveProjects(projects: string[]): Promise<Set<string>> {
  const unique = [...new Set(projects)];
  const live: { project: string }[] = await sql`select project from mybase.ai_projects where project in ${sql(unique)}`;
  return new Set(live.map((r) => r.project));
}

// ---- log buffer -------------------------------------------------------------

/** Records one call. `content` only when the project captures it. */
export function pushLog(row: LogRow, content?: ContentRow) {
  rollMonth();
  if (row.cost_usd) spend.set(row.project, (spend.get(row.project) ?? 0) + row.cost_usd);
  countRollup(row);
  if (rows.length >= MAX_BUFFERED) {
    if (dropped++ % 1000 === 0) log.warn("ai log buffer full, dropping rows", { dropped });
    return;
  }
  rows.push(row);
  if (content) contents.push(content);
  if (rows.length >= FLUSH_AT) void flushAi();
}

/** Writes everything buffered. Safe to call any time. */
export async function flushAi(): Promise<void> {
  while (flushing) await flushing;
  if (rows.length === 0) return;
  const batch = rows;
  const content = contents;
  rows = [];
  contents = [];
  flushing = write(batch, content).finally(() => {
    flushing = null;
  });
  await flushing;
}

async function write(batch: LogRow[], content: ContentRow[]) {
  try {
    let written = batch;
    try {
      for (let i = 0; i < batch.length; i += 500) await sql`insert into mybase.ai_requests ${sql(batch.slice(i, i + 500))} on conflict do nothing`;
    } catch (err) {
      // The project turned the gateway off (or was deleted) since these were buffered.
      if ((err as { errno?: string }).errno !== "23503") throw err;
      const live = await liveProjects(batch.map((r) => r.project));
      written = batch.filter((r) => live.has(r.project));
      for (let i = 0; i < written.length; i += 500) await sql`insert into mybase.ai_requests ${sql(written.slice(i, i + 500))} on conflict do nothing`;
    }
    const ids = new Set(written.map((r) => r.id));
    const keep = content.filter((c) => ids.has(c.request_id));
    for (let i = 0; i < keep.length; i += 50) await sql`insert into mybase.ai_content ${sql(keep.slice(i, i + 50))} on conflict do nothing`;
  } catch (err) {
    log.error("ai log rows not written", { rows: batch.length, err });
  }
}

/** Forgets buffered rows of a project whose gateway was just turned off. */
export function dropBuffered(project: string) {
  rows = rows.filter((r) => r.project !== project);
  contents = contents.filter((c) => c.project !== project);
  for (const key of pending.keys()) if (key.startsWith(`${project}\0`)) pending.delete(key);
  spend.delete(project);
}

// ---- lifecycle --------------------------------------------------------------

let timers: ReturnType<typeof setInterval>[] = [];

export async function startAiLog() {
  rollMonth();
  const rowsSpent: { project: string; cost: number }[] = await sql`
    select project, sum(cost)::float8 as cost from mybase.ai_usage_hourly
    where hour >= date_trunc('month', now(), 'UTC') group by project`;
  for (const r of rowsSpent) spend.set(r.project, (spend.get(r.project) ?? 0) + r.cost);
  if (timers.length) return;
  timers = [setInterval(() => void flushAi(), FLUSH_EVERY_MS), setInterval(() => void flushRollups(), ROLLUP_EVERY_MS), setInterval(() => void prune(), 3_600_000)];
  for (const t of timers) t.unref?.();
  void prune();
}

/** Drops request rows and captured content past each project's retention. Rollups stay 400 days. */
async function prune() {
  try {
    const requests = await sql`
      delete from mybase.ai_requests r using mybase.ai_projects p
      where r.project = p.project and r.at < now() - make_interval(days => p.log_retention_days)`;
    const content = await sql`
      delete from mybase.ai_content c using mybase.ai_projects p
      where c.project = p.project and c.at < now() - make_interval(days => p.content_retention_days)`;
    await sql`delete from mybase.ai_usage_hourly where hour < now() - interval '400 days'`;
    if (requests.count || content.count) log.info("ai logs pruned", { requests: requests.count, content: content.count });
  } catch (err) {
    log.warn("ai log prune failed", { err });
  }
}

export async function stopAiLog() {
  await Promise.allSettled([flushAi(), flushRollups()]);
}

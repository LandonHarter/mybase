// The rate limit service: apps ask "may <id> do this now?" against a named rule or an
// inline limit, and the answer comes from counters in Valkey (ratelimit-scripts.ts).
//
// Counters live under `mybase:rl:<project>:`, outside the project's cache prefix, so an app
// can't reset its own limits. Rules live in Postgres and are cached in memory, so a check
// costs one Valkey round trip and no Postgres query.
import {
  RATELIMIT_RULE_NAME_PATTERN,
  RATELIMIT_RULE_NAME_RULES,
  RATELIMIT_STATS_RANGES,
  type RateLimitAlgorithm,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitRuleSource,
  type RateLimitRuleSpec,
  type RateLimitRuleStats,
  type RateLimitSettings,
  type RateLimitStats,
  type RateLimitStatsRange,
  type SyncRateLimitRulesResponse,
} from "@mybase/shared";
import { parseWindow, RATELIMIT_ALGORITHMS, RATELIMIT_LIMITS } from "@mybase/sdk/ratelimit";
import type { Logger } from "@mybase/shared/logger";
import type { TransactionSQL } from "bun";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { SCRIPTS } from "./ratelimit-scripts";
import type { ServiceModule } from "./services";
import { isServerError, send, unlinkMatching } from "./valkey";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const counterPrefix = (project: string) => `mybase:rl:${project}:`;
const statsPrefix = (project: string) => `mybase:rlstats:${project}:`;
const INLINE = "_inline";

// ---- caches -----------------------------------------------------------------

/** Projects known to have the service on, so app calls skip a Postgres query. */
const enabled = new Set<string>();
/** Rules by project, then name. */
const ruleCache = new Map<string, Map<string, RateLimitRuleSpec>>();

function forget(project: string) {
  enabled.delete(project);
  ruleCache.delete(project);
}

// ---- service ----------------------------------------------------------------

export const ratelimitService: ServiceModule = {
  id: "ratelimit",
  async enable(project, log) {
    await sql`insert into mybase.ratelimit_projects (project) values (${project}) on conflict do nothing`;
    log.info("rate limits enabled");
  },
  async disable(project, log) {
    const counters = await unlinkMatching(`${counterPrefix(project)}*`);
    await unlinkMatching(`${statsPrefix(project)}*`);
    // Cascades to the rules.
    await sql`delete from mybase.ratelimit_projects where project = ${project}`;
    forget(project);
    log.info("rate limits disabled", { counters });
  },
};

export async function requireEnabled(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.ratelimit_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("rate limits are not enabled for this project");
  enabled.add(project);
}

export async function getSettings(project: string): Promise<RateLimitSettings> {
  const [row]: { createdAt: Date }[] = await sql`
    select created_at as "createdAt" from mybase.ratelimit_projects where project = ${project}`;
  if (!row) throw new NotFoundError("rate limits are not enabled for this project");
  return {
    apiUrl: publicApiUrl,
    limitUrl: `${publicApiUrl}/ratelimit/${project}/limit`,
    enabledAt: row.createdAt.toISOString(),
  };
}

// ---- validation -------------------------------------------------------------

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function ruleName(value: unknown): string {
  if (typeof value !== "string" || !RATELIMIT_RULE_NAME_PATTERN.test(value)) {
    throw new BadRequestError(`invalid rule name "${String(value ?? "")}". ${RATELIMIT_RULE_NAME_RULES}`);
  }
  return value;
}

function algorithm(value: unknown): RateLimitAlgorithm {
  if (!(RATELIMIT_ALGORITHMS as readonly unknown[]).includes(value)) throw new BadRequestError(`algorithm must be one of ${RATELIMIT_ALGORITHMS.join(", ")}`);
  return value as RateLimitAlgorithm;
}

function windowMs(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new BadRequestError('window is required: ms, or e.g. "10s", "1m", "1h"');
  try {
    return parseWindow(value);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }
}

/** Spec fields of a body over `base`. Absent fields keep `base`'s value. */
function readSpec(body: Record<string, unknown>, base: RateLimitRuleSpec | null): RateLimitRuleSpec {
  const { limit: limits } = RATELIMIT_LIMITS;
  const window = "window" in body ? body.window : "windowMs" in body ? body.windowMs : undefined;
  if (!base && body.limit === undefined) throw new BadRequestError("limit is required");
  if (!base && window === undefined) throw new BadRequestError('window is required: ms, or e.g. "10s", "1m", "1h"');
  const burst = "burst" in body ? body.burst : (base?.burst ?? null);
  return {
    algorithm: "algorithm" in body && body.algorithm !== undefined ? algorithm(body.algorithm) : (base?.algorithm ?? "sliding"),
    limit: body.limit !== undefined ? intIn(body.limit, "limit", limits.min, limits.max) : base!.limit,
    windowMs: window !== undefined ? windowMs(window) : base!.windowMs,
    burst: burst === null || burst === undefined ? null : intIn(burst, "burst", limits.min, limits.max),
  };
}

// ---- rules ------------------------------------------------------------------

interface RuleRow extends RateLimitRuleSpec {
  id: string;
  name: string;
  source: RateLimitRuleSource;
  createdAt: Date;
  updatedAt: Date;
}

async function ruleRows(project: string): Promise<RuleRow[]> {
  return sql`
    select id, name, algorithm, "limit", window_ms as "windowMs", burst, source, created_at as "createdAt", updated_at as "updatedAt"
    from mybase.ratelimit_rules where project = ${project} order by name`;
}

const toRule = (r: RuleRow): RateLimitRule => ({
  name: r.name,
  algorithm: r.algorithm,
  limit: r.limit,
  windowMs: r.windowMs,
  burst: r.burst,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function ruleRow(project: string, name: string): Promise<RuleRow> {
  const row = (await ruleRows(project)).find((r) => r.name === name);
  if (!row) throw new NotFoundError(`no rate limit rule "${name}"`);
  return row;
}

const isUniqueViolation = (err: unknown) => (err as { errno?: string }).errno === "23505";

export async function listRules(project: string): Promise<RateLimitRule[]> {
  await requireEnabled(project);
  return (await ruleRows(project)).map(toRule);
}

export async function createRule(project: string, body: Record<string, unknown>, log: Logger): Promise<RateLimitRule> {
  await requireEnabled(project);
  const name = ruleName(body.name);
  const spec = readSpec(body, null);
  try {
    await sql`
      insert into mybase.ratelimit_rules (project, name, algorithm, "limit", window_ms, burst, source)
      values (${project}, ${name}, ${spec.algorithm}, ${spec.limit}, ${spec.windowMs}, ${spec.burst}, 'dashboard')`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`a rule named "${name}" already exists`);
    throw err;
  }
  ruleCache.delete(project);
  log.info("rate limit rule created", { rule: name });
  return toRule(await ruleRow(project, name));
}

export async function updateRule(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<RateLimitRule> {
  await requireEnabled(project);
  const row = await ruleRow(project, name);
  if (row.source === "code") throw new ConflictError(`"${name}" is managed in code. Edit mybase.config.ts and run \`mybase ratelimit sync\``);
  const newName = "name" in body ? ruleName(body.name) : name;
  const spec = readSpec(body, row);
  try {
    await sql`
      update mybase.ratelimit_rules set name = ${newName}, algorithm = ${spec.algorithm}, "limit" = ${spec.limit},
        window_ms = ${spec.windowMs}, burst = ${spec.burst}, updated_at = now()
      where id = ${row.id}`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`a rule named "${newName}" already exists`);
    throw err;
  }
  ruleCache.delete(project);
  log.info("rate limit rule updated", { rule: newName, renamedFrom: newName === name ? undefined : name });
  return toRule(await ruleRow(project, newName));
}

export async function deleteRule(project: string, name: string, log: Logger) {
  await requireEnabled(project);
  const row = await ruleRow(project, name);
  if (row.source === "code") throw new ConflictError(`"${name}" is managed in code. Remove it from mybase.config.ts and run \`mybase ratelimit sync\``);
  await sql`delete from mybase.ratelimit_rules where id = ${row.id}`;
  ruleCache.delete(project);
  await unlinkMatching(`${counterPrefix(project)}${name}:*`);
  log.info("rate limit rule deleted", { rule: name });
}

const sameSpec = (a: RateLimitRuleSpec, b: RateLimitRuleSpec) =>
  a.algorithm === b.algorithm && a.limit === b.limit && a.windowMs === b.windowMs && a.burst === b.burst;

/**
 * Makes the project's code-defined rules match `input`, like `mybase cron sync`: creates,
 * updates, and deletes code rules. Dashboard rules are untouched; a name already used by
 * one is a conflict.
 */
export async function syncRules(project: string, input: unknown, dryRun: boolean, log: Logger): Promise<SyncRateLimitRulesResponse> {
  await requireEnabled(project);
  if (!Array.isArray(input)) throw new BadRequestError("rules must be an array");
  const wanted = new Map<string, RateLimitRuleSpec>();
  for (const item of input) {
    if (typeof item !== "object" || item === null) throw new BadRequestError("each rule must be an object");
    const body = item as Record<string, unknown>;
    const name = ruleName(body.name);
    if (wanted.has(name)) throw new BadRequestError(`rule "${name}" is listed twice`);
    try {
      wanted.set(name, readSpec(body, null));
    } catch (err) {
      if (err instanceof BadRequestError) throw new BadRequestError(`rule "${name}": ${err.message}`);
      throw err;
    }
  }

  const result: SyncRateLimitRulesResponse = { created: [], updated: [], deleted: [], unchanged: [] };
  const apply = async (tx: TransactionSQL | null) => {
    const existing = await ruleRows(project);
    const byName = new Map(existing.map((r) => [r.name, r]));
    for (const [name, spec] of wanted) {
      const row = byName.get(name);
      if (row && row.source === "dashboard") throw new ConflictError(`"${name}" already exists as a dashboard rule. Rename or delete it first`);
      if (!row) {
        result.created.push(name);
        if (tx) await tx`
          insert into mybase.ratelimit_rules (project, name, algorithm, "limit", window_ms, burst, source)
          values (${project}, ${name}, ${spec.algorithm}, ${spec.limit}, ${spec.windowMs}, ${spec.burst}, 'code')`;
      } else if (sameSpec(row, spec)) {
        result.unchanged.push(name);
      } else {
        result.updated.push(name);
        if (tx) await tx`
          update mybase.ratelimit_rules set algorithm = ${spec.algorithm}, "limit" = ${spec.limit}, window_ms = ${spec.windowMs},
            burst = ${spec.burst}, updated_at = now()
          where id = ${row.id}`;
      }
    }
    for (const row of existing) {
      if (row.source !== "code" || wanted.has(row.name)) continue;
      result.deleted.push(row.name);
      if (tx) await tx`delete from mybase.ratelimit_rules where id = ${row.id}`;
    }
  };

  if (dryRun) {
    await apply(null);
    return result;
  }
  await sql.begin((tx) => apply(tx));
  ruleCache.delete(project);
  for (const name of result.deleted) await unlinkMatching(`${counterPrefix(project)}${name}:*`);
  log.info("rate limit rules synced", {
    created: result.created.length,
    updated: result.updated.length,
    deleted: result.deleted.length,
    unchanged: result.unchanged.length,
  });
  return result;
}

// ---- checks -----------------------------------------------------------------

async function cachedRules(project: string): Promise<Map<string, RateLimitRuleSpec>> {
  let rules = ruleCache.get(project);
  if (!rules) {
    rules = new Map((await ruleRows(project)).map((r) => [r.name, { algorithm: r.algorithm, limit: r.limit, windowMs: r.windowMs, burst: r.burst }]));
    ruleCache.set(project, rules);
  }
  return rules;
}

/** Runs a script by hash, loading it first if Valkey doesn't have it (after a restart). */
async function evalScript(algo: RateLimitAlgorithm, key: string, args: (string | number)[]): Promise<[number, number, number]> {
  const { source, sha } = SCRIPTS[algo];
  try {
    return await send("EVALSHA", [sha, 1, key, ...args]);
  } catch (err) {
    if (!isServerError(err) || !/NOSCRIPT/.test((err as Error).message)) throw err;
    await send("SCRIPT", ["LOAD", source]);
    return send("EVALSHA", [sha, 1, key, ...args]);
  }
}

/**
 * One check, from an app (`POST /ratelimit/<project>/limit`) or the dashboard's test panel.
 * Body: `{ id, rule }` or `{ id, limit, windowMs, algorithm?, burst? }`, plus optional `cost`.
 */
export async function check(project: string, body: Record<string, unknown>): Promise<RateLimitResult> {
  if (typeof body.id !== "string" || !body.id || body.id.length > RATELIMIT_LIMITS.idLength) {
    throw new BadRequestError(`id must be a string of 1 to ${RATELIMIT_LIMITS.idLength} characters`);
  }
  const cost = body.cost === undefined ? 1 : intIn(body.cost, "cost", RATELIMIT_LIMITS.cost.min, RATELIMIT_LIMITS.cost.max);

  let spec: RateLimitRuleSpec;
  let bucket: string;
  if (body.rule !== undefined) {
    const name = ruleName(body.rule);
    const rule = (await cachedRules(project)).get(name);
    if (!rule) throw new NotFoundError(`no rate limit rule "${name}". Create it on the dashboard or in mybase.config.ts`);
    spec = rule;
    bucket = name;
  } else {
    spec = readSpec(body, null);
    // Inline limits with the same settings share counters; different settings don't.
    bucket = `${INLINE}:${spec.algorithm}-${spec.limit}-${spec.windowMs}-${spec.burst ?? ""}`;
  }

  const key = `${counterPrefix(project)}${bucket}:${body.id}`;
  const stats = `${statsPrefix(project)}${body.rule === undefined ? INLINE : bucket}`;
  const [allowed, remaining, reset] = await evalScript(spec.algorithm, key, [spec.limit, spec.windowMs, cost, spec.burst ?? spec.limit, stats]);
  return { success: allowed === 1, limit: spec.burst ?? spec.limit, remaining, reset };
}

// ---- stats ------------------------------------------------------------------

export function readStatsRange(value: string | null): RateLimitStatsRange {
  if (value === null) return "24h";
  if (!(RATELIMIT_STATS_RANGES as readonly string[]).includes(value)) throw new BadRequestError(`range must be one of ${RATELIMIT_STATS_RANGES.join(", ")}`);
  return value as RateLimitStatsRange;
}

/** Hourly allowed/blocked counts per rule (deleted rules included while their stats last). */
export async function stats(project: string, range: RateLimitStatsRange): Promise<RateLimitStats> {
  await requireEnabled(project);
  const hours = range === "24h" ? 24 : 168;
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const first = nowHour - hours + 1;
  const prefix = statsPrefix(project);

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await send<[string, string[]]>("SCAN", [cursor, "MATCH", `${prefix}*`, "COUNT", 1000]);
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");

  const byRule = new Map<string, Map<number, { allowed: number; blocked: number }>>();
  for (const rule of (await cachedRules(project)).keys()) byRule.set(rule, new Map());
  await Promise.all(
    keys.map(async (key) => {
      const rest = key.slice(prefix.length);
      const colon = rest.lastIndexOf(":");
      const rule = rest.slice(0, colon);
      const hour = Number(rest.slice(colon + 1));
      if (!rule || !Number.isInteger(hour) || hour < first) return;
      const raw = await send<Record<string, string> | string[]>("HGETALL", [key]);
      const fields = Array.isArray(raw) ? Object.fromEntries(raw.flatMap((v, i) => (i % 2 ? [] : [[v, raw[i + 1]]]))) : raw;
      if (!byRule.has(rule)) byRule.set(rule, new Map());
      byRule.get(rule)!.set(hour, { allowed: Number(fields.allowed ?? 0), blocked: Number(fields.blocked ?? 0) });
    }),
  );

  const rules: RateLimitRuleStats[] = [...byRule].map(([rule, points]) => {
    const series = Array.from({ length: hours }, (_, i) => {
      const p = points.get(first + i);
      return { t: new Date((first + i) * 3_600_000).toISOString(), allowed: p?.allowed ?? 0, blocked: p?.blocked ?? 0 };
    });
    return {
      rule,
      allowed: series.reduce((n, p) => n + p.allowed, 0),
      blocked: series.reduce((n, p) => n + p.blocked, 0),
      series,
    };
  });
  rules.sort((a, b) => b.allowed + b.blocked - (a.allowed + a.blocked) || a.rule.localeCompare(b.rule));
  return { range, rules };
}

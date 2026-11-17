// The AI gateway service (`ai`): per-project settings, providers, aliases, price overrides, the
// request log and usage reports. Calls themselves are in ai-gateway.ts.
//
// Provider keys are secrets (ai-keys.ts), so the gateway requires the secrets service. Prompts
// and responses are end-user data: only stored with capture on (sealed), never logged.
import {
  AI_ALIAS_PATTERN,
  AI_ALIAS_RULES,
  AI_LIMITS,
  AI_PROVIDER_ID_PATTERN,
  type AiAlias,
  type AiCostSource,
  type AiEndpoint,
  type AiLogDetail,
  type AiLogEntry,
  type AiLogsResponse,
  type AiModel,
  type AiPrice,
  type AiPriceOverride,
  type AiProviderStatus,
  type AiSettings,
  type AiUsageGroup,
  type AiUsageResponse,
  type SyncAiResponse,
} from "@mybase-dev/sdk/ai";
import { SECRET_KEY_PATTERN } from "@mybase-dev/sdk/secrets";
import type { ProjectContext } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { forgetKeys, keyNames, providerKeys } from "./ai-keys";
import { dropBuffered, flushAi, flushRollups, monthToDate, pgArray } from "./ai-log";
import { catalogModel, catalogPrice, currentCatalog, modelType, overrideFor } from "./ai-prices";
import { AI_PROVIDERS, BUILTIN_PROVIDER_IDS, baseUrlFor, customProvider, missingKeys, type ProviderDef } from "./ai-providers";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors";
import { sql } from "./postgres";
import { openBlob } from "./secrets-crypto";
import { secretsMaster } from "./secrets";
import type { ServiceModule } from "./services";
import { unlinkMatching } from "./valkey";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const aiBaseUrl = (project: string) => `${publicApiUrl}/ai/${project}/v1`;
export const aiNativeUrl = (project: string) => `${publicApiUrl}/ai/${project}/native`;
export const aiCachePrefix = (project: string) => `mybase:ai:${project}:`;

// ---- project config (cached) ------------------------------------------------

export interface ProjectConfig {
  keysEnv: string;
  captureContent: boolean;
  contentRetentionDays: number;
  logRetentionDays: number;
  budgetUsd: number | null;
  budgetSoftPct: number;
  budgetHard: boolean;
  budgetAlerted: string | null;
  allowedModels: string[] | null;
  ratelimitRule: string | null;
  ratelimitBy: "token" | "user";
  createdAt: Date;
  custom: ProviderDef[];
  aliases: Map<string, AiAlias>;
  overrides: AiPriceOverride[];
}

const configs = new Map<string, Promise<ProjectConfig>>();

export function forget(project: string) {
  configs.delete(project);
}

async function loadConfig(project: string): Promise<ProjectConfig> {
  const [row]: {
    keysEnv: string;
    captureContent: boolean;
    contentRetentionDays: number;
    logRetentionDays: number;
    budgetUsd: string | null;
    budgetSoftPct: number;
    budgetHard: boolean;
    budgetAlerted: string | null;
    allowedModels: string[] | null;
    ratelimitRule: string | null;
    ratelimitBy: "token" | "user";
    createdAt: Date;
  }[] = await sql`
    select keys_env as "keysEnv", capture_content as "captureContent", content_retention_days as "contentRetentionDays",
      log_retention_days as "logRetentionDays", budget_usd::text as "budgetUsd", budget_soft_pct as "budgetSoftPct", budget_hard as "budgetHard",
      budget_alerted as "budgetAlerted", allowed_models as "allowedModels", ratelimit_rule as "ratelimitRule", ratelimit_by as "ratelimitBy",
      created_at as "createdAt"
    from mybase.ai_projects where project = ${project}`;
  if (!row) throw new NotFoundError("the AI gateway is not enabled for this project");
  const [providers, aliases, overrides] = await Promise.all([
    sql`select id, name, base_url as "baseUrl", key_name as "keyName" from mybase.ai_providers where project = ${project} order by id` as Promise<
      { id: string; name: string; baseUrl: string; keyName: string | null }[]
    >,
    sql`select name, targets, source from mybase.ai_aliases where project = ${project} order by name` as Promise<AiAlias[]>,
    sql`
      select model, input::float8, output::float8, cache_read::float8 as "cacheRead", cache_write::float8 as "cacheWrite",
        per_image::float8 as "perImage", per_request::float8 as "perRequest"
      from mybase.ai_price_overrides where project = ${project} order by model` as Promise<Record<string, number | string | null>[]>,
  ]);
  return {
    ...row,
    budgetUsd: row.budgetUsd === null ? null : Number(row.budgetUsd),
    custom: providers.map(customProvider),
    aliases: new Map(aliases.map((a) => [a.name, a])),
    overrides: overrides.map(cleanOverride),
  };
}

/** Drops null price fields. */
function cleanOverride(row: Record<string, number | string | null>): AiPriceOverride {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
  return out as unknown as AiPriceOverride;
}

export async function projectConfig(project: string): Promise<ProjectConfig> {
  let cfg = configs.get(project);
  if (!cfg) {
    cfg = loadConfig(project);
    cfg.catch(() => configs.delete(project));
    configs.set(project, cfg);
  }
  return cfg;
}

export async function requireEnabled(project: string) {
  await projectConfig(project);
}

export const providersOf = (cfg: ProjectConfig): ProviderDef[] => [...Object.values(AI_PROVIDERS), ...cfg.custom];

export function findProvider(cfg: ProjectConfig, id: string): ProviderDef | null {
  return AI_PROVIDERS[id] ?? cfg.custom.find((p) => p.id === id) ?? null;
}

// ---- service ----------------------------------------------------------------

const DEFAULT_KEYS_ENV = "ai";

export const aiService: ServiceModule = {
  id: "ai",
  async enable(project, log) {
    // Secrets is on by now (SERVICE_REQUIRES); its `ai` env holds the provider keys.
    if (!secretsMaster()) throw new ServiceUnavailableError("the AI gateway keeps provider keys in secrets, which need MYBASE_SECRETS_KEY");
    await sql`insert into mybase.secrets_envs (project, name) values (${project}, ${DEFAULT_KEYS_ENV}) on conflict do nothing`;
    await sql`insert into mybase.ai_projects (project) values (${project}) on conflict do nothing`;
    forget(project);
    log.info("ai gateway enabled");
  },
  async disable(project, log) {
    // Logs, usage, aliases, and overrides cascade. The keys env stays in secrets (it's the user's data).
    await sql`delete from mybase.ai_projects where project = ${project}`;
    dropBuffered(project);
    forget(project);
    forgetKeys(project);
    const cleared = await unlinkMatching(`${aiCachePrefix(project)}*`).catch(() => 0);
    log.info("ai gateway disabled", { cleared });
  },
};

// ---- settings -----------------------------------------------------------------

export async function getSettings(project: string): Promise<AiSettings> {
  const cfg = await projectConfig(project);
  return {
    apiUrl: publicApiUrl,
    baseURL: aiBaseUrl(project),
    nativeBaseURL: aiNativeUrl(project),
    keysEnv: cfg.keysEnv,
    captureContent: cfg.captureContent,
    contentRetentionDays: cfg.contentRetentionDays,
    logRetentionDays: cfg.logRetentionDays,
    budgetUsd: cfg.budgetUsd,
    budgetSoftPct: cfg.budgetSoftPct,
    budgetHard: cfg.budgetHard,
    allowedModels: cfg.allowedModels,
    ratelimitRule: cfg.ratelimitRule,
    ratelimitBy: cfg.ratelimitBy,
    monthToDateUsd: Number(monthToDate(project).toFixed(6)),
    enabledAt: cfg.createdAt.toISOString(),
  };
}

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestError(`${field} must be an integer from ${min} to ${max}`);
  return value as number;
}

function readModelList(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some((m) => typeof m !== "string" || !m.trim() || m.length > 200)) {
    throw new BadRequestError(`${field} must be null or a list of up to 100 model ids or globs`);
  }
  return [...new Set((value as string[]).map((m) => m.trim()))];
}

export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<AiSettings> {
  const cfg = await projectConfig(project);
  const sets: Record<string, unknown> = {};
  if (body.keysEnv !== undefined) {
    if (typeof body.keysEnv !== "string") throw new BadRequestError("keysEnv must be a secrets env name");
    const [env] = await sql`select 1 from mybase.secrets_envs where project = ${project} and name = ${body.keysEnv}`;
    if (!env) throw new NotFoundError(`no secrets environment named "${body.keysEnv}"`);
    sets.keys_env = body.keysEnv;
  }
  if (body.captureContent !== undefined) {
    if (typeof body.captureContent !== "boolean") throw new BadRequestError("captureContent must be true or false");
    sets.capture_content = body.captureContent;
  }
  if (body.contentRetentionDays !== undefined) {
    const { min, max } = AI_LIMITS.contentRetentionDays;
    sets.content_retention_days = intIn(body.contentRetentionDays, "contentRetentionDays", min, max);
  }
  if (body.logRetentionDays !== undefined) {
    const { min, max } = AI_LIMITS.logRetentionDays;
    sets.log_retention_days = intIn(body.logRetentionDays, "logRetentionDays", min, max);
  }
  if (body.budgetUsd !== undefined) {
    const b = body.budgetUsd;
    if (b !== null && (typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > 1e9)) throw new BadRequestError("budgetUsd must be null or a number of USD");
    sets.budget_usd = b;
    sets.budget_alerted = null;
  }
  if (body.budgetSoftPct !== undefined) sets.budget_soft_pct = intIn(body.budgetSoftPct, "budgetSoftPct", 1, 100);
  if (body.budgetHard !== undefined) {
    if (typeof body.budgetHard !== "boolean") throw new BadRequestError("budgetHard must be true or false");
    sets.budget_hard = body.budgetHard;
  }
  if (body.allowedModels !== undefined) {
    const list = readModelList(body.allowedModels, "allowedModels");
    sets.allowed_models = list === null ? null : pgArray(list);
  }
  if (body.ratelimitRule !== undefined) {
    const rule = body.ratelimitRule;
    if (rule !== null && (typeof rule !== "string" || !rule)) throw new BadRequestError("ratelimitRule must be a rule name or null");
    if (rule !== null) {
      const [found] = await sql`select 1 from mybase.ratelimit_rules where project = ${project} and name = ${rule as string}`.catch(() => []);
      if (!found) throw new BadRequestError(`no rate limit rule "${rule}": turn on rate limits and create the rule first`);
    }
    sets.ratelimit_rule = rule;
  }
  if (body.ratelimitBy !== undefined) {
    if (body.ratelimitBy !== "token" && body.ratelimitBy !== "user") throw new BadRequestError("ratelimitBy must be token or user");
    sets.ratelimit_by = body.ratelimitBy;
  }
  if (Object.keys(sets).length === 0) throw new BadRequestError("nothing to change");
  await sql`update mybase.ai_projects set ${sql(sets)} where project = ${project}`;
  forget(project);
  log.info("ai settings updated", { fields: Object.keys(sets).join(",") });
  void cfg;
  return getSettings(project);
}

// ---- providers ----------------------------------------------------------------

export async function listProviders(project: string): Promise<AiProviderStatus[]> {
  const cfg = await projectConfig(project);
  const keys = await providerKeys(project, cfg.keysEnv).catch(() => ({}) as Record<string, string>);
  return providersOf(cfg).map((def) => {
    const missing = missingKeys(def, keys);
    const showBase = def.custom || (def.id === "azure" && missing.length === 0);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      custom: Boolean(def.custom),
      baseUrl: showBase ? baseUrlFor(def, keys) : null,
      keys: def.keys,
      missing,
      configured: missing.length === 0,
      endpoints: { ...def.endpoints, native: def.kind !== "bedrock" },
    };
  });
}

/** Admin only (permissions.ts): this server calls the URL with prompts. LAN addresses are fine (Ollama). */
export async function putProvider(project: string, id: string, body: Record<string, unknown>, log: Logger): Promise<AiProviderStatus> {
  const cfg = await projectConfig(project);
  if (!AI_PROVIDER_ID_PATTERN.test(id)) throw new BadRequestError("provider ids are 2–32 lowercase letters, digits, or -, starting with a letter");
  if (BUILTIN_PROVIDER_IDS.has(id)) throw new ConflictError(`"${id}" is a built-in provider; pick another id`);
  const { name, baseUrl, keyName } = body;
  if (typeof baseUrl !== "string" || !/^https?:\/\/[^\s/]+/.test(baseUrl) || baseUrl.length > 500) {
    throw new BadRequestError("baseUrl must be an http(s) URL of an OpenAI-compatible API, e.g. http://ollama.lan:11434/v1");
  }
  if (name !== undefined && (typeof name !== "string" || name.length > 64)) throw new BadRequestError("name must be a string of up to 64 characters");
  if (keyName !== undefined && keyName !== null && (typeof keyName !== "string" || !SECRET_KEY_PATTERN.test(keyName))) {
    throw new BadRequestError("keyName must be a secrets key name (e.g. OLLAMA_API_KEY) or null for keyless providers");
  }
  const exists = cfg.custom.some((p) => p.id === id);
  if (!exists && cfg.custom.length >= AI_LIMITS.customProviders) throw new ConflictError(`a project can have at most ${AI_LIMITS.customProviders} custom providers`);
  await sql`
    insert into mybase.ai_providers (project, id, name, base_url, key_name)
    values (${project}, ${id}, ${(name as string | undefined)?.trim() || id}, ${baseUrl.trim().replace(/\/+$/, "")}, ${(keyName as string | null | undefined) ?? null})
    on conflict (project, id) do update set name = excluded.name, base_url = excluded.base_url, key_name = excluded.key_name`;
  forget(project);
  log.info("ai provider saved", { provider: id });
  return (await listProviders(project)).find((p) => p.id === id)!;
}

export async function deleteProvider(project: string, id: string, log: Logger) {
  await projectConfig(project);
  if (BUILTIN_PROVIDER_IDS.has(id)) throw new BadRequestError("built-in providers can't be removed; remove their key instead");
  const result = await sql`delete from mybase.ai_providers where project = ${project} and id = ${id}`;
  if (result.count === 0) throw new NotFoundError(`no custom provider "${id}"`);
  forget(project);
  log.info("ai provider removed", { provider: id });
}

// ---- aliases ------------------------------------------------------------------

/** `<provider>/<model>` with a known provider. */
export function readModelId(cfg: ProjectConfig, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 200 || !value.includes("/")) throw new BadRequestError(`${field} must be a model id like openai/gpt-5`);
  const provider = value.slice(0, value.indexOf("/"));
  if (!findProvider(cfg, provider)) throw new BadRequestError(`${field}: unknown provider "${provider}"`);
  if (!value.slice(provider.length + 1)) throw new BadRequestError(`${field}: the model is missing after "${provider}/"`);
  return value;
}

function readTargets(cfg: ProjectConfig, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_LIMITS.aliasTargets) {
    throw new BadRequestError(`${field} must be a list of 1–${AI_LIMITS.aliasTargets} model ids (the first, then fallbacks)`);
  }
  return value.map((t, i) => readModelId(cfg, t, `${field}[${i}]`));
}

function readAliasName(value: unknown): string {
  if (typeof value !== "string" || !AI_ALIAS_PATTERN.test(value)) throw new BadRequestError(`invalid alias name. ${AI_ALIAS_RULES}`);
  return value;
}

export async function listAliases(project: string): Promise<AiAlias[]> {
  return [...(await projectConfig(project)).aliases.values()];
}

export async function putAlias(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<AiAlias> {
  const cfg = await projectConfig(project);
  readAliasName(name);
  const existing = cfg.aliases.get(name);
  if (existing?.source === "code") throw new ConflictError(`"${name}" is managed in code. Edit it in mybase.config.ts and run \`mybase ai sync\``);
  if (!existing && cfg.aliases.size >= AI_LIMITS.aliasesPerProject) throw new ConflictError(`a project can have at most ${AI_LIMITS.aliasesPerProject} aliases`);
  const targets = readTargets(cfg, body.targets, "targets");
  await sql`
    insert into mybase.ai_aliases (project, name, targets, source) values (${project}, ${name}, ${sql.array(targets, "text")}, 'dashboard')
    on conflict (project, name) do update set targets = excluded.targets, updated_at = now()`;
  forget(project);
  log.info("ai alias saved", { alias: name, targets: targets.length });
  return { name, targets, source: "dashboard" };
}

export async function deleteAlias(project: string, name: string, log: Logger) {
  const cfg = await projectConfig(project);
  const existing = cfg.aliases.get(name);
  if (!existing) throw new NotFoundError(`no alias "${name}"`);
  if (existing.source === "code") throw new ConflictError(`"${name}" is managed in code. Remove it from mybase.config.ts and run \`mybase ai sync\``);
  await sql`delete from mybase.ai_aliases where project = ${project} and name = ${name}`;
  forget(project);
  log.info("ai alias deleted", { alias: name });
}

// ---- prices ---------------------------------------------------------------------

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "perImage", "perRequest"] as const;

function readPrice(body: Record<string, unknown>, field: string): AiPrice {
  const out: AiPrice = {};
  for (const k of PRICE_FIELDS) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e6)
      throw new BadRequestError(`${field}.${k} must be a non-negative number (USD per 1M tokens, or per image/request)`);
    out[k] = v;
  }
  if (Object.keys(out).length === 0) throw new BadRequestError(`${field} needs at least one of: ${PRICE_FIELDS.join(", ")}`);
  return out;
}

function readOverrideModel(value: unknown): string {
  if (typeof value !== "string" || !value.includes("/") || value.length > 200 || /\s/.test(value)) {
    throw new BadRequestError("model must be <provider>/<model>, or a glob like openai/gpt-5*");
  }
  return value;
}

export async function listPrices(project: string): Promise<{ overrides: AiPriceOverride[]; catalogFetchedAt: string }> {
  const cfg = await projectConfig(project);
  return { overrides: cfg.overrides, catalogFetchedAt: currentCatalog().fetchedAt };
}

async function writeOverride(project: string, model: string, price: AiPrice, source: "dashboard" | "code") {
  await sql`
    insert into mybase.ai_price_overrides (project, model, input, output, cache_read, cache_write, per_image, per_request, source)
    values (${project}, ${model}, ${price.input ?? null}, ${price.output ?? null}, ${price.cacheRead ?? null}, ${price.cacheWrite ?? null},
      ${price.perImage ?? null}, ${price.perRequest ?? null}, ${source})
    on conflict (project, model) do update set input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
      cache_write = excluded.cache_write, per_image = excluded.per_image, per_request = excluded.per_request, source = excluded.source`;
}

export async function putPrice(project: string, body: Record<string, unknown>, log: Logger): Promise<AiPriceOverride> {
  const cfg = await projectConfig(project);
  const model = readOverrideModel(body.model);
  const price = readPrice(body, "price");
  if (!cfg.overrides.some((o) => o.model === model) && cfg.overrides.length >= AI_LIMITS.priceOverrides) {
    throw new ConflictError(`a project can have at most ${AI_LIMITS.priceOverrides} price overrides`);
  }
  await writeOverride(project, model, price, "dashboard");
  forget(project);
  log.info("ai price override saved", { model });
  return { model, ...price };
}

export async function deletePrice(project: string, model: string, log: Logger) {
  await projectConfig(project);
  const result = await sql`delete from mybase.ai_price_overrides where project = ${project} and model = ${model}`;
  if (result.count === 0) throw new NotFoundError(`no price override for "${model}"`);
  forget(project);
  log.info("ai price override deleted", { model });
}

// ---- sync (mybase.config.ts) ------------------------------------------------------

/** Makes the code-defined aliases and price overrides match `body` (`mybase ai sync`). */
export async function syncAi(project: string, body: Record<string, unknown>, log: Logger): Promise<SyncAiResponse> {
  const cfg = await projectConfig(project);
  const dryRun = body.dryRun === true;
  const aliasesIn = body.aliases ?? {};
  const pricesIn = body.prices ?? {};
  if (typeof aliasesIn !== "object" || aliasesIn === null || Array.isArray(aliasesIn)) throw new BadRequestError("aliases must map names to model id lists");
  if (typeof pricesIn !== "object" || pricesIn === null || Array.isArray(pricesIn)) throw new BadRequestError("prices must map model ids to prices");

  const wanted = new Map<string, string[]>();
  for (const [name, targets] of Object.entries(aliasesIn)) {
    readAliasName(name);
    wanted.set(name, readTargets(cfg, Array.isArray(targets) ? targets : [targets], `aliases.${name}`));
  }
  const result: SyncAiResponse = { aliases: { created: [], updated: [], deleted: [], unchanged: [] }, prices: { set: [], deleted: [] } };
  for (const [name, targets] of wanted) {
    const row = cfg.aliases.get(name);
    if (row && row.source !== "code") throw new ConflictError(`alias "${name}" already exists on the dashboard. Delete it first`);
    if (!row) result.aliases.created.push(name);
    else if (row.targets.join("\0") === targets.join("\0")) result.aliases.unchanged.push(name);
    else result.aliases.updated.push(name);
  }
  for (const row of cfg.aliases.values()) if (row.source === "code" && !wanted.has(row.name)) result.aliases.deleted.push(row.name);
  if (cfg.aliases.size - result.aliases.deleted.length + result.aliases.created.length > AI_LIMITS.aliasesPerProject) {
    throw new ConflictError(`a project can have at most ${AI_LIMITS.aliasesPerProject} aliases`);
  }

  const prices = new Map<string, AiPrice>();
  for (const [model, price] of Object.entries(pricesIn)) {
    readOverrideModel(model);
    if (typeof price !== "object" || price === null) throw new BadRequestError(`prices.${model} must be an object`);
    prices.set(model, readPrice(price as Record<string, unknown>, `prices.${model}`));
  }
  const codePrices: { model: string }[] = await sql`select model from mybase.ai_price_overrides where project = ${project} and source = 'code'`;
  result.prices.set = [...prices.keys()];
  result.prices.deleted = codePrices.map((p) => p.model).filter((m) => !prices.has(m));
  if (dryRun) return result;

  await sql.begin(async (tx) => {
    for (const name of result.aliases.deleted) await tx`delete from mybase.ai_aliases where project = ${project} and name = ${name}`;
    for (const name of [...result.aliases.created, ...result.aliases.updated]) {
      await tx`
        insert into mybase.ai_aliases (project, name, targets, source) values (${project}, ${name}, ${tx.array(wanted.get(name)!, "text")}, 'code')
        on conflict (project, name) do update set targets = excluded.targets, updated_at = now()`;
    }
    for (const model of result.prices.deleted) await tx`delete from mybase.ai_price_overrides where project = ${project} and model = ${model} and source = 'code'`;
  });
  for (const [model, price] of prices) await writeOverride(project, model, price, "code");
  forget(project);
  log.info("ai config synced", { aliases: wanted.size, prices: prices.size });
  return result;
}

// ---- models -------------------------------------------------------------------

const customModels = new Map<string, { at: number; ids: string[] }>();

/** A custom provider's `/models`, cached 10 minutes; empty when it can't be reached. */
async function fetchCustomModels(def: ProviderDef, keys: Record<string, string>): Promise<string[]> {
  const key = `${def.baseUrl}`;
  const hit = customModels.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  let ids: string[] = [];
  try {
    const token = def.keys[0] ? keys[def.keys[0]] : undefined;
    const res = await fetch(`${def.baseUrl}/models`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (res.ok) {
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      ids = (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : [])).slice(0, 500);
    }
  } catch {
    // unreachable: no models listed
  }
  customModels.set(key, { at: Date.now(), ids });
  return ids;
}

/** The catalog's models for the project's providers. `all`: also providers without keys. */
export async function listModels(project: string, opts: { all?: boolean; type?: string | null; provider?: string | null } = {}): Promise<AiModel[]> {
  const cfg = await projectConfig(project);
  const keys = await providerKeys(project, cfg.keysEnv).catch(() => ({}) as Record<string, string>);
  const catalog = currentCatalog();
  const out: AiModel[] = [];
  for (const def of providersOf(cfg)) {
    if (opts.provider && def.id !== opts.provider) continue;
    const configured = missingKeys(def, keys).length === 0;
    if (!configured && !opts.all) continue;
    const ids = def.custom ? (configured ? await fetchCustomModels(def, keys) : []) : Object.keys((def.pricesId && catalog.providers[def.pricesId]) || {});
    for (const model of ids) {
      const entry = catalogModel(def, model);
      const type = modelType(entry, model);
      if (opts.type && type !== opts.type) continue;
      const id = `${def.id}/${model}`;
      const override = overrideFor(cfg.overrides, id);
      const price = override ? stripModel(override) : catalogPrice(entry);
      out.push({
        id,
        provider: def.id,
        name: entry?.name ?? model,
        type,
        contextWindow: type === "embedding" ? null : (entry?.context ?? null),
        maxOutput: type === "embedding" ? null : (entry?.output ?? null),
        dimensions: type === "embedding" ? (entry?.output ?? null) : null,
        price,
        priceSource: override ? "override" : price ? "catalog" : null,
        configured,
      });
    }
  }
  return out;
}

const stripModel = ({ model: _m, ...price }: AiPriceOverride): AiPrice => price;

/** Max output tokens from the catalog, for providers that need max_tokens (Anthropic). */
export function maxOutputOf(def: ProviderDef, model: string): number | null {
  return catalogModel(def, model)?.output ?? null;
}

// ---- logs ---------------------------------------------------------------------

interface RequestRow {
  id: string;
  at: Date;
  endpoint: AiEndpoint;
  provider: string | null;
  model: string | null;
  alias: string | null;
  status: number;
  error: string | null;
  stream: boolean;
  cached: boolean;
  latencyMs: number;
  ttfbMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  images: number;
  costUsd: string | null;
  costSource: AiCostSource | null;
  tokenName: string | null;
  user: string | null;
  tags: string[];
  fallbackFrom: string | null;
  requestId: string | null;
  hasContent: boolean;
}

const LOG_COLUMNS = sql`
  r.id::text, r.at, r.endpoint, r.provider, r.model, r.alias, r.status, r.error, r.stream, r.cached, r.latency_ms as "latencyMs", r.ttfb_ms as "ttfbMs",
  r.input_tokens as "inputTokens", r.output_tokens as "outputTokens", r.cache_read_tokens as "cacheReadTokens", r.cache_write_tokens as "cacheWriteTokens",
  r.reasoning_tokens as "reasoningTokens", r.images, r.cost_usd::text as "costUsd", r.cost_source as "costSource", r.token_name as "tokenName",
  r.user_tag as "user", r.tags, r.fallback_from as "fallbackFrom", r.request_id as "requestId",
  exists (select 1 from mybase.ai_content c where c.request_id = r.id) as "hasContent"`;

const toEntry = (r: RequestRow): AiLogEntry => ({ ...r, at: r.at.toISOString(), costUsd: r.costUsd === null ? null : Number(r.costUsd) });

const SINCE: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSince(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d+)([mhd])$/.exec(value);
  if (m) return new Date(Date.now() - Number(m[1]) * SINCE[m[2]!]!);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestError("since must be like 30m, 24h, 7d, or a date");
  return d;
}

export async function listLogs(project: string, params: URLSearchParams): Promise<AiLogsResponse> {
  await projectConfig(project);
  await flushAi();
  const raw = params.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestError("limit must be an integer from 1 to 200");
  const conds = [sql`r.project = ${project}`];
  const before = params.get("before");
  if (before) {
    const [at, id] = before.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new BadRequestError("before must be the next value from a previous page");
    conds.push(sql`(r.at, r.id) < (${new Date(at)}, ${id}::uuid)`);
  }
  const since = parseSince(params.get("since"));
  if (since) conds.push(sql`r.at >= ${since}`);
  const model = params.get("model");
  if (model) conds.push(model.includes("/") ? sql`(r.provider || '/' || r.model) = ${model}` : sql`(r.model = ${model} or r.alias = ${model})`);
  const provider = params.get("provider");
  if (provider) conds.push(sql`r.provider = ${provider}`);
  const endpoint = params.get("endpoint");
  if (endpoint) conds.push(sql`r.endpoint = ${endpoint}`);
  const tag = params.get("tag");
  if (tag) conds.push(sql`${tag} = any(r.tags)`);
  const user = params.get("user");
  if (user) conds.push(sql`r.user_tag = ${user}`);
  const status = params.get("status");
  if (status === "ok") conds.push(sql`r.status < 400`);
  else if (status === "error") conds.push(sql`r.status >= 400`);
  else if (status && /^\d{3}$/.test(status)) conds.push(sql`r.status = ${Number(status)}`);
  const where = conds.reduce((a, b) => sql`${a} and ${b}`);
  const rows: RequestRow[] = await sql`select ${LOG_COLUMNS} from mybase.ai_requests r where ${where} order by r.at desc, r.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { logs: page.map(toEntry), next: rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null };
}

export async function getLog(project: string, id: string): Promise<AiLogDetail> {
  await projectConfig(project);
  await flushAi();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundError(`no AI request "${id}"`);
  const [row]: RequestRow[] = await sql`select ${LOG_COLUMNS} from mybase.ai_requests r where r.project = ${project} and r.id = ${id}::uuid`;
  if (!row) throw new NotFoundError(`no AI request "${id}"`);
  let content: AiLogDetail["content"] = null;
  if (row.hasContent) {
    const [c]: { request: Uint8Array | null; response: Uint8Array | null }[] = await sql`select request, response from mybase.ai_content where request_id = ${id}::uuid`;
    const master = secretsMaster();
    if (c && master) {
      const open = async (blob: Uint8Array | null) => {
        if (!blob) return null;
        try {
          return new TextDecoder().decode(await openBlob(master, blob, `${project}\0ai\0${id}`));
        } catch {
          return "(sealed with a different MYBASE_SECRETS_KEY)";
        }
      };
      content = { request: await open(c.request), response: await open(c.response) };
    }
  }
  return { ...toEntry(row), content };
}

// ---- usage --------------------------------------------------------------------

const USAGE_RANGES: Record<string, { ms: number; bucket: "hour" | "day" }> = {
  "24h": { ms: 86_400_000, bucket: "hour" },
  "48h": { ms: 2 * 86_400_000, bucket: "hour" },
  "7d": { ms: 7 * 86_400_000, bucket: "day" },
  "30d": { ms: 30 * 86_400_000, bucket: "day" },
  "90d": { ms: 90 * 86_400_000, bucket: "day" },
};

type TotalsRow = { requests: number; errors: number; input: number; output: number; cached: number; cost: number };
const totals = (r: TotalsRow | undefined) => ({
  requests: r?.requests ?? 0,
  errors: r?.errors ?? 0,
  inputTokens: Number(r?.input ?? 0),
  outputTokens: Number(r?.output ?? 0),
  cachedTokens: Number(r?.cached ?? 0),
  costUsd: Number(Number(r?.cost ?? 0).toFixed(6)),
});

export async function usage(project: string, params: URLSearchParams): Promise<AiUsageResponse> {
  await projectConfig(project);
  const rangeName = params.get("range") ?? "7d";
  const range = USAGE_RANGES[rangeName];
  if (!range) throw new BadRequestError(`range must be one of ${Object.keys(USAGE_RANGES).join(", ")}`);
  const group = (params.get("group") ?? "model") as AiUsageGroup;
  if (!["model", "provider", "tag", "key"].includes(group)) throw new BadRequestError("group must be model, provider, tag, or key");
  await Promise.all([flushAi(), flushRollups()]);
  const to = new Date();
  const from = new Date(to.getTime() - range.ms);
  const sums = sql`sum(requests)::int as requests, sum(errors)::int as errors, sum(input)::float8 as input, sum(output)::float8 as output, sum(cached)::float8 as cached, sum(cost)::float8 as cost`;
  const [total]: (TotalsRow & { unpriced: number; latency: number })[] = await sql`
    select ${sums}, sum(unpriced)::int as unpriced, sum(latency_ms)::float8 as latency
    from mybase.ai_usage_hourly where project = ${project} and hour >= date_trunc('hour', ${from}::timestamptz)`;
  const series: (TotalsRow & { at: Date })[] = await sql`
    select date_trunc(${range.bucket}, hour, 'UTC') as at, ${sums}
    from mybase.ai_usage_hourly where project = ${project} and hour >= date_trunc('hour', ${from}::timestamptz)
    group by 1 order by 1`;
  let groups: (TotalsRow & { key: string })[];
  if (group === "model" || group === "provider") {
    const key = group === "model" ? sql`case when provider = '-' then '(refused before a model)' else provider || '/' || model end` : sql`case when provider = '-' then '(refused before a model)' else provider end`;
    groups = await sql`
      select ${key} as key, ${sums} from mybase.ai_usage_hourly
      where project = ${project} and hour >= date_trunc('hour', ${from}::timestamptz)
      group by 1 order by cost desc nulls last, requests desc limit 50`;
  } else {
    // From the request log (kept log_retention_days): rollups don't know tags or keys.
    const key = group === "tag" ? sql`unnest(case when cardinality(tags) = 0 then array['(none)'] else tags end)` : sql`coalesce(token_name, '(dashboard)')`;
    groups = await sql`
      select key, count(*)::int as requests, count(*) filter (where status >= 400)::int as errors, sum(input_tokens)::float8 as input,
        sum(output_tokens)::float8 as output, sum(cache_read_tokens)::float8 as cached, coalesce(sum(cost_usd), 0)::float8 as cost
      from (select ${key} as key, status, input_tokens, output_tokens, cache_read_tokens, cost_usd from mybase.ai_requests
        where project = ${project} and at >= ${from}) t
      group by key order by cost desc, requests desc limit 50`;
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: range.bucket,
    totals: { ...totals(total), avgLatencyMs: total?.requests ? Math.round(total.latency / total.requests) : null, unpriced: total?.unpriced ?? 0 },
    series: series.map((s) => ({ at: s.at.toISOString(), ...totals(s) })),
    groups: groups.map((g) => ({ key: g.key, ...totals(g) })),
  };
}

// ---- context --------------------------------------------------------------------

export async function aiContext(project: string): Promise<NonNullable<ProjectContext["ai"]>> {
  const cfg = await projectConfig(project);
  const names = await keyNames(project, cfg.keysEnv);
  return {
    baseURL: aiBaseUrl(project),
    nativeBaseURL: aiNativeUrl(project),
    keysEnv: cfg.keysEnv,
    providers: providersOf(cfg)
      .map((def) => ({ id: def.id, configured: missingKeys(def, Object.fromEntries([...names].map((n) => [n, "x"]))).length === 0 }))
      .filter((p) => p.configured || cfg.custom.some((c) => c.id === p.id)),
    aliases: [...cfg.aliases.values()].map(({ name, targets }) => ({ name, targets })),
    captureContent: cfg.captureContent,
    budgetUsd: cfg.budgetUsd,
  };
}

/** Marks the soft budget alert as sent for `month`; false when it already was. */
export async function claimBudgetAlert(project: string, month: string): Promise<boolean> {
  const result = await sql`
    update mybase.ai_projects set budget_alerted = ${month}
    where project = ${project} and budget_alerted is distinct from ${month}`;
  forget(project);
  return result.count > 0;
}

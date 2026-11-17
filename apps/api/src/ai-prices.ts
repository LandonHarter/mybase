// Prices for the AI gateway. The catalog is a filtered models.dev snapshot (MIT): bundled as
// ai-prices.json (scripts/gen-ai-prices.ts), refreshed daily into `mybase.ai_prices` unless
// MYBASE_AI_PRICES_REFRESH=off (a failed refresh keeps the last copy).
//
// Cost precedence: what the provider reported (OpenRouter `usage.cost`, Vercel embeddings) >
// a project override > the catalog (`vercel/x/y` and `openrouter/x/y` fall back to `x`'s own
// entry) > unpriced (null, shown as such). Prices are USD per 1M tokens.
import type { AiCostSource, AiModelType, AiPrice, AiPriceOverride } from "@mybase-dev/sdk/ai";
import type { Logger } from "@mybase/shared/logger";
import bundled from "./ai-prices.json";
import { AI_PROVIDERS, type ProviderDef } from "./ai-providers";
import { sql } from "./postgres";

export interface CatalogModel {
  name: string;
  /** Omitted for chat models. */
  type?: "embedding" | "image";
  context?: number;
  /** Max output tokens; embedding models: dimensions. */
  output?: number;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  /** Capabilities, only when true. */
  reasoning?: true;
  tools?: true;
  /** Takes images as input. */
  vision?: true;
  open?: true;
  /** YYYY-MM-DD. */
  released?: string;
  /** Training cutoff, YYYY-MM. */
  knowledge?: string;
}

export interface Catalog {
  fetchedAt: string;
  /** models.dev provider id → model id → model. */
  providers: Record<string, Record<string, CatalogModel>>;
  /** models.dev provider id → its docs URL. Missing in copies made before it was added. */
  docs?: Record<string, string>;
}

const KEEP_TYPES = new Set([undefined, "chat", "embedding", "image"]);

/** The subset of models.dev's api.json the gateway uses: our providers, chat/embedding/image models, prices and limits. */
export function filterCatalog(raw: unknown): Catalog {
  const ids = new Set(Object.values(AI_PROVIDERS).flatMap((p) => (p.pricesId ? [p.pricesId] : [])));
  const providers: Catalog["providers"] = {};
  const docs: Record<string, string> = {};
  for (const [pid, provider] of Object.entries((raw ?? {}) as Record<string, { doc?: unknown; models?: Record<string, Record<string, unknown>> }>)) {
    if (!ids.has(pid) || !provider.models) continue;
    if (typeof provider.doc === "string" && /^https:\/\//.test(provider.doc)) docs[pid] = provider.doc;
    const models: Record<string, CatalogModel> = {};
    for (const [mid, m] of Object.entries(provider.models)) {
      const type = m.type as string | undefined;
      if (!KEEP_TYPES.has(type)) continue;
      const limit = (m.limit ?? {}) as { context?: number; output?: number };
      const cost = m.cost as Record<string, unknown> | undefined;
      const entry: CatalogModel = { name: String(m.name ?? mid) };
      if (type === "embedding" || type === "image") entry.type = type;
      if (limit.context) entry.context = limit.context;
      if (limit.output) entry.output = limit.output;
      if (cost) {
        const c: CatalogModel["cost"] = {};
        for (const k of ["input", "output", "cache_read", "cache_write"] as const) if (typeof cost[k] === "number") c[k] = cost[k] as number;
        if (Object.keys(c).length) entry.cost = c;
      }
      const input = (m.modalities as { input?: unknown } | undefined)?.input;
      if (m.reasoning === true) entry.reasoning = true;
      if (m.tool_call === true) entry.tools = true;
      if (Array.isArray(input) && input.includes("image")) entry.vision = true;
      if (m.open_weights === true) entry.open = true;
      if (typeof m.release_date === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(m.release_date)) entry.released = m.release_date;
      if (typeof m.knowledge === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(m.knowledge)) entry.knowledge = m.knowledge;
      models[mid] = entry;
    }
    providers[pid] = models;
  }
  return { fetchedAt: new Date().toISOString(), providers, docs };
}

let catalog: Catalog = bundled as Catalog;

export const currentCatalog = () => catalog;

/** Test hook. */
export function setCatalog(next: Catalog) {
  catalog = next;
}

// ---- refresh ----------------------------------------------------------------

const DAY_MS = 86_400_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Loads the last refreshed copy, then refreshes daily. */
export async function startPrices(log: Logger) {
  const [row]: { data: Catalog }[] = await sql`select data from mybase.ai_prices where id = 1`;
  if (row?.data?.providers && row.data.fetchedAt > catalog.fetchedAt) catalog = row.data;
  if (process.env.MYBASE_AI_PRICES_REFRESH === "off") return;
  const stale = Date.now() - Date.parse(catalog.fetchedAt) > DAY_MS;
  if (stale) void refreshPrices(log);
  refreshTimer ??= setInterval(() => void refreshPrices(log), DAY_MS);
  refreshTimer.unref?.();
}

/** Fetches models.dev and stores the filtered copy. Returns the new fetch time, or throws. */
export async function refreshPrices(log: Logger): Promise<string> {
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
    const next = filterCatalog(await res.json());
    if (Object.keys(next.providers).length === 0) throw new Error("models.dev returned no known providers");
    await sql`
      insert into mybase.ai_prices (id, fetched_at, data) values (1, now(), ${JSON.stringify(next)}::text::jsonb)
      on conflict (id) do update set fetched_at = now(), data = excluded.data`;
    catalog = next;
    log.info("ai prices refreshed", { providers: Object.keys(next.providers).length });
    return next.fetchedAt;
  } catch (err) {
    log.warn("ai price refresh failed, keeping the last copy", { err });
    throw err;
  }
}

// ---- lookup -----------------------------------------------------------------

/** The catalog entry for `model` at provider `def`, following gateway prefixes (`vercel/openai/gpt-5` → OpenAI's `gpt-5`). */
export function catalogModel(def: ProviderDef, model: string): CatalogModel | null {
  const own = def.pricesId ? catalog.providers[def.pricesId]?.[model] : undefined;
  if (own?.cost) return own;
  if ((def.id === "vercel" || def.id === "openrouter") && model.includes("/")) {
    const slash = model.indexOf("/");
    const sub = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    const subId = AI_PROVIDERS[sub]?.pricesId ?? sub;
    const other = catalog.providers[subId]?.[rest];
    if (other) return own ? { ...own, cost: other.cost } : other;
  }
  return own ?? null;
}

export function modelType(entry: CatalogModel | null, model: string): AiModelType {
  if (entry?.type) return entry.type;
  if (/embed/i.test(model)) return "embedding";
  if (/(^|[-/])(dall-e|gpt-image|imagen|flux|image)/i.test(model)) return "image";
  return "chat";
}

/** `*` matches anything (including `/`). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(value);
}

/** The override for `id` (`provider/model`): an exact match beats globs; longer globs beat shorter ones. */
export function overrideFor(overrides: readonly AiPriceOverride[], id: string): AiPriceOverride | null {
  const exact = overrides.find((o) => o.model === id);
  if (exact) return exact;
  return overrides.filter((o) => o.model.includes("*") && globMatch(o.model, id)).sort((a, b) => b.model.length - a.model.length)[0] ?? null;
}

export const catalogPrice = (entry: CatalogModel | null): AiPrice | null =>
  entry?.cost ? { input: entry.cost.input, output: entry.cost.output, cacheRead: entry.cost.cache_read, cacheWrite: entry.cost.cache_write } : null;

// ---- cost -------------------------------------------------------------------

export interface UsageCounts {
  /** All prompt tokens, cached ones included. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  images: number;
}

export const emptyUsage = (): UsageCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, images: 0 });

/** USD for `usage` at `price`, or null when the price doesn't cover what was used. */
export function priceCost(price: AiPrice, usage: UsageCounts): number | null {
  const hasTokens = price.input !== undefined || price.output !== undefined;
  const tokensUsed = usage.input + usage.output > 0;
  let cost = price.perRequest ?? 0;
  let priced = price.perRequest !== undefined;
  if (tokensUsed && hasTokens) {
    const inRate = price.input ?? 0;
    const fresh = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
    cost += (fresh * inRate + usage.cacheRead * (price.cacheRead ?? inRate) + usage.cacheWrite * (price.cacheWrite ?? inRate) + usage.output * (price.output ?? 0)) / 1e6;
    priced = true;
  }
  if (usage.images > 0 && !tokensUsed && price.perImage !== undefined) {
    cost += usage.images * price.perImage;
    priced = true;
  }
  return priced ? Number(cost.toFixed(8)) : null;
}

/** Built-in per-image prices for image models that don't report tokens (standard quality, 1024px). */
const IMAGE_PRICES: [RegExp, number][] = [
  [/dall-e-3/, 0.04],
  [/dall-e-2/, 0.02],
  [/imagen-4.*ultra/, 0.06],
  [/imagen-4.*fast/, 0.02],
  [/imagen/, 0.04],
  [/grok-2-image|grok-imagine/, 0.07],
  [/flux.*schnell/, 0.003],
  [/flux.*pro/, 0.05],
  [/flux/, 0.025],
];

export function imagePrice(model: string): number | undefined {
  return IMAGE_PRICES.find(([re]) => re.test(model))?.[1];
}

/** The cost of one call and where it came from. */
export function resolveCost(
  def: ProviderDef,
  model: string,
  usage: UsageCounts,
  providerCost: number | null,
  overrides: readonly AiPriceOverride[],
): { cost: number | null; source: AiCostSource | null } {
  if (providerCost !== null && Number.isFinite(providerCost)) return { cost: Number(providerCost.toFixed(8)), source: "provider" };
  const override = overrideFor(overrides, `${def.id}/${model}`);
  if (override) {
    const cost = priceCost(override, usage);
    if (cost !== null) return { cost, source: "override" };
  }
  const entry = catalogModel(def, model);
  const base = catalogPrice(entry) ?? {};
  const perImage = imagePrice(model);
  const cost = priceCost(perImage !== undefined ? { ...base, perImage } : base, usage);
  return cost === null ? { cost: null, source: null } : { cost, source: "catalog" };
}

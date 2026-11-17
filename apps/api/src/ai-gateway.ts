// The AI gateway's request pipeline: one OpenAI-compatible endpoint for every provider, plus
// native passthrough per provider. Each call:
//   1. reads the mybase extension (`mybase: {tags, user, cache, store}` or `X-Mybase-*` headers)
//   2. resolves the model: `<provider>/<model>`, or an alias (ordered fallbacks); allowed_models
//   3. checks the monthly budget, the rate limit rule, and the response cache
//   4. tries each target: network errors, 408, 429, and 5xx fall back to the next one, as long
//      as nothing was sent to the client yet
//   5. maps the answer (Anthropic and Bedrock are translated; OpenAI-wire providers pass through)
//   6. logs one row: tokens, cost, latency, and (capture on) the sealed prompt and response
// Prompts, responses, and keys are never logged; log lines carry model, status, and tokens.
import { AI_LIMITS, type AiEndpoint, type AiRequestOptions } from "@mybase-dev/sdk/ai";
import type { Logger } from "@mybase/shared/logger";
import { createHash } from "node:crypto";
import { aiCachePrefix, claimBudgetAlert, findProvider, maxOutputOf, projectConfig, providersOf, listAliases, type ProjectConfig } from "./ai";
import { anthropicRequest, anthropicStream, anthropicUsage, fromAnthropic, toAnthropic } from "./ai-adapters/anthropic";
import { bedrockChatRequest, bedrockEmbed, converseStream, fromConverse } from "./ai-adapters/bedrock";
import { openaiChatStream, openaiRequest, openaiUsage, responsesStream, type UpstreamRequest } from "./ai-adapters/openai";
import { SseParser } from "./ai-adapters/sse";
import { newUsage, readOpenAIUsage, transformText, type StreamHooks, type Usage } from "./ai-adapters/types";
import { providerKeys } from "./ai-keys";
import { currentMonth, monthToDate, pgArray, pushLog, type ContentRow, type LogRow } from "./ai-log";
import { catalogModel, globMatch, modelType, resolveCost, currentCatalog } from "./ai-prices";
import { authHeaders, baseUrlFor, envBase, missingKeys, type ProviderDef } from "./ai-providers";
import { audit, outsideRequest } from "./audit";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError, UpstreamError } from "./errors";
import * as ratelimit from "./ratelimit";
import { sealBlob } from "./secrets-crypto";
import { secretsMaster } from "./secrets";
import { file, storageInfo } from "./storage";
import { send } from "./valkey";

/** Who's calling, for the log and the rate limit. */
export interface Caller {
  /** API key name; null for the dashboard (playground). */
  tokenName: string | null;
  /** Rate limit id when counting per key. */
  tokenId: string | null;
}

export interface GatewayCall {
  project: string;
  body: Record<string, unknown>;
  headers: Headers;
  signal: AbortSignal;
  caller: Caller;
  requestId: string | null;
  log: Logger;
}

interface Target {
  def: ProviderDef;
  /** The provider's own model id. */
  model: string;
  /** `<provider>/<model>`. */
  id: string;
}

interface Extension extends AiRequestOptions {
  store?: string;
  anthropic?: unknown;
}

const NON_STREAM_TIMEOUT_MS = 600_000;
const CACHE_MAX_BYTES = 256 * 1024;
const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500;

// ---- request extension ------------------------------------------------------

/** Reads (and removes) `mybase` from the body; headers fill what it doesn't set. */
export function readExtension(body: Record<string, unknown>, headers: Headers): Extension {
  const raw = body.mybase;
  delete body.mybase;
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) throw new BadRequestError("mybase must be an object");
  const ext = { ...(raw as Record<string, unknown> | undefined) } as Record<string, unknown>;
  const tagsHeader = headers.get("x-mybase-tags");
  let tags =
    ext.tags ??
    (tagsHeader
      ? tagsHeader
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : []);
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) throw new BadRequestError("mybase.tags must be a list of strings");
  tags = [...new Set((tags as string[]).map((t) => t.slice(0, AI_LIMITS.tagLength)))].slice(0, AI_LIMITS.tags);
  const user = ext.user ?? headers.get("x-mybase-user") ?? (typeof body.user === "string" ? body.user : undefined);
  if (user !== undefined && typeof user !== "string") throw new BadRequestError("mybase.user must be a string");
  const cacheRaw = ext.cache ?? headers.get("x-mybase-cache") ?? undefined;
  let cache: number | undefined;
  if (cacheRaw !== undefined && cacheRaw !== null && cacheRaw !== "") {
    cache = Number(cacheRaw);
    if (!Number.isInteger(cache) || cache < 1 || cache > 30 * 86_400) throw new BadRequestError("mybase.cache must be a TTL in seconds (1 to 2592000)");
  }
  const store = ext.store;
  if (store !== undefined && (typeof store !== "string" || store.length > 200 || store.startsWith("/") || store.split("/").some((s) => s === "." || s === ".."))) {
    throw new BadRequestError('mybase.store must be a key prefix in the project bucket, e.g. "images/" or "public/avatars/"');
  }
  return { tags: tags as string[], user: user?.slice(0, 200), cache, store: store as string | undefined, anthropic: ext.anthropic };
}

// ---- model resolution -------------------------------------------------------

export function parseTarget(cfg: ProjectConfig, id: string): Target {
  const slash = id.indexOf("/");
  const providerId = id.slice(0, slash);
  const def = findProvider(cfg, providerId);
  if (!def) throw new BadRequestError(`unknown provider "${providerId}" in model "${id}"`);
  const model = id.slice(slash + 1);
  if (!model) throw new BadRequestError(`model "${id}" has no model name after the provider`);
  return { def, model, id };
}

/** Targets in order, and the alias when `model` was one. */
export function resolveModel(cfg: ProjectConfig, model: unknown): { alias: string | null; targets: Target[] } {
  if (typeof model !== "string" || !model) throw new BadRequestError("model is required: <provider>/<model> (e.g. openai/gpt-5) or one of the project's aliases");
  let alias: string | null = null;
  let ids: string[];
  if (model.includes("/")) ids = [model];
  else {
    const found = cfg.aliases.get(model);
    if (!found) throw new BadRequestError(`unknown model "${model}": use <provider>/<model> (e.g. openai/gpt-5) or one of the project's aliases`);
    alias = model;
    ids = found.targets;
  }
  let targets = ids.map((id) => parseTarget(cfg, id));
  if (cfg.allowedModels) {
    const allowed = (id: string) => cfg.allowedModels!.some((g) => globMatch(g, id));
    if (!(alias && allowed(alias))) targets = targets.filter((t) => allowed(t.id));
    if (targets.length === 0) throw new ForbiddenError(`model "${model}" isn't in this project's allowed models`);
  }
  return { alias, targets };
}

// ---- guardrails -------------------------------------------------------------

function checkBudget(cfg: ProjectConfig, project: string) {
  // A budget lowered below what's spent alerts on the next call, not only after a priced one.
  budgetAlert(cfg, project);
  if (cfg.budgetUsd === null || !cfg.budgetHard) return;
  if (monthToDate(project) >= cfg.budgetUsd) {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    throw new TooManyRequestsError(`budget exhausted: this project spent its $${cfg.budgetUsd} for this month`, Math.ceil((next - now.getTime()) / 1000));
  }
}

async function checkRateLimit(cfg: ProjectConfig, project: string, caller: Caller, ext: Extension) {
  if (!cfg.ratelimitRule) return;
  try {
    await ratelimit.requireEnabled(project);
  } catch {
    return; // rate limits turned off since: nothing to check against
  }
  const id = cfg.ratelimitBy === "user" && ext.user ? `user:${ext.user}` : `key:${caller.tokenId ?? caller.tokenName ?? "dashboard"}`;
  const result = await ratelimit.check(project, { id, rule: cfg.ratelimitRule }).catch(() => null);
  if (result && !result.success) throw new TooManyRequestsError("rate limited by the project's AI rate limit rule", Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)));
}

/** After a cost was added: the soft budget alert, once a month. */
function budgetAlert(cfg: ProjectConfig, project: string) {
  if (cfg.budgetUsd === null || cfg.budgetUsd <= 0) return;
  const spent = monthToDate(project);
  const month = currentMonth();
  if (spent < (cfg.budgetUsd * cfg.budgetSoftPct) / 100 || cfg.budgetAlerted === month) return;
  cfg.budgetAlerted = month;
  void claimBudgetAlert(project, month)
    .then((claimed) => {
      if (!claimed) return;
      outsideRequest(() =>
        audit({
          action: "ai.budget_threshold",
          project,
          target: month,
          meta: { spentUsd: Number(spent.toFixed(4)), budgetUsd: cfg.budgetUsd, pct: cfg.budgetSoftPct, hard: cfg.budgetHard },
        }),
      );
    })
    .catch(() => {});
}

// ---- response cache ---------------------------------------------------------

let cacheDownUntil = 0;

const cacheKey = (project: string, endpoint: string, body: Record<string, unknown>) =>
  `${aiCachePrefix(project)}c:${createHash("sha256")
    .update(`${endpoint}\0${JSON.stringify(body)}`)
    .digest("hex")}`;

async function cacheGet(key: string): Promise<string | null> {
  if (Date.now() < cacheDownUntil) return null;
  try {
    return await send<string | null>("GET", [key]);
  } catch {
    cacheDownUntil = Date.now() + 30_000;
    return null;
  }
}

async function cacheSet(key: string, value: string, ttl: number) {
  if (Date.now() < cacheDownUntil || value.length > CACHE_MAX_BYTES) return;
  try {
    await send("SET", [key, value, "EX", ttl]);
  } catch {
    cacheDownUntil = Date.now() + 30_000;
  }
}

// ---- logging ----------------------------------------------------------------

interface Record_ {
  endpoint: AiEndpoint;
  target: Target | null;
  alias: string | null;
  status: number;
  error: string | null;
  stream: boolean;
  cached?: boolean;
  usage: Usage;
  ttfbMs: number | null;
  fallbackFrom: string[];
  requestText: string | null;
  responseText: string | null;
}

/** Writes the call's log row (and sealed content when capture is on). Returns the cost. */
async function record(call: GatewayCall, cfg: ProjectConfig, ext: Extension, start: number, r: Record_): Promise<number | null> {
  const { cost, source } = r.cached
    ? { cost: 0, source: "cache" as const }
    : r.target && r.status < 400
      ? resolveCost(r.target.def, r.target.model, r.usage, r.usage.providerCost, cfg.overrides)
      : { cost: null, source: null };
  const id = crypto.randomUUID();
  const at = new Date();
  const row: LogRow = {
    id,
    project: call.project,
    at,
    endpoint: r.endpoint,
    provider: r.target?.def.id ?? null,
    model: r.target?.model ?? null,
    alias: r.alias,
    status: r.status,
    error: r.error?.slice(0, 500) ?? null,
    stream: r.stream,
    cached: Boolean(r.cached),
    latency_ms: Math.round(performance.now() - start),
    ttfb_ms: r.ttfbMs === null ? null : Math.round(r.ttfbMs),
    input_tokens: r.usage.input,
    output_tokens: r.usage.output,
    cache_read_tokens: r.usage.cacheRead,
    cache_write_tokens: r.usage.cacheWrite,
    reasoning_tokens: r.usage.reasoning,
    images: r.usage.images,
    cost_usd: cost,
    cost_source: source,
    token_name: call.caller.tokenName,
    user_tag: ext.user ?? null,
    tags: pgArray(ext.tags ?? []),
    fallback_from: r.fallbackFrom.length ? r.fallbackFrom.join(",") : null,
    request_id: call.requestId,
  };
  let content: ContentRow | undefined;
  const master = secretsMaster();
  if (cfg.captureContent && master && (r.requestText || r.responseText)) {
    const seal = async (text: string | null) =>
      text ? Buffer.from(await sealBlob(master, new TextEncoder().encode(text.slice(0, AI_LIMITS.contentBytes)), `${call.project}\0ai\0${id}`)) : null;
    content = { request_id: id, project: call.project, at, request: await seal(r.requestText), response: await seal(r.responseText) };
  }
  pushLog(row, content);
  call.log.info("ai call", {
    endpoint: r.endpoint,
    model: r.target?.id ?? null,
    status: r.status,
    stream: r.stream,
    input: r.usage.input,
    output: r.usage.output,
    cost,
    ms: row.latency_ms,
    ...(r.fallbackFrom.length && { fallbacks: r.fallbackFrom.length }),
  });
  if (cost) budgetAlert(cfg, call.project);
  return cost;
}

// ---- upstream errors ----------------------------------------------------------

/** The provider's error message, if it sent one. */
function upstreamMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const err = body.error;
    return (typeof err === "string" ? err : err?.message) ?? body.message ?? null;
  } catch {
    return text.trim() ? text.trim().slice(0, 300) : null;
  }
}

const errorJson = (status: number, message: string, type = "upstream_error", extra: Record<string, unknown> = {}) =>
  Response.json({ error: { message, type, code: status, ...extra } }, { status });

// ---- core ---------------------------------------------------------------------

type UnifiedEndpoint = "chat" | "embeddings" | "images" | "responses";

const PATHS: Record<UnifiedEndpoint, string> = { chat: "/chat/completions", embeddings: "/embeddings", images: "/images/generations", responses: "/responses" };

/** What a target can't do, or null. */
function unsupported(def: ProviderDef, endpoint: UnifiedEndpoint): string | null {
  if (def.kind === "anthropic" && endpoint !== "chat")
    return `${def.id} has no ${endpoint === "embeddings" ? "embeddings" : endpoint === "images" ? "image generation" : "Responses API"} (use another provider)`;
  if (def.kind === "bedrock" && (endpoint === "images" || endpoint === "responses")) return `${def.id} has no ${endpoint} route in the gateway`;
  if (!def.endpoints[endpoint]) return `${def.id} doesn't support ${endpoint} through the gateway`;
  return null;
}

interface Prepared {
  /** null: answered without HTTP (Bedrock embeddings). */
  upstream: UpstreamRequest | null;
  direct?: () => Promise<{ json: unknown; usage: Usage }>;
  jsonTool?: boolean;
}

async function prepare(
  endpoint: UnifiedEndpoint,
  target: Target,
  keys: Record<string, string>,
  body: Record<string, unknown>,
  ext: Extension,
  signal: AbortSignal,
): Promise<Prepared> {
  const { def, model } = target;
  if (def.kind === "anthropic") {
    const { body: out, jsonTool } = toAnthropic({ ...body, mybase: { anthropic: ext.anthropic } }, model, maxOutputOf(def, model) ?? 4096);
    return { upstream: anthropicRequest(def, keys, out), jsonTool };
  }
  if (def.kind === "bedrock") {
    if (endpoint === "embeddings") return { upstream: null, direct: () => bedrockEmbed(def, keys, model, body, signal) };
    const { request, jsonTool } = await bedrockChatRequest(def, keys, body, model, maxOutputOf(def, model) ?? 4096);
    return { upstream: request, jsonTool };
  }
  return { upstream: openaiRequest(def, keys, PATHS[endpoint], body, model) };
}

/** Saves generated images to the project bucket (`mybase.store`). */
async function storeImages(project: string, prefix: string, json: { data?: { b64_json?: string; url?: string; mybase?: unknown }[] }, log: Logger) {
  const dir = prefix.endsWith("/") || prefix === "" ? prefix : `${prefix}/`;
  const publicBase = storageInfo(project).publicUrl;
  for (const [i, item] of (json.data ?? []).entries()) {
    let bytes: Uint8Array | null = null;
    let type = "image/png";
    if (item.b64_json) bytes = Buffer.from(item.b64_json, "base64");
    else if (item.url) {
      const res = await fetch(item.url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!res?.ok) continue;
      type = res.headers.get("content-type")?.split(";")[0] ?? type;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 25 * 1024 * 1024) continue;
      bytes = new Uint8Array(buf);
    }
    if (!bytes) continue;
    const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
    const key = `${dir}${new Date().toISOString().replace(/[:.]/g, "-")}-${i}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await file(project, key).write(bytes, { type });
    item.mybase = { key, ...(key.startsWith("public/") && { publicUrl: `${publicBase}${key.slice("public/".length)}` }) };
  }
  log.info("ai images stored", { images: json.data?.length ?? 0 });
}

/** A unified call (`/ai/:project/v1/<endpoint>`). */
export async function unified(endpoint: UnifiedEndpoint, call: GatewayCall): Promise<Response> {
  const start = performance.now();
  const cfg = await projectConfig(call.project);
  const body = call.body;
  const ext = readExtension(body, call.headers);
  const requestText = cfg.captureContent ? JSON.stringify(body) : null;
  const stream = (endpoint === "chat" || endpoint === "responses") && body.stream === true;
  const wantUsage = Boolean((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage);
  const base = { endpoint: endpoint as AiEndpoint, stream, fallbackFrom: [] as string[], requestText, responseText: null as string | null, ttfbMs: null };

  let alias: string | null = null;
  let targets: Target[];
  try {
    ({ alias, targets } = resolveModel(cfg, body.model));
    checkBudget(cfg, call.project);
    await checkRateLimit(cfg, call.project, call.caller, ext);
  } catch (err) {
    if (err instanceof TooManyRequestsError) {
      await record(call, cfg, ext, start, { ...base, target: null, alias, status: 429, error: err.message, usage: newUsage() });
    }
    throw err;
  }

  // Response cache: non-streamed chat and embeddings only, keyed on the full request.
  const cacheable = ext.cache !== undefined && !stream && (endpoint === "chat" || endpoint === "embeddings");
  const ckey = cacheable ? cacheKey(call.project, endpoint, body) : null;
  if (ckey) {
    const hit = await cacheGet(ckey);
    if (hit) {
      const usage = newUsage();
      readOpenAIUsage((JSON.parse(hit) as { usage?: unknown }).usage, usage);
      await record(call, cfg, ext, start, { ...base, target: targets[0]!, alias, status: 200, error: null, usage, cached: true, responseText: hit });
      return new Response(hit, { headers: { "Content-Type": "application/json", "X-Mybase-Cache": "hit" } });
    }
  }

  const keys = await providerKeys(call.project, cfg.keysEnv);
  const fallbackFrom: string[] = [];
  let last: { status: number; message: string; target: Target | null } = { status: 502, message: "no provider answered", target: null };

  for (const [i, target] of targets.entries()) {
    const more = i < targets.length - 1;
    const skip = (status: number, message: string) => {
      fallbackFrom.push(target.id);
      last = { status, message, target };
    };
    const missing = missingKeys(target.def, keys);
    if (missing.length) {
      const message = `provider "${target.def.id}" has no ${missing.join(", ")} in secrets env "${cfg.keysEnv}"`;
      if (more) {
        skip(409, message);
        continue;
      }
      await record(call, cfg, ext, start, { ...base, target, alias, status: 409, error: message, usage: newUsage(), fallbackFrom });
      throw new ConflictError(message);
    }
    const why = unsupported(target.def, endpoint);
    if (why) {
      if (more) {
        skip(400, why);
        continue;
      }
      await record(call, cfg, ext, start, { ...base, target, alias, status: 400, error: why, usage: newUsage(), fallbackFrom });
      throw new BadRequestError(why);
    }

    const signal = stream ? call.signal : AbortSignal.any([call.signal, AbortSignal.timeout(NON_STREAM_TIMEOUT_MS)]);
    const prepared = await prepare(endpoint, target, keys, { ...body }, ext, signal);
    const usage = newUsage();

    if (prepared.direct) {
      try {
        const { json, usage: u } = await prepared.direct();
        Object.assign(usage, u);
        const text = JSON.stringify(json);
        if (ckey) void cacheSet(ckey, text, ext.cache!);
        await record(call, cfg, ext, start, { ...base, target, alias, status: 200, error: null, usage, fallbackFrom, responseText: cfg.captureContent ? text : null });
        return new Response(text, { headers: { "Content-Type": "application/json", "X-Mybase-Model": target.id } });
      } catch (err) {
        const message = err instanceof Error ? err.message : "the provider failed";
        const status = err instanceof BadRequestError ? 400 : 502;
        if (more && status !== 400) {
          skip(status, message);
          continue;
        }
        await record(call, cfg, ext, start, { ...base, target, alias, status, error: message, usage, fallbackFrom });
        throw err;
      }
    }

    const up = prepared.upstream!;
    let res: Response;
    try {
      res = await fetch(up.url, { ...up.init, signal, redirect: "error" });
    } catch (err) {
      if (call.signal.aborted) {
        await record(call, cfg, ext, start, { ...base, target, alias, status: 499, error: "the client went away", usage, fallbackFrom });
        return new Response(null, { status: 499 });
      }
      const message = (err as Error).name === "TimeoutError" ? `${target.def.name} timed out` : `${target.def.name} is unreachable`;
      call.log.warn("ai provider unreachable", { provider: target.def.id, err });
      if (more) {
        skip(502, message);
        continue;
      }
      await record(call, cfg, ext, start, { ...base, target, alias, status: 502, error: message, usage, fallbackFrom });
      return errorJson(502, message, "upstream_unreachable", { provider: target.def.id });
    }
    const ttfbMs = performance.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = upstreamMessage(text) ?? `${target.def.name} answered ${res.status}`;
      if (more && RETRYABLE(res.status)) {
        skip(res.status, message);
        continue;
      }
      await record(call, cfg, ext, start, { ...base, target, alias, status: res.status, error: message, usage, ttfbMs, fallbackFrom });
      const headers: Record<string, string> = {};
      const retry = res.headers.get("retry-after");
      if (retry) headers["Retry-After"] = retry;
      return Response.json({ error: { message, type: "upstream_error", code: res.status, provider: target.def.id } }, { status: res.status, headers });
    }

    const responseHeaders: Record<string, string> = { "X-Mybase-Model": target.id };
    if (fallbackFrom.length) responseHeaders["X-Mybase-Fallback-From"] = fallbackFrom.join(",");

    if (stream && res.body) {
      let firstAt: number | null = null;
      let captured = "";
      const hooks: StreamHooks = {
        first: () => (firstAt ??= performance.now() - start),
        tap: cfg.captureContent ? (s) => void (captured.length < AI_LIMITS.contentBytes && (captured += s)) : undefined,
        done: (error) => {
          const aborted = error !== null && error !== undefined;
          void record(call, cfg, ext, start, {
            ...base,
            target,
            alias,
            status: aborted ? 499 : 200,
            error: aborted ? "the stream ended early" : null,
            usage,
            ttfbMs: firstAt,
            fallbackFrom,
            responseText: cfg.captureContent ? captured : null,
          });
        },
      };
      let out: ReadableStream<Uint8Array>;
      if (target.def.kind === "anthropic") out = anthropicStream(res.body, target.id, prepared.jsonTool ?? false, usage, wantUsage, hooks);
      else if (target.def.kind === "bedrock") out = converseStream(res.body, target.id, prepared.jsonTool ?? false, usage, wantUsage, hooks);
      else if (endpoint === "responses") out = responsesStream(res.body, usage, hooks);
      else out = openaiChatStream(res.body, usage, wantUsage, hooks);
      return new Response(out, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...responseHeaders },
      });
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      const message = `${target.def.name} sent an answer that isn't JSON`;
      await record(call, cfg, ext, start, { ...base, target, alias, status: 502, error: message, usage, ttfbMs, fallbackFrom });
      return errorJson(502, message);
    }
    if (target.def.kind === "anthropic") json = fromAnthropic(json, target.id, prepared.jsonTool ?? false, usage);
    else if (target.def.kind === "bedrock") json = fromConverse(json, target.id, prepared.jsonTool ?? false, usage);
    else openaiUsage(json, usage);
    if (endpoint === "images") {
      const data = (json as { data?: unknown[] }).data;
      usage.images = Array.isArray(data) ? data.length : 0;
      if (ext.store !== undefined)
        await storeImages(call.project, ext.store, json as Parameters<typeof storeImages>[2], call.log).catch((err) => call.log.warn("storing ai images failed", { err }));
    }
    const text = JSON.stringify(json);
    if (ckey) void cacheSet(ckey, text, ext.cache!);
    const cost = await record(call, cfg, ext, start, {
      ...base,
      target,
      alias,
      status: 200,
      error: null,
      usage,
      ttfbMs,
      fallbackFrom,
      responseText: cfg.captureContent ? (endpoint === "images" ? text.replace(/"b64_json":"[^"]*"/g, '"b64_json":"(omitted)"') : text) : null,
    });
    if (cost !== null) responseHeaders["X-Mybase-Cost"] = String(cost);
    return new Response(text, { headers: { "Content-Type": "application/json", ...responseHeaders } });
  }

  // Every target failed with something worth falling back from.
  await record(call, cfg, ext, start, {
    ...base,
    target: last.target,
    alias,
    status: last.status,
    error: last.message,
    usage: newUsage(),
    fallbackFrom: fallbackFrom.slice(0, -1),
  });
  return errorJson(last.status === 409 ? 409 : 502, `every model in "${body.model}" failed; the last error: ${last.message}`, "all_targets_failed");
}

// ---- models list (OpenAI format) ------------------------------------------------

export async function modelsList(project: string): Promise<{ object: "list"; data: { id: string; object: "model"; owned_by: string; created: number }[] }> {
  const cfg = await projectConfig(project);
  const keys = await providerKeys(project, cfg.keysEnv).catch(() => ({}) as Record<string, string>);
  const catalog = currentCatalog();
  const data: { id: string; object: "model"; owned_by: string; created: number }[] = [];
  for (const alias of await listAliases(project)) data.push({ id: alias.name, object: "model", owned_by: "mybase", created: 0 });
  for (const def of providersOf(cfg)) {
    if (missingKeys(def, keys).length) continue;
    const ids = def.pricesId ? Object.keys(catalog.providers[def.pricesId] ?? {}) : [];
    for (const m of ids) data.push({ id: `${def.id}/${m}`, object: "model", owned_by: def.id, created: 0 });
  }
  return { object: "list", data };
}

// ---- internal calls (vector, memory) ----------------------------------------------

const INTERNAL_CALLER = (tag: string): Caller => ({ tokenName: `mybase:${tag}`, tokenId: `mybase:${tag}` });

async function internal(endpoint: UnifiedEndpoint, project: string, body: Record<string, unknown>, tag: string, log: Logger, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await unified(endpoint, {
    project,
    body: { ...body, mybase: { tags: [tag] } },
    headers: new Headers(),
    signal: AbortSignal.timeout(timeoutMs),
    caller: INTERNAL_CALLER(tag),
    requestId: null,
    log,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const message = (json?.error as { message?: string } | undefined)?.message ?? `the AI gateway answered ${res.status}`;
    throw new UpstreamError(message);
  }
  return json;
}

/** Embeds `inputs` through the gateway (logged, priced, tagged). One vector per input. */
export async function embedInternal(project: string, model: string, inputs: string[], opts: { tag: string; log: Logger; dimensions?: number }): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 64) {
    const batch = inputs.slice(i, i + 64);
    const json = await internal("embeddings", project, { model, input: batch, ...(opts.dimensions && { dimensions: opts.dimensions }) }, opts.tag, opts.log, 60_000);
    const rows = (json.data ?? []) as { embedding?: unknown; index?: number }[];
    if (rows.length !== batch.length) throw new UpstreamError("the embedding model returned a different number of vectors than inputs");
    const vectors = new Array<number[]>(batch.length);
    rows.forEach((r, j) => {
      if (!Array.isArray(r.embedding)) throw new UpstreamError("the embedding model returned something other than a vector");
      vectors[typeof r.index === "number" ? r.index : j] = r.embedding as number[];
    });
    out.push(...vectors);
  }
  return out;
}

/** A non-streamed chat completion through the gateway (OpenAI format). */
export async function chatInternal(project: string, body: Record<string, unknown>, opts: { tag: string; log: Logger }): Promise<Record<string, unknown>> {
  return internal("chat", project, { ...body, stream: false }, opts.tag, opts.log, 180_000);
}

/** Dimensions of an embedding model, from the catalog. */
export async function embeddingDimensions(project: string, model: string): Promise<number | null> {
  const cfg = await projectConfig(project);
  const target = parseTarget(cfg, model);
  const entry = catalogModel(target.def, target.model);
  return modelType(entry, target.model) === "embedding" ? (entry?.output ?? null) : null;
}

// ---- native passthrough -------------------------------------------------------------

const NATIVE_PATHS: Record<string, RegExp> = {
  openai: /^(chat\/completions|responses|embeddings|images\/(generations|edits)|audio\/(speech|transcriptions)|models)$/,
  anthropic: /^v1\/(messages|messages\/count_tokens|models)$/,
  google: /^v1beta\/models(\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent|embedContent|batchEmbedContents|predict))?$/,
};

const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"];
const RETURN_HEADERS = ["content-type", "retry-after", "request-id", "x-request-id"];

export interface NativeCall {
  project: string;
  provider: string;
  /** Path after `/native/<provider>/`. */
  path: string;
  search: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  signal: AbortSignal;
  caller: Caller;
  requestId: string | null;
  log: Logger;
}

function nativeModel(def: ProviderDef, path: string, body: unknown): string | null {
  if (def.id === "google") return /models\/([^/:]+):/.exec(path)?.[1] ?? null;
  const m = (body as { model?: unknown } | null)?.model;
  return typeof m === "string" ? m : null;
}

/** Usage from a native answer, whatever the format (OpenAI, Anthropic, Gemini). */
function nativeUsage(value: unknown, usage: Usage) {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.type === "message_start") anthropicUsage((v.message as { usage?: unknown } | undefined)?.usage, usage);
  else if (v.type === "message_delta" || (v.type === "message" && v.usage)) anthropicUsage(v.usage, usage);
  else if (v.type === "response.completed") readOpenAIUsage((v.response as { usage?: unknown } | undefined)?.usage, usage);
  else if (v.usageMetadata) {
    const u = v.usageMetadata as Record<string, number | undefined>;
    usage.input = u.promptTokenCount ?? usage.input;
    usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || usage.output;
    usage.cacheRead = u.cachedContentTokenCount ?? usage.cacheRead;
    usage.reasoning = u.thoughtsTokenCount ?? usage.reasoning;
  } else if (v.usage) openaiUsage(v, usage);
}

export async function native(call: NativeCall): Promise<Response> {
  const start = performance.now();
  const cfg = await projectConfig(call.project);
  const def = findProvider(cfg, call.provider);
  if (!def) throw new NotFoundError(`unknown provider "${call.provider}"`);
  if (def.kind === "bedrock") throw new BadRequestError("Bedrock has no native passthrough; use the unified /v1 routes");
  const pattern = def.id === "google" ? NATIVE_PATHS.google! : NATIVE_PATHS[def.kind]!;
  if (!pattern.test(call.path)) throw new NotFoundError(`"${call.path}" isn't a ${def.name} route the gateway passes through`);
  const ext: Extension = {
    tags: (call.headers.get("x-mybase-tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, AI_LIMITS.tags),
    user: call.headers.get("x-mybase-user") ?? undefined,
  };

  const isJson = (call.headers.get("content-type") ?? "").includes("json");
  let parsed: unknown = null;
  if (call.body && isJson) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.body));
    } catch {
      throw new BadRequestError("expected a JSON body");
    }
  }
  const model = nativeModel(def, call.path, parsed);
  const base = {
    endpoint: "native" as AiEndpoint,
    alias: null,
    fallbackFrom: [] as string[],
    requestText: cfg.captureContent && call.body && isJson ? new TextDecoder().decode(call.body) : null,
    responseText: null,
  };
  const target: Target | null = model ? { def, model, id: `${def.id}/${model}` } : null;
  const stream = Boolean((parsed as { stream?: unknown } | null)?.stream) || call.path.includes("streamGenerateContent");
  if (target) {
    if (cfg.allowedModels && !cfg.allowedModels.some((g) => globMatch(g, target.id))) throw new ForbiddenError(`model "${target.id}" isn't in this project's allowed models`);
    try {
      checkBudget(cfg, call.project);
      await checkRateLimit(cfg, call.project, call.caller, ext);
    } catch (err) {
      if (err instanceof TooManyRequestsError)
        await record(call as unknown as GatewayCall, cfg, ext, start, { ...base, target, status: 429, error: err.message, stream, usage: newUsage(), ttfbMs: null });
      throw err;
    }
  }

  const keys = await providerKeys(call.project, cfg.keysEnv);
  const missing = missingKeys(def, keys);
  if (missing.length) throw new ConflictError(`provider "${def.id}" has no ${missing.join(", ")} in secrets env "${cfg.keysEnv}"`);
  const root = (envBase(def, true) ?? def.nativeBase ?? baseUrlFor(def, keys)).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = call.headers.get(h);
    if (v) headers[h] = v;
  }
  Object.assign(headers, authHeaders(def, keys, true));
  if (def.kind === "anthropic" && call.headers.get("anthropic-version")) headers["anthropic-version"] = call.headers.get("anthropic-version")!;
  // A `key` query param (Google's REST style) would hand the mybase key to the provider.
  const search = new URLSearchParams(call.search);
  search.delete("key");
  const url = `${root}/${call.path}${search.size ? `?${search}` : ""}`;
  const logCall = call as unknown as GatewayCall;

  let res: Response;
  try {
    res = await fetch(url, { method: call.method, headers, body: (call.body ?? undefined) as BodyInit | undefined, signal: call.signal, redirect: "error" });
  } catch (err) {
    if (call.signal.aborted) return new Response(null, { status: 499 });
    call.log.warn("ai provider unreachable", { provider: def.id, err });
    await record(logCall, cfg, ext, start, { ...base, target, status: 502, error: `${def.name} is unreachable`, stream, usage: newUsage(), ttfbMs: null });
    return errorJson(502, `${def.name} is unreachable`, "upstream_unreachable");
  }
  const ttfbMs = performance.now() - start;
  const outHeaders = new Headers();
  for (const h of RETURN_HEADERS) {
    const v = res.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  const usage = newUsage();
  const logged = call.method !== "GET" && !call.path.endsWith("count_tokens");

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (logged)
      await record(logCall, cfg, ext, start, { ...base, target, status: res.status, error: upstreamMessage(text) ?? `${def.name} answered ${res.status}`, stream, usage, ttfbMs });
    return new Response(text, { status: res.status, headers: outHeaders });
  }
  if (!logged) return new Response(res.body, { status: res.status, headers: outHeaders });

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const parser = new SseParser();
    let captured = "";
    const read = (events: ReturnType<SseParser["feed"]>) => {
      for (const e of events) {
        if (e.data === "[DONE]") continue;
        try {
          nativeUsage(JSON.parse(e.data), usage);
        } catch {
          // not JSON: passed on as is
        }
      }
    };
    const out = transformText(
      res.body,
      {
        chunk: (text, push) => {
          read(parser.feed(text));
          push(text);
        },
        flush: () => read(parser.end()),
        done: (error) => {
          const aborted = error !== null && error !== undefined;
          void record(logCall, cfg, ext, start, {
            ...base,
            target,
            status: aborted ? 499 : 200,
            error: aborted ? "the stream ended early" : null,
            stream: true,
            usage,
            ttfbMs,
            responseText: cfg.captureContent ? captured : null,
          });
        },
      },
      cfg.captureContent ? (s) => void (captured.length < AI_LIMITS.contentBytes && (captured += s)) : undefined,
    );
    return new Response(out, { status: res.status, headers: outHeaders });
  }

  // JSON (or a JSON array stream from Gemini without alt=sse): buffered to read usage at the end.
  const buf = new Uint8Array(await res.arrayBuffer());
  if (contentType.includes("json")) {
    try {
      const value = JSON.parse(new TextDecoder().decode(buf));
      for (const item of Array.isArray(value) ? value : [value]) nativeUsage(item, usage);
      if (call.path.startsWith("images/")) usage.images = Array.isArray((value as { data?: unknown[] }).data) ? (value as { data: unknown[] }).data.length : 0;
    } catch {
      // usage unknown
    }
  }
  const responseText = cfg.captureContent && contentType.includes("json") ? new TextDecoder().decode(buf).replace(/"b64_json":"[^"]*"/g, '"b64_json":"(omitted)"') : null;
  const cost = await record(logCall, cfg, ext, start, { ...base, target, status: res.status, error: null, stream, usage, ttfbMs, responseText });
  if (cost !== null) outHeaders.set("X-Mybase-Cost", String(cost));
  return new Response(buf, { status: res.status, headers: outHeaders });
}

// ---- provider test ------------------------------------------------------------------

/** A cheap authenticated call (list models) to check a provider's keys and URL. */
export async function testProvider(project: string, id: string, log: Logger): Promise<{ ok: boolean; status: number | null; ms: number; message: string }> {
  const cfg = await projectConfig(project);
  const def = findProvider(cfg, id);
  if (!def) throw new NotFoundError(`unknown provider "${id}"`);
  const keys = await providerKeys(project, cfg.keysEnv);
  const missing = missingKeys(def, keys);
  if (missing.length) return { ok: false, status: null, ms: 0, message: `missing ${missing.join(", ")} in secrets env "${cfg.keysEnv}"` };
  const start = performance.now();
  let req: Request;
  if (def.kind === "bedrock") {
    const { AwsClient } = await import("aws4fetch");
    const region = keys.AWS_REGION ?? "us-east-1";
    const aws = new AwsClient({ accessKeyId: keys.AWS_ACCESS_KEY_ID ?? "", secretAccessKey: keys.AWS_SECRET_ACCESS_KEY ?? "", region, service: "bedrock" });
    req = await aws.sign(`https://bedrock.${region}.amazonaws.com/foundation-models?byOutputModality=TEXT`, { method: "GET" });
  } else {
    const root = def.kind === "anthropic" ? `${baseUrlFor(def, keys)}/v1` : baseUrlFor(def, keys);
    req = new Request(`${root}/models`, { headers: authHeaders(def, keys) });
  }
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    const ms = Math.round(performance.now() - start);
    const text = res.ok ? "" : await res.text().catch(() => "");
    log.info("ai provider tested", { provider: id, status: res.status });
    return { ok: res.ok, status: res.status, ms, message: res.ok ? "the provider accepted the key" : (upstreamMessage(text) ?? `answered ${res.status}`) };
  } catch (err) {
    return { ok: false, status: null, ms: Math.round(performance.now() - start), message: (err as Error).name === "TimeoutError" ? "timed out" : "unreachable" };
  }
}

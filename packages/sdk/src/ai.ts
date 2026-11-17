// The AI gateway: one endpoint for every LLM provider. Provider keys live in mybase (the
// project's secrets env `ai`); apps only hold a mybase API key. Every call is logged and priced.
//
// The gateway speaks the OpenAI wire format, so any OpenAI SDK works by changing `baseURL`:
//
//   import OpenAI from "openai";
//   const ai = createAI({ apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   const openai = new OpenAI({ baseURL: ai.baseURL, apiKey: process.env.MYBASE_API_KEY!, defaultHeaders: ai.headers({ tags: ["checkout"] }) });
//   await openai.chat.completions.create({ model: "anthropic/claude-sonnet-4-5", messages: [...] });
//
// Model ids are `<provider>/<model>` (`openai/gpt-5`, `vercel/anthropic/claude-haiku-4.5`) or a
// project alias (`fast`), which can list fallbacks. Native SDKs (Anthropic, Gemini) use
// `nativeBaseURL(provider)` and are logged the same way.
//
// Zero dependencies: chat, streaming chat, embeddings, and images are also here as plain fetch calls.
import { MybaseApiError } from "./cron";

export { MybaseApiError };

/** Alias names: no `/`, so they can't be mistaken for `<provider>/<model>`. */
export const AI_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
export const AI_ALIAS_RULES = "Use 1–48 lowercase letters, digits, `-`, or `_`, starting with a letter.";
/** Custom provider ids (Ollama, LM Studio, vLLM, …). */
export const AI_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export const AI_LIMITS = {
  /** Targets per alias: the first, then fallbacks in order. */
  aliasTargets: 5,
  aliasesPerProject: 100,
  customProviders: 20,
  priceOverrides: 200,
  /** Tags per request (`mybase.tags` or `X-Mybase-Tags`). */
  tags: 10,
  tagLength: 64,
  /** A request body: images as base64 make chat requests big. */
  bodyBytes: 25 * 1024 * 1024,
  /** Captured prompt and response, each. */
  contentBytes: 256 * 1024,
  logRetentionDays: { min: 1, max: 365, default: 30 },
  contentRetentionDays: { min: 1, max: 90, default: 7 },
} as const;

export type AiProviderKind = "openai" | "anthropic" | "bedrock";
export type AiEndpoint = "chat" | "embeddings" | "images" | "responses" | "native";
export type AiModelType = "chat" | "embedding" | "image";
/** Where a logged cost came from: the provider's own number, a project override, the price catalog, or nothing (unpriced). */
export type AiCostSource = "provider" | "override" | "catalog" | "cache";

/** USD per 1M tokens, or per image / per request. */
export interface AiPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  perImage?: number;
  perRequest?: number;
}

export interface AiPriceOverride extends AiPrice {
  /** `<provider>/<model>`, or a glob like `openai/gpt-5*`. */
  model: string;
}

export interface AiProviderStatus {
  id: string;
  name: string;
  kind: AiProviderKind;
  custom: boolean;
  /** Custom providers, and Azure once its resource name is set. */
  baseUrl: string | null;
  /** Secrets keys this provider reads from the keys env. */
  keys: string[];
  /** Which of `keys` are missing (names only). */
  missing: string[];
  configured: boolean;
  endpoints: { chat: boolean; embeddings: boolean; images: boolean; responses: boolean; native: boolean };
  /** The provider's docs (from the models.dev catalog); null for custom providers. */
  docUrl: string | null;
  /** Models in the catalog; null for custom providers (listed live once configured). */
  models: number | null;
}

export interface AiAlias {
  name: string;
  /** Model ids, tried in order. */
  targets: string[];
  source: "dashboard" | "code";
}

export interface AiModel {
  /** `<provider>/<model>`. */
  id: string;
  provider: string;
  name: string;
  type: AiModelType;
  contextWindow: number | null;
  maxOutput: number | null;
  /** Embedding models: vector length. */
  dimensions: number | null;
  /** What the gateway charges against the budget (override, else catalog). */
  price: AiPrice | null;
  priceSource: "override" | "catalog" | null;
  /** Whether the provider's keys are set. */
  configured: boolean;
  /** From the catalog; false when unknown. */
  reasoning: boolean;
  toolCall: boolean;
  /** Takes images as input. */
  vision: boolean;
  openWeights: boolean;
  /** YYYY-MM-DD (or YYYY-MM), when known. */
  releaseDate: string | null;
  /** Training data cutoff, YYYY-MM, when known. */
  knowledge: string | null;
}

export interface AiSettings {
  apiUrl: string;
  /** `baseURL` for OpenAI-compatible SDKs. */
  baseURL: string;
  /** Prefix for native SDKs: `<nativeBaseURL>/<provider>`. */
  nativeBaseURL: string;
  /** The secrets env provider keys are read from. */
  keysEnv: string;
  /** Store prompts and responses (sealed) for the logs. Off by default. */
  captureContent: boolean;
  contentRetentionDays: number;
  logRetentionDays: number;
  /** Monthly budget in USD; null = none. */
  budgetUsd: number | null;
  /** Percent of the budget that raises an alert (once a month). */
  budgetSoftPct: number;
  /** Refuse calls (429) once the budget is spent. */
  budgetHard: boolean;
  /** Model id globs apps may call; null = any. */
  allowedModels: string[] | null;
  /** A rate limit rule (ratelimit service) checked before each call. */
  ratelimitRule: string | null;
  /** Count the rule per API key or per end user (`mybase.user`). */
  ratelimitBy: "token" | "user";
  monthToDateUsd: number;
  enabledAt: string;
}

export type UpdateAiSettingsRequest = Partial<
  Pick<
    AiSettings,
    "keysEnv" | "captureContent" | "contentRetentionDays" | "logRetentionDays" | "budgetUsd" | "budgetSoftPct" | "budgetHard" | "allowedModels" | "ratelimitRule" | "ratelimitBy"
  >
>;

export interface AiLogEntry {
  id: string;
  at: string;
  endpoint: AiEndpoint;
  provider: string | null;
  model: string | null;
  alias: string | null;
  status: number;
  error: string | null;
  stream: boolean;
  /** Served from the response cache (`X-Mybase-Cache`). */
  cached: boolean;
  latencyMs: number;
  ttfbMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  images: number;
  costUsd: number | null;
  costSource: AiCostSource | null;
  tokenName: string | null;
  user: string | null;
  tags: string[];
  /** Targets that failed before this one answered. */
  fallbackFrom: string | null;
  requestId: string | null;
  /** Whether the prompt and response were captured (`GET …/logs/:id`). */
  hasContent: boolean;
}

export interface AiLogDetail extends AiLogEntry {
  /** Only when content capture was on; JSON as sent, cut at 256 KB. */
  content: { request: string | null; response: string | null } | null;
}

export interface AiLogsResponse {
  logs: AiLogEntry[];
  /** Pass as `before` for the next page. */
  next: string | null;
}

export type AiUsageGroup = "model" | "provider" | "tag" | "key";

export interface AiUsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface AiUsageResponse {
  from: string;
  to: string;
  bucket: "hour" | "day";
  totals: AiUsageTotals & { avgLatencyMs: number | null; unpriced: number };
  series: (AiUsageTotals & { at: string })[];
  groups: (AiUsageTotals & { key: string })[];
}

export interface SyncAiResponse {
  aliases: { created: string[]; updated: string[]; deleted: string[]; unchanged: string[] };
  prices: { set: string[]; deleted: string[] };
}

/** Request extension: send `mybase: {…}` in the body, or the matching `X-Mybase-*` headers. */
export interface AiRequestOptions {
  /** Labels for the logs and usage reports (`X-Mybase-Tags: a,b`). */
  tags?: string[];
  /** Your end user's id (`X-Mybase-User`). OpenAI's `user` field works too. */
  user?: string;
  /** Cache this answer for this many seconds (non-streamed chat and embeddings; `X-Mybase-Cache`). */
  cache?: number;
}

// ---- client -----------------------------------------------------------------

export interface AIClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `ai:write` for this project. Server-side only. */
  apiKey: string;
  /** Default 600000 (10 minutes): long generations take a while. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

/** OpenAI's chat completion request. Unknown fields go to the provider as they are. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: { type: "text" | "json_object" } | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  user?: string;
  mybase?: AiRequestOptions;
  [key: string]: unknown;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: ChatMessage & { role: "assistant" }; finish_reason: string | null }[];
  usage?: ChatUsage;
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string | null; tool_calls?: (Partial<ChatToolCall> & { index: number; function?: { name?: string; arguments?: string } })[] };
    finish_reason: string | null;
  }[];
  usage?: ChatUsage | null;
}

export interface EmbeddingResponse {
  object: "list";
  data: { object: "embedding"; index: number; embedding: number[] }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  response_format?: "url" | "b64_json";
  /** mybase: `store: "images/"` saves each image to the project's bucket under that prefix. */
  mybase?: AiRequestOptions & { store?: string };
  [key: string]: unknown;
}

export interface ImageResponse {
  created: number;
  data: { url?: string; b64_json?: string; revised_prompt?: string; mybase?: { key: string; publicUrl?: string } }[];
}

export interface AIClient {
  /** For OpenAI-compatible SDKs: `new OpenAI({ baseURL, apiKey })`, `createOpenAICompatible({ baseURL, … })`. */
  readonly baseURL: string;
  /** For a provider's own SDK, e.g. `new Anthropic({ baseURL: ai.nativeBaseURL("anthropic"), apiKey })`. */
  nativeBaseURL(provider: string): string;
  /** `X-Mybase-*` headers for SDKs that can't send extra body fields. */
  headers(options?: AiRequestOptions): Record<string, string>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Streams chunks; the last one carries `usage`. */
  chatStream(request: ChatRequest): AsyncIterable<ChatChunk>;
  embed(model: string, input: string | string[], options?: AiRequestOptions & { dimensions?: number }): Promise<EmbeddingResponse>;
  image(request: ImageRequest): Promise<ImageResponse>;
  /** Models of providers with keys set, plus the project's aliases. */
  models(): Promise<{ object: "list"; data: { id: string; object: "model"; owned_by: string }[] }>;
}

/** `X-Mybase-*` headers for request options. */
export function aiHeaders(options: AiRequestOptions = {}): Record<string, string> {
  const h: Record<string, string> = {};
  if (options.tags?.length) h["X-Mybase-Tags"] = options.tags.join(",");
  if (options.user) h["X-Mybase-User"] = options.user;
  if (options.cache) h["X-Mybase-Cache"] = String(options.cache);
  return h;
}

export function createAI(options: AIClientOptions): AIClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = `${options.apiUrl.replace(/\/+$/, "")}/ai/${encodeURIComponent(options.project)}`;
  const baseURL = `${root}/v1`;
  const timeoutMs = options.timeoutMs ?? 600_000;

  async function post(path: string, body: unknown): Promise<Response> {
    const res = await doFetch(`${baseURL}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await apiError(res);
    return res;
  }

  return {
    baseURL,
    nativeBaseURL: (provider) => `${root}/native/${encodeURIComponent(provider)}`,
    headers: aiHeaders,
    chat: async (request) => (await (await post("/chat/completions", { ...request, stream: false })).json()) as ChatResponse,
    async *chatStream(request) {
      const res = await post("/chat/completions", { ...request, stream: true, stream_options: { include_usage: true } });
      for await (const event of readSse(res.body!)) {
        if (event.data === "[DONE]") return;
        const chunk = JSON.parse(event.data) as ChatChunk & { error?: { message?: string } };
        if (chunk.error) throw new MybaseApiError(chunk.error.message ?? "the stream failed", 502);
        yield chunk;
      }
    },
    embed: async (model, input, opts = {}) => {
      const { dimensions, ...mybase } = opts;
      return (await (await post("/embeddings", { model, input, ...(dimensions && { dimensions }), mybase })).json()) as EmbeddingResponse;
    },
    image: async (request) => (await (await post("/images/generations", request)).json()) as ImageResponse,
    async models() {
      const res = await doFetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw await apiError(res);
      return res.json() as Promise<{ object: "list"; data: { id: string; object: "model"; owned_by: string }[] }>;
    },
  };
}

async function apiError(res: Response): Promise<MybaseApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string | { message?: string } };
  const message = typeof data.error === "string" ? data.error : data.error?.message;
  return new MybaseApiError(message ?? `mybase API answered ${res.status}`, res.status);
}

/** Server-sent events from a response body: `{ event, data }` per message. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === "\r" ? 2 : 1));
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = null;
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
}

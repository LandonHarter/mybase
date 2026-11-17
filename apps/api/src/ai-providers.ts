// The AI gateway's built-in providers (pure catalog). `kind` says how a call is made:
// `openai` forwards the OpenAI wire format, `anthropic` and `bedrock` are translated
// (ai-adapters/). Key names are the AI SDK / models.dev env names, so the same secrets env also
// works with `mybase run` for admins who want it. Custom providers (Ollama, vLLM, …) are rows in
// `mybase.ai_providers`, always `openai` kind.
import type { AiProviderKind } from "@mybase-dev/sdk/ai";

export interface ProviderDef {
  id: string;
  name: string;
  kind: AiProviderKind;
  /** Unified (OpenAI-format) base URL. `{resource}` is filled from AZURE_RESOURCE_NAME. */
  baseUrl: string;
  /** Secrets keys it needs, all of them. */
  keys: string[];
  /** Other names accepted for a key (the first set one wins). */
  keyFallbacks?: Record<string, string[]>;
  /** How the key is sent. */
  auth: "bearer" | "x-api-key" | "api-key" | "x-goog-api-key" | "sigv4";
  endpoints: { chat: boolean; embeddings: boolean; images: boolean; responses: boolean };
  /** Native passthrough base (`/ai/:p/native/<id>/…`) when it differs from `baseUrl`. */
  nativeBase?: string;
  /** Native auth when it differs (Gemini's own API takes `x-goog-api-key`). */
  nativeAuth?: ProviderDef["auth"];
  /** models.dev provider id for prices. */
  pricesId: string | null;
  /** Fixed headers for every call. */
  headers?: Record<string, string>;
  custom?: boolean;
}

const ALL = { chat: true, embeddings: true, images: true, responses: true };
const CHAT = { chat: true, embeddings: false, images: false, responses: false };

export const AI_PROVIDERS: Record<string, ProviderDef> = {
  openai: { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], auth: "bearer", endpoints: ALL, pricesId: "openai" },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keys: ["ANTHROPIC_API_KEY"],
    auth: "x-api-key",
    endpoints: CHAT,
    pricesId: "anthropic",
    headers: { "anthropic-version": "2023-06-01" },
  },
  google: {
    id: "google",
    name: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keys: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    keyFallbacks: { GOOGLE_GENERATIVE_AI_API_KEY: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: true, responses: false },
    nativeBase: "https://generativelanguage.googleapis.com",
    nativeAuth: "x-goog-api-key",
    pricesId: "google",
  },
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    kind: "openai",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keys: ["AI_GATEWAY_API_KEY"],
    auth: "bearer",
    endpoints: ALL,
    pricesId: "vercel",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keys: ["OPENROUTER_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: false, responses: true },
    pricesId: "openrouter",
  },
  azure: {
    id: "azure",
    name: "Azure OpenAI",
    kind: "openai",
    baseUrl: "https://{resource}.openai.azure.com/openai/v1",
    keys: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"],
    auth: "api-key",
    endpoints: ALL,
    pricesId: "azure",
  },
  bedrock: {
    id: "bedrock",
    name: "Amazon Bedrock",
    kind: "bedrock",
    baseUrl: "https://bedrock-runtime.{region}.amazonaws.com",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    auth: "sigv4",
    endpoints: { chat: true, embeddings: true, images: false, responses: false },
    pricesId: "amazon-bedrock",
  },
  groq: { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"], auth: "bearer", endpoints: CHAT, pricesId: "groq" },
  mistral: {
    id: "mistral",
    name: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keys: ["MISTRAL_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: false, responses: false },
    pricesId: "mistral",
  },
  xai: {
    id: "xai",
    name: "xAI",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    keys: ["XAI_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: false, images: true, responses: true },
    pricesId: "xai",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keys: ["DEEPSEEK_API_KEY"],
    auth: "bearer",
    endpoints: CHAT,
    pricesId: "deepseek",
  },
  together: {
    id: "together",
    name: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    keys: ["TOGETHER_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: true, responses: false },
    pricesId: "togetherai",
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keys: ["FIREWORKS_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: false, responses: false },
    pricesId: "fireworks-ai",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    keys: ["CEREBRAS_API_KEY"],
    auth: "bearer",
    endpoints: CHAT,
    pricesId: "cerebras",
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    keys: ["PERPLEXITY_API_KEY"],
    auth: "bearer",
    endpoints: CHAT,
    pricesId: "perplexity",
  },
  cohere: {
    id: "cohere",
    name: "Cohere",
    kind: "openai",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keys: ["COHERE_API_KEY"],
    auth: "bearer",
    endpoints: { chat: true, embeddings: true, images: false, responses: false },
    pricesId: "cohere",
  },
};

/** Built-in ids can't be reused by custom providers. */
export const BUILTIN_PROVIDER_IDS = new Set(Object.keys(AI_PROVIDERS));

/** A custom provider row as a definition. */
export function customProvider(row: { id: string; name: string; baseUrl: string; keyName: string | null }): ProviderDef {
  return {
    id: row.id,
    name: row.name,
    kind: "openai",
    baseUrl: row.baseUrl.replace(/\/+$/, ""),
    keys: row.keyName ? [row.keyName] : [],
    auth: "bearer",
    endpoints: ALL,
    pricesId: null,
    custom: true,
  };
}

/** The value of `name` in `keys`, trying its fallbacks. */
export function keyValue(def: ProviderDef, keys: Record<string, string>, name: string): string | undefined {
  for (const n of [name, ...(def.keyFallbacks?.[name] ?? [])]) if (keys[n]) return keys[n];
  return undefined;
}

/** Keys of `def` missing from `keys`. */
export const missingKeys = (def: ProviderDef, keys: Record<string, string>) => def.keys.filter((k) => !keyValue(def, keys, k));

/**
 * `MYBASE_AI_BASE_<ID>` replaces a built-in provider's base URL (a corporate proxy, a regional
 * endpoint, or a local fake in tests). The admin sets it, like any env var.
 */
export const envBase = (def: ProviderDef, native = false): string | undefined =>
  def.custom ? undefined : process.env[`MYBASE_AI_${native ? "NATIVE_" : ""}BASE_${def.id.toUpperCase()}`]?.replace(/\/+$/, "");

/** The unified base URL with placeholders filled. */
export function baseUrlFor(def: ProviderDef, keys: Record<string, string>): string {
  return (envBase(def) ?? def.baseUrl)
    .replace("{resource}", encodeURIComponent(keyValue(def, keys, "AZURE_RESOURCE_NAME") ?? ""))
    .replace("{region}", encodeURIComponent(keyValue(def, keys, "AWS_REGION") ?? "us-east-1"));
}

/** Auth headers for a call (not for sigv4, which signs the whole request). */
export function authHeaders(def: ProviderDef, keys: Record<string, string>, native = false): Record<string, string> {
  const key = def.keys[0] ? keyValue(def, keys, def.keys[0]) : undefined;
  const headers: Record<string, string> = { ...def.headers };
  if (!key) return headers;
  switch (native ? (def.nativeAuth ?? def.auth) : def.auth) {
    case "bearer":
      headers.Authorization = `Bearer ${key}`;
      break;
    case "x-api-key":
      headers["x-api-key"] = key;
      break;
    case "api-key":
      headers["api-key"] = key;
      break;
    case "x-goog-api-key":
      headers["x-goog-api-key"] = key;
      break;
  }
  return headers;
}

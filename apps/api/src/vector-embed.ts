// Embeddings for the vector service: calls the project's embedding provider, any
// OpenAI-compatible `POST <url>/embeddings` (OpenAI, Ollama, LM Studio, TEI, …). The admin sets
// the URL, so it may be on the LAN. Query embeddings are cached in Valkey (searches repeat);
// document embeddings aren't (each is used once). Texts and keys are never logged.
import { createHash } from "node:crypto";
import type { Logger } from "@mybase/shared/logger";
import { BadRequestError, ServiceUnavailableError, UpstreamError } from "./errors";
import { send } from "./valkey";

export interface Provider {
  url: string;
  model: string;
  dimensions: number;
  apiKey: string | null;
}

const BATCH = 64;
const TIMEOUT_MS = 30_000;
/** Longer inputs are cut: most models take 512–8192 tokens, and a token is ~4 characters. */
const MAX_INPUT_CHARS = 16_000;
const QUERY_TTL_S = 86_400;

export const cachePrefix = (project: string) => `mybase:vector:${project}:`;

/** One vector per input, in order. Checks each has the provider's dimensions. */
export async function embed(provider: Provider, inputs: string[], log: Logger): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    out.push(...(await embedBatch(provider, inputs.slice(i, i + BATCH).map((s) => s.slice(0, MAX_INPUT_CHARS)), log)));
  }
  return out;
}

async function embedBatch(provider: Provider, input: string[], log: Logger): Promise<number[][]> {
  let res: Response;
  try {
    res = await fetch(`${provider.url}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(provider.apiKey && { Authorization: `Bearer ${provider.apiKey}` }) },
      body: JSON.stringify({ model: provider.model, input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    log.warn("embedding provider unreachable", { host: new URL(provider.url).host, err });
    throw new ServiceUnavailableError("the embedding provider is unreachable");
  }
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } | string } | null)?.error;
    const message = typeof detail === "string" ? detail : detail?.message;
    log.warn("embedding provider error", { status: res.status });
    throw new UpstreamError(`the embedding provider answered ${res.status}${message ? `: ${message.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json().catch(() => null)) as { data?: { embedding?: unknown; index?: number }[] } | null;
  const rows = data?.data;
  if (!Array.isArray(rows) || rows.length !== input.length) throw new UpstreamError("the embedding provider's answer isn't in the OpenAI format");
  const vectors = new Array<number[]>(input.length);
  rows.forEach((row, i) => {
    const v = row.embedding;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) throw new UpstreamError("the embedding provider returned something other than a vector");
    if (v.length !== provider.dimensions) {
      throw new BadRequestError(`the embedding model returned ${v.length} dimensions, but the project's settings say ${provider.dimensions}`);
    }
    vectors[typeof row.index === "number" ? row.index : i] = v;
  });
  return vectors;
}

/** Embeds a search query, through the Valkey cache. */
export async function embedQuery(project: string, provider: Provider, text: string, log: Logger): Promise<number[]> {
  const key = `${cachePrefix(project)}q:${createHash("sha256").update(`${provider.url}\0${provider.model}\0${text}`).digest("hex").slice(0, 32)}`;
  const hit = await cacheGet(key, log);
  if (hit?.length === provider.dimensions) return hit;
  const [vector] = await embed(provider, [text], log);
  await cacheSet(key, vector!, log);
  return vector!;
}

// The cache is an optimization: with Valkey down, queries are embedded every time. After a
// failure it's skipped for a while, so requests don't each wait out a connect timeout.
let cacheDownUntil = 0;

async function cacheGet(key: string, log: Logger): Promise<number[] | null> {
  if (Date.now() < cacheDownUntil) return null;
  try {
    const raw = await send<string | null>("GET", [key]);
    return raw ? (JSON.parse(raw) as number[]) : null;
  } catch (err) {
    cacheFailed(err, log);
    return null;
  }
}

async function cacheSet(key: string, value: number[], log: Logger) {
  if (Date.now() < cacheDownUntil) return;
  try {
    await send("SET", [key, JSON.stringify(value), "EX", QUERY_TTL_S]);
  } catch (err) {
    cacheFailed(err, log);
  }
}

function cacheFailed(err: unknown, log: Logger) {
  cacheDownUntil = Date.now() + 30_000;
  log.warn("vector cache unavailable, skipping it for 30s", { err });
}

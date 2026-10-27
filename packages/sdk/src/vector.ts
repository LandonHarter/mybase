// Vector and full-text search through mybase: named indexes of documents, searched by
// meaning (pgvector), by keywords (Postgres full-text search), or both at once (hybrid).
// Documents live in your project's own database (schema `mybase_vector`), so SQL can join them.
//
//   const vector = createVectorClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   const docs = vector.index<{ lang: string }>("docs");
//   await docs.upsert([{ id: "faq-1", title: "Reset your password", text: "…", metadata: { lang: "en" } }]);
//   const { matches } = await docs.query("forgot my password", { topK: 5, filter: { lang: "en" } });
//
// Send your own vectors, or set an embedding provider for the project (any OpenAI-compatible
// `/embeddings` endpoint, e.g. OpenAI or Ollama) and mybase embeds `text` for you.
import { MybaseApiError } from "./cron";
import type { ToolInputSchema } from "./search";

export { MybaseApiError };
export type { ToolInputSchema };

/** Index names: they become table names, so lowercase letters, digits, and `_`. */
export const VECTOR_INDEX_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const VECTOR_INDEX_RULES = "Use 1–48 lowercase letters, digits, or `_`, starting with a letter.";

/** How vectors are compared. `cosine` suits most embedding models. */
export const VECTOR_METRICS = ["cosine", "l2", "ip"] as const;
export type VectorMetric = (typeof VECTOR_METRICS)[number];

/** Postgres text search configurations: stemming and stop words. `simple` does neither. */
export const VECTOR_LANGUAGES = [
  "simple", "arabic", "armenian", "basque", "catalan", "danish", "dutch", "english", "finnish", "french",
  "german", "greek", "hindi", "hungarian", "indonesian", "irish", "italian", "lithuanian", "nepali",
  "norwegian", "portuguese", "romanian", "russian", "serbian", "spanish", "swedish", "tamil", "turkish", "yiddish",
] as const;
export type VectorLanguage = (typeof VECTOR_LANGUAGES)[number];

export const VECTOR_QUERY_MODES = ["text", "vector", "hybrid"] as const;
export type VectorQueryMode = (typeof VECTOR_QUERY_MODES)[number];

export const VECTOR_LIMITS = {
  /** Documents per upsert, get, or delete. */
  batch: 100,
  /** One upsert's JSON body. */
  batchBytes: 8 * 1024 * 1024,
  idLength: 256,
  titleLength: 1000,
  textLength: 100_000,
  /** A document's metadata, as JSON. */
  metadataBytes: 16 * 1024,
  /** Vector dimensions (pgvector's HNSW index takes up to 2000). */
  dimensions: { min: 1, max: 2000 },
  topK: { min: 1, max: 100, default: 10 },
  /** Query text. */
  queryLength: 2000,
  indexesPerProject: 50,
} as const;

/** Where an index is defined: dashboard/CLI, mybase.config.ts (`mybase vector sync`), or app code. */
export type VectorIndexSource = "dashboard" | "code" | "api";

export type VectorMetadata = Record<string, unknown>;

/** An index's settings. Dimensions, metric, and language are fixed at creation. */
export interface VectorIndexSettings {
  /** Vector length; null = a text-only index (no vectors). */
  dimensions: number | null;
  metric: VectorMetric;
  language: VectorLanguage;
  /** mybase embeds `text` with the project's embedding provider when a document or query has no vector. */
  embed: boolean;
}

export interface VectorIndexInput {
  /** Omit with `embed: true` to use the provider's dimensions. */
  dimensions?: number | null;
  /** Default `cosine`. */
  metric?: VectorMetric;
  /** Default `english`. */
  language?: VectorLanguage;
  /** Default false. Needs an embedding provider in the project's vector settings. */
  embed?: boolean;
}

export interface VectorIndex extends VectorIndexSettings {
  name: string;
  source: VectorIndexSource;
  /** Approximate document count (Postgres statistics, exact for small tables). */
  documents: number;
  createdAt: string;
}

/** A document to upsert. Documents with the same id are replaced. */
export interface VectorDocument<M extends VectorMetadata = VectorMetadata> {
  id: string;
  /** Searched by keyword, weighted above `text`. */
  title?: string | null;
  /** Searched by keyword, and embedded when the index has `embed` on and no `vector` is given. */
  text?: string;
  /** Free-form JSON, matched by `filter`. */
  metadata?: M;
  vector?: number[];
}

export interface StoredDocument<M extends VectorMetadata = VectorMetadata> {
  id: string;
  title: string | null;
  text: string;
  metadata: M;
  /** Only when asked for (`includeVectors`). */
  vector?: number[] | null;
  updatedAt: string;
}

export interface UpsertDocumentsRequest {
  documents: VectorDocument[];
}

export interface UpsertDocumentsResponse {
  upserted: number;
  /** How many of them mybase embedded. */
  embedded: number;
}

export interface DeleteDocumentsRequest {
  ids?: string[];
  /** Deletes every document whose metadata contains this object. */
  filter?: VectorMetadata;
}

export interface DeleteDocumentsResponse {
  deleted: number;
}

export interface ListDocumentsResponse<M extends VectorMetadata = VectorMetadata> {
  documents: StoredDocument<M>[];
  /** Pass as `after` for the next page; null at the end. */
  next: string | null;
}

export interface VectorQueryRequest {
  /** Keywords for text search, and embedded for vector search when no `vector` is given. */
  text?: string;
  vector?: number[];
  /** Default: `hybrid` when both a vector (given or embedded) and text are available, else whichever is. */
  mode?: VectorQueryMode;
  /** 1–100, default 10. */
  topK?: number;
  /** Only documents whose metadata contains this object, e.g. `{ lang: "en" }`. */
  filter?: VectorMetadata;
  /** Hybrid only: weight of the vector ranking, 0–1 (text gets the rest). Default 0.5. */
  alpha?: number;
  /** Return each match's text. Default true. */
  includeText?: boolean;
  includeVectors?: boolean;
  /** Text and hybrid: a snippet with matched words wrapped in `<b>…</b>`. */
  highlight?: boolean;
}

export interface VectorMatch<M extends VectorMetadata = VectorMetadata> {
  id: string;
  /**
   * Higher is better. text: ts_rank_cd. vector: cosine similarity (cosine), negative distance (l2),
   * or inner product (ip). hybrid: reciprocal rank fusion.
   */
  score: number;
  title: string | null;
  text?: string;
  metadata: M;
  vector?: number[] | null;
  highlight?: string;
}

export interface VectorQueryResponse<M extends VectorMetadata = VectorMetadata> {
  mode: VectorQueryMode;
  matches: VectorMatch<M>[];
}

/** The project's embedding provider: any OpenAI-compatible `POST <url>/embeddings`. */
export interface EmbeddingSettings {
  /** e.g. `https://api.openai.com/v1` or `http://ollama.lan:11434/v1`. */
  url: string;
  model: string;
  /** Vector length the model returns. */
  dimensions: number;
  /** Whether an API key is stored (it's never returned). */
  hasKey: boolean;
}

export interface VectorServiceSettings {
  /** The API's public URL, for `createVectorClient({ apiUrl })`. */
  apiUrl: string;
  embedding: EmbeddingSettings | null;
  enabledAt: string;
}

// ---- client -----------------------------------------------------------------

export interface VectorClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `vector:write` for this project (`vector:read` is enough to query). Server-side only. */
  apiKey: string;
  /** How long to wait for mybase, in ms. Default 30000 (embedding can take a while). */
  timeoutMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export type QueryOptions = Omit<VectorQueryRequest, "text">;

export interface VectorIndexClient<M extends VectorMetadata = VectorMetadata> {
  readonly name: string;
  /** Inserts or replaces documents by id, up to 100 per call. */
  upsert(documents: VectorDocument<M> | VectorDocument<M>[]): Promise<UpsertDocumentsResponse>;
  /** Documents by id; missing ones are left out. */
  get(ids: string | string[], options?: { includeVectors?: boolean }): Promise<StoredDocument<M>[]>;
  /** By ids, or by `{ filter }`. */
  delete(target: string | string[] | { filter: Partial<M> & VectorMetadata }): Promise<DeleteDocumentsResponse>;
  /** Search by text (`query("…")`), or pass a full request (`query({ vector, filter })`). */
  query(query: string | VectorQueryRequest, options?: QueryOptions): Promise<VectorQueryResponse<M>>;
  /** Pages through documents in id order. */
  list(options?: { limit?: number; after?: string }): Promise<ListDocumentsResponse<M>>;
  info(): Promise<VectorIndex>;
}

export interface VectorClient {
  index<M extends VectorMetadata = VectorMetadata>(name: string): VectorIndexClient<M>;
  listIndexes(): Promise<VectorIndex[]>;
  getIndex(name: string): Promise<VectorIndex>;
  /** Idempotent: an existing index with the same settings is returned as is. */
  createIndex(name: string, settings?: VectorIndexInput): Promise<VectorIndex>;
  /** Only `embed` can change. */
  updateIndex(name: string, settings: { embed: boolean }): Promise<VectorIndex>;
  /** Deletes the index and all its documents. */
  deleteIndex(name: string): Promise<void>;
}

export function createVectorClient(options: VectorClientOptions): VectorClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/vector/${encodeURIComponent(options.project)}/indexes`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const path = (name: string, rest = "") => `${base}/${encodeURIComponent(name)}${rest}`;

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await doFetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data as T;
  }

  function index<M extends VectorMetadata>(name: string): VectorIndexClient<M> {
    return {
      name,
      upsert: (documents) =>
        call("POST", path(name, "/documents"), { documents: Array.isArray(documents) ? documents : [documents] } satisfies UpsertDocumentsRequest),
      async get(ids, opts = {}) {
        const params = new URLSearchParams();
        for (const id of Array.isArray(ids) ? ids : [ids]) params.append("id", id);
        if (opts.includeVectors) params.set("includeVectors", "true");
        const { documents } = await call<ListDocumentsResponse<M>>("GET", path(name, `/documents?${params}`));
        return documents;
      },
      delete(target) {
        const body: DeleteDocumentsRequest = typeof target === "string" ? { ids: [target] } : Array.isArray(target) ? { ids: target } : { filter: target.filter };
        return call("POST", path(name, "/documents/delete"), body);
      },
      query(query, opts = {}) {
        const body: VectorQueryRequest = typeof query === "string" ? { ...opts, text: query } : { ...opts, ...query };
        return call("POST", path(name, "/query"), body);
      },
      list({ limit, after } = {}) {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set("limit", String(limit));
        if (after !== undefined) params.set("after", after);
        return call("GET", path(name, `/documents?${params}`));
      },
      info: () => call("GET", path(name)),
    };
  }

  return {
    index,
    listIndexes: () => call("GET", base),
    getIndex: (name) => call("GET", path(name)),
    createIndex: (name, settings = {}) => call("POST", base, { name, ...settings }),
    updateIndex: (name, settings) => call("PATCH", path(name), settings),
    deleteIndex: (name) => call("DELETE", path(name)),
  };
}

// ---- agent tool -------------------------------------------------------------

/**
 * A tool for an LLM agent, independent of the provider. Map it to yours:
 * Anthropic `{ name, description, input_schema: inputSchema }`,
 * OpenAI `{ type: "function", function: { name, description, parameters: inputSchema } }`.
 */
export interface RetrievalTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Runs the search and returns text for the tool result. Fixable problems come back as `Error: …`. */
  run(input: unknown): Promise<string>;
}

export interface RetrievalToolOptions {
  /** Default `search_documents`. */
  name?: string;
  /** What the index holds, for the model, e.g. "the product documentation". */
  about?: string;
  /** Matches returned. Default 5. */
  topK?: number;
  /** Applied to every search (e.g. the signed-in user's tenant). */
  filter?: VectorMetadata;
  mode?: VectorQueryMode;
  /** Most characters of each match's text. Default 2000. */
  maxChars?: number;
}

/** A retrieval tool over one index, ready for an LLM tool-use loop (RAG). */
export function retrievalTool(index: VectorIndexClient, options: RetrievalToolOptions = {}): RetrievalTool {
  const maxChars = options.maxChars ?? 2000;
  return {
    name: options.name ?? "search_documents",
    description:
      `Search ${options.about ?? "the knowledge base"} and return the most relevant passages with their ids. ` +
      "Use specific words from the topic you need.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." } },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input) {
      const query = typeof input === "object" && input !== null ? (input as { query?: unknown }).query : undefined;
      if (typeof query !== "string" || !query.trim()) return "Error: query is required.";
      try {
        const { matches } = await index.query(query, { topK: options.topK ?? 5, filter: options.filter, mode: options.mode });
        if (matches.length === 0) return `Nothing found for "${query}".`;
        return matches
          .map((m, i) => {
            const text = (m.text ?? "").length > maxChars ? `${m.text!.slice(0, maxChars)}…` : (m.text ?? "");
            return `${i + 1}. [${m.id}]${m.title ? ` ${m.title}` : ""}\n${text}`;
          })
          .join("\n\n");
      } catch (error) {
        if (error instanceof MybaseApiError && ![401, 403, 404].includes(error.status)) return `Error: ${error.message}`;
        throw error;
      }
    },
  };
}

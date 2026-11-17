// Long-term memory for AI agents, mem0-style: send a conversation, mybase's AI gateway pulls
// out the facts worth keeping, compares them with what's already stored for that user (or
// agent, or run), and adds, updates, or deletes memories. Search by meaning and keywords.
//
//   const memory = createMemoryClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   await memory.add({ messages: [{ role: "user", content: "I'm vegetarian and allergic to nuts" }], userId: "u_42" });
//   const { results } = await memory.search("what can I cook for them?", { userId: "u_42" });
//
// Memories live in your project's database (schema `mybase_memory`). Every LLM and embedding
// call goes through the AI gateway (tagged `memory`), so its cost shows up there.
import { MybaseApiError } from "./cron";
import type { ToolInputSchema } from "./search";

export { MybaseApiError };

export type MemoryEvent = "ADD" | "UPDATE" | "DELETE" | "NONE";
export type MemoryMetadata = Record<string, unknown>;

export const MEMORY_LIMITS = {
  /** Characters in one memory. */
  contentLength: 4000,
  /** Messages per `add`. */
  messages: 100,
  /** Characters across an `add`'s messages. */
  inputChars: 100_000,
  topK: { min: 1, max: 100, default: 10 },
  scopeIdLength: 200,
  metadataBytes: 16 * 1024,
} as const;

/** Who a memory belongs to. At least one is needed to add; search and list filter by the ones given. */
export interface MemoryScope {
  userId?: string;
  agentId?: string;
  runId?: string;
}

export interface Memory {
  id: string;
  memory: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  metadata: MemoryMetadata;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface MemoryMatch extends Memory {
  /** Higher is better (cosine similarity, or a fused rank for hybrid). */
  score: number;
}

export interface AddMemoryRequest extends MemoryScope {
  /** A conversation (OpenAI-style roles). */
  messages?: { role: "user" | "assistant" | "system" | "tool"; content: string }[];
  /** Or plain text. */
  text?: string;
  metadata?: MemoryMetadata;
  /** Default true: extract facts and reconcile them with existing memories. false: store `text` as is. */
  infer?: boolean;
  /** Forget after this many days (default: the project's setting, or never). */
  ttlDays?: number;
}

export interface AddMemoryResponse {
  results: { id: string; memory: string; event: Exclude<MemoryEvent, "NONE">; previous?: string }[];
}

export interface SearchMemoryRequest extends MemoryScope {
  query: string;
  topK?: number;
  /** Default `hybrid` (meaning + keywords). */
  mode?: "hybrid" | "vector" | "text";
  /** Only memories whose metadata contains this. */
  filter?: MemoryMetadata;
  /** Vector mode: drop matches below this similarity (0–1). */
  threshold?: number;
}

export interface SearchMemoryResponse {
  results: MemoryMatch[];
}

export interface ListMemoriesResponse {
  memories: Memory[];
  next: string | null;
}

export interface MemoryHistoryEntry {
  id: string;
  memoryId: string;
  event: Exclude<MemoryEvent, "NONE">;
  old: string | null;
  new: string | null;
  at: string;
}

export interface MemorySettings {
  apiUrl: string;
  /** Gateway model id or alias that extracts and reconciles facts. */
  llmModel: string;
  /** Gateway embedding model. */
  embedModel: string;
  dimensions: number;
  /** Extra instructions for fact extraction (what to keep, what to skip). */
  customPrompt: string | null;
  defaultTtlDays: number | null;
  memories: number;
  enabledAt: string;
}

export interface MemoryScopeCount {
  userId: string | null;
  agentId: string | null;
  memories: number;
  lastAt: string;
}

// ---- client -----------------------------------------------------------------

export interface MemoryClientOptions {
  /** Where the mybase API is reachable from your app. */
  apiUrl: string;
  project: string;
  /** A mybase API key with `memory:write` (`memory:read` is enough to search and list). Server-side only. */
  apiKey: string;
  /** Default 120000: adding runs two LLM calls. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface MemoryClient {
  add(request: AddMemoryRequest): Promise<AddMemoryResponse>;
  search(query: string, options?: Omit<SearchMemoryRequest, "query">): Promise<SearchMemoryResponse>;
  list(scope?: MemoryScope & { limit?: number; after?: string }): Promise<ListMemoriesResponse>;
  get(id: string): Promise<Memory>;
  update(id: string, change: { memory?: string; metadata?: MemoryMetadata }): Promise<Memory>;
  delete(id: string): Promise<void>;
  /** Every memory in the scope (at least one id required). */
  deleteAll(scope: MemoryScope): Promise<{ deleted: number }>;
  history(id: string): Promise<MemoryHistoryEntry[]>;
}

export function createMemoryClient(options: MemoryClientOptions): MemoryClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/memory/${encodeURIComponent(options.project)}`;
  const timeoutMs = options.timeoutMs ?? 120_000;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
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

  const scopeParams = (scope: MemoryScope & { limit?: number; after?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(scope)) if (v !== undefined && v !== null) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return {
    add: (request) => call("POST", "/memories", request),
    search: (query, opts = {}) => call("POST", "/search", { ...opts, query }),
    list: (scope) => call("GET", `/memories${scopeParams(scope)}`),
    get: (id) => call("GET", `/memories/${encodeURIComponent(id)}`),
    update: (id, change) => call("PATCH", `/memories/${encodeURIComponent(id)}`, change),
    delete: (id) => call("DELETE", `/memories/${encodeURIComponent(id)}`),
    deleteAll: (scope) => call("POST", "/memories/delete", scope),
    history: (id) => call("GET", `/memories/${encodeURIComponent(id)}/history`),
  };
}

// ---- agent tools ------------------------------------------------------------

/** A tool for an LLM agent (same shape as `searchTools` and `retrievalTool`). */
export interface MemoryTool {
  name: "search_memory" | "add_memory";
  description: string;
  inputSchema: ToolInputSchema;
  /** Returns text for the tool result. Fixable problems come back as `Error: …`. */
  run(input: unknown): Promise<string>;
}

/** `search_memory` and `add_memory`, bound to one scope (usually the end user). */
export function memoryTools(client: MemoryClient, scope: MemoryScope, options: { topK?: number } = {}): MemoryTool[] {
  if (!scope.userId && !scope.agentId && !scope.runId) throw new Error("memoryTools needs a userId, agentId, or runId");
  const attempt = async (fn: () => Promise<string>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MybaseApiError && (err.status === 401 || err.status === 403 || err.status === 404)) throw err;
      return `Error: ${(err as Error).message}`;
    }
  };
  return [
    {
      name: "search_memory",
      description:
        "Search what you remember about this user from earlier conversations. Use before answering questions that depend on their preferences, facts about them, or past requests.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "What to look for, e.g. 'dietary restrictions'." } },
        required: ["query"],
        additionalProperties: false,
      },
      run: (input) =>
        attempt(async () => {
          const query = (input as { query?: unknown })?.query;
          if (typeof query !== "string" || !query.trim()) return "Error: query is required";
          const { results } = await client.search(query, { ...scope, topK: options.topK ?? 5 });
          return results.length ? results.map((m) => `- ${m.memory}`).join("\n") : "Nothing remembered about that.";
        }),
    },
    {
      name: "add_memory",
      description: "Remember something about this user for future conversations: a preference, a fact about them, or a decision. Write it as one short statement.",
      inputSchema: {
        type: "object",
        properties: { memory: { type: "string", description: "The fact to remember, e.g. 'Prefers metric units'." } },
        required: ["memory"],
        additionalProperties: false,
      },
      run: (input) =>
        attempt(async () => {
          const memory = (input as { memory?: unknown })?.memory;
          if (typeof memory !== "string" || !memory.trim()) return "Error: memory is required";
          const { results } = await client.add({ ...scope, text: memory });
          return results.length ? results.map((r) => `${r.event}: ${r.memory}`).join("\n") : "Already known; nothing changed.";
        }),
    },
  ];
}

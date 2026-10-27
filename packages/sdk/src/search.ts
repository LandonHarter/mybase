// Web search through mybase. The API asks its own SearXNG (a metasearch engine over Bing,
// Mojeek, Yahoo, DuckDuckGo, Brave, …) and reads pages for you, so an agent can search and then
// read without paying a search API.
//
//   const web = createSearchClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   const { results } = await web.search("bun sql postgres");
//   const page = await web.fetch(results[0].url); // → { title, markdown, … }
//
// For an LLM agent, `searchTools(web)` gives `web_search` and `web_fetch` as tool definitions.
import { MybaseApiError } from "./cron";

export { MybaseApiError };

/** `general`: the web. `news`: recent articles. `it`: GitHub and Stack Overflow. */
export const SEARCH_CATEGORIES = ["general", "news", "it"] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export const SEARCH_TIME_RANGES = ["day", "week", "month", "year"] as const;
export type SearchTimeRange = (typeof SEARCH_TIME_RANGES)[number];

export const SEARCH_LIMITS = {
  queryLength: 400,
  results: { default: 10, max: 20 },
  page: { max: 10 },
  urlLength: 2048,
  maxChars: { default: 20_000, min: 500, max: 100_000 },
} as const;

/** `en`, `de`, `en-US`, …: what language results should be in. */
export const SEARCH_LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export interface SearchOptions {
  /** Results to return, 1–20. Default 10. */
  limit?: number;
  /** Default `general`. */
  category?: SearchCategory;
  /** Only results from the last day/week/month/year. Not every engine supports it. */
  timeRange?: SearchTimeRange;
  /** `en`, `en-US`, …. Default: any language. */
  language?: string;
  /** Results page, 1–10. Default 1. */
  page?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  /** The text the engines showed under the link. May be empty. */
  snippet: string;
  /** Which engines returned it; more engines usually means more relevant. */
  engines: string[];
  /** ISO date, when the engine knows it (mostly news). */
  publishedAt: string | null;
}

/** Answer of `GET /search/<project>?q=…`. */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** True when this answer came from mybase's cache (searches are kept 1 hour). */
  cached: boolean;
}

export interface FetchOptions {
  /** Cut the markdown at this many characters, 500–100000. Default 20000. */
  maxChars?: number;
}

/** Answer of `GET /search/<project>/fetch?url=…`. */
export interface FetchResponse {
  /** Where the page ended up, after redirects. */
  url: string;
  title: string | null;
  /** The page's main content as markdown (navigation, ads, and scripts left out). */
  markdown: string;
  /** True when the markdown was cut at `maxChars`. */
  truncated: boolean;
  contentType: string;
  /** True when this answer came from mybase's cache (pages are kept 1 day). */
  cached: boolean;
}

export interface SearchClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `search:read` for this project. Server-side only. */
  apiKey: string;
  /** How long to wait for mybase, in ms. Default 20000 (searches and page reads take seconds). */
  timeoutMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface SearchClient {
  /** Searches the web. Throws `MybaseApiError` when mybase answers with an error. */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  /** Reads a public web page as markdown. Throws `MybaseApiError` when it can't (blocked address, not HTML, …). */
  fetch(url: string, options?: FetchOptions): Promise<FetchResponse>;
}

export function createSearchClient(options: SearchClientOptions): SearchClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/search/${encodeURIComponent(options.project)}`;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function get<T>(url: string): Promise<T> {
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data;
  }

  return {
    search(query, { limit, category, timeRange, language, page } = {}) {
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined) params.set("limit", String(limit));
      if (category) params.set("category", category);
      if (timeRange) params.set("timeRange", timeRange);
      if (language) params.set("language", language);
      if (page !== undefined) params.set("page", String(page));
      return get<SearchResponse>(`${base}?${params}`);
    },
    fetch(url, { maxChars } = {}) {
      const params = new URLSearchParams({ url });
      if (maxChars !== undefined) params.set("maxChars", String(maxChars));
      return get<FetchResponse>(`${base}/fetch?${params}`);
    },
  };
}

// ---- agent tools ------------------------------------------------------------

/** JSON Schema for a tool's input (the subset these tools use). */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/**
 * A tool for an LLM agent, independent of the provider. Map it to yours:
 * Anthropic `{ name, description, input_schema: inputSchema }`,
 * OpenAI `{ type: "function", function: { name, description, parameters: inputSchema } }`.
 */
export interface SearchTool {
  name: "web_search" | "web_fetch";
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Runs the tool with the model's input and returns text for the tool result. Problems the
   * model can work around (a blocked or unreadable page, no results, bad input, rate limits) come
   * back as text starting with `Error:`; a wrong key or a disabled service throws.
   */
  run(input: unknown): Promise<string>;
}

export interface SearchToolsOptions {
  /** Most characters `web_fetch` returns per page. Default 20000. Keeps tool results inside your context budget. */
  maxChars?: number;
  /** Results `web_search` returns. Default 8. */
  limit?: number;
}

/** `web_search` and `web_fetch`, ready for an LLM tool-use loop. */
export function searchTools(client: SearchClient, options: SearchToolsOptions = {}): SearchTool[] {
  const maxChars = options.maxChars ?? SEARCH_LIMITS.maxChars.default;
  const limit = options.limit ?? 8;

  return [
    {
      name: "web_search",
      description:
        "Search the web. Returns titles, URLs, and snippets. Use web_fetch to read a result in full. " +
        "Write queries like a search engine query (keywords), not a question to a person.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          category: {
            type: "string",
            enum: [...SEARCH_CATEGORIES],
            description: "general (default): the web. news: recent articles. it: GitHub and Stack Overflow.",
          },
          timeRange: { type: "string", enum: [...SEARCH_TIME_RANGES], description: "Only results from this recent period." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: (input) =>
        attempt(async () => {
          const { query, category, timeRange } = object(input);
          if (typeof query !== "string" || !query.trim()) return "Error: query is required.";
          const { results } = await client.search(query, {
            limit,
            category: oneOf(category, SEARCH_CATEGORIES),
            timeRange: oneOf(timeRange, SEARCH_TIME_RANGES),
          });
          if (results.length === 0) return `No results for "${query}".`;
          return results
            .map((r, i) => {
              const date = r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : "";
              return `${i + 1}. ${r.title}${date}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`;
            })
            .join("\n\n");
        }),
    },
    {
      name: "web_fetch",
      description:
        "Read a public web page and return its main content as markdown. Use it on URLs from web_search " +
        "or ones the user gave. Long pages are cut off.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "The http(s) URL to read." } },
        required: ["url"],
        additionalProperties: false,
      },
      run: (input) =>
        attempt(async () => {
          const { url } = object(input);
          if (typeof url !== "string" || !url.trim()) return "Error: url is required.";
          const page = await client.fetch(url, { maxChars });
          const head = `# ${page.title ?? page.url}\nURL: ${page.url}\n\n`;
          return head + page.markdown + (page.truncated ? `\n\n[Cut off at ${maxChars} characters.]` : "");
        }),
    },
  ];
}

const object = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

// Errors the model can act on go back as text; ones only the developer can fix still throw.
async function attempt(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MybaseApiError && ![401, 403, 404].includes(error.status)) return `Error: ${error.message}`;
    throw error;
  }
}

// The search service: apps (usually an LLM agent) search the web and read pages as markdown.
//
// Searches go to our own SearXNG, which asks several engines at once from this machine's IP.
// Engines that rate-limit or CAPTCHA us are suspended by SearXNG for a while, so a busy
// project can wear them out for everyone: answers are cached in Valkey (searches 1 h, pages
// 1 day) and each project is throttled. Queries and URLs are end-user data: never logged.
import { createHash } from "node:crypto";
import {
  SEARCH_CATEGORIES,
  SEARCH_LANGUAGE_PATTERN,
  SEARCH_LIMITS,
  SEARCH_TIME_RANGES,
  type FetchResponse,
  type SearchCategory,
  type SearchResponse,
  type SearchResult,
  type SearchTimeRange,
} from "@mybase-dev/sdk/search";
import type { Logger } from "@mybase/shared/logger";
import { RateLimit } from "./auth-http";
import { BadRequestError, NotFoundError, ServiceUnavailableError, TooManyRequestsError, UpstreamError } from "./errors";
import { sql } from "./postgres";
import { readPage, type Page } from "./search-fetch";
import type { ServiceModule } from "./services";
import { send, unlinkMatching } from "./valkey";

const searxngUrl = (process.env.SEARXNG_URL ?? "http://localhost:8080").replace(/\/$/, "");

const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_TTL_S = 3600;
const PAGE_TTL_S = 86_400;
/** Pages longer than this aren't cached: Valkey's memory is shared with every project's cache. */
const MAX_CACHED_CHARS = 50_000;
const SNIPPET_CHARS = 400;

const cachePrefix = (project: string) => `mybase:search:${project}:`;

// Per project, per minute. In memory, like sign-in throttling: one API instance.
const searchLimit = new RateLimit(60);
const fetchLimit = new RateLimit(120);
// In flight at once, across projects: SearXNG has 4 threads, and the Pi has 4 cores.
const searxngSlots = slots(4);
const fetchSlots = slots(8);

// ---- service ----------------------------------------------------------------

/** Projects known to have the service on, so app calls skip a Postgres query. */
const enabled = new Set<string>();

export const searchService: ServiceModule = {
  id: "search",
  async enable(project, log) {
    await sql`insert into mybase.search_projects (project) values (${project}) on conflict do nothing`;
    log.info("web search enabled");
  },
  async disable(project, log) {
    await sql`delete from mybase.search_projects where project = ${project}`;
    enabled.delete(project);
    // Cached answers expire on their own; clear them now if Valkey is up.
    const cleared = await unlinkMatching(`${cachePrefix(project)}*`).catch(() => 0);
    log.info("web search disabled", { cleared });
  },
};

export async function requireEnabled(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.search_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("web search is not enabled for this project");
  enabled.add(project);
}

// ---- search -----------------------------------------------------------------

export interface SearchParams {
  q: string;
  limit: number;
  category: SearchCategory;
  timeRange: SearchTimeRange | null;
  language: string | null;
  page: number;
}

/** Checks `GET /search/<project>?…` query parameters. */
export function parseSearchParams(params: URLSearchParams): SearchParams {
  const q = (params.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (!q) throw new BadRequestError("q is required");
  if (q.length > SEARCH_LIMITS.queryLength) throw new BadRequestError(`q must be at most ${SEARCH_LIMITS.queryLength} characters`);
  const category = params.get("category") ?? "general";
  if (!SEARCH_CATEGORIES.includes(category as SearchCategory)) {
    throw new BadRequestError(`category must be one of: ${SEARCH_CATEGORIES.join(", ")}`);
  }
  const timeRange = params.get("timeRange");
  if (timeRange !== null && !SEARCH_TIME_RANGES.includes(timeRange as SearchTimeRange)) {
    throw new BadRequestError(`timeRange must be one of: ${SEARCH_TIME_RANGES.join(", ")}`);
  }
  const language = params.get("language");
  if (language !== null && !SEARCH_LANGUAGE_PATTERN.test(language)) throw new BadRequestError("language must look like en or en-US");
  return {
    q,
    limit: int(params, "limit", SEARCH_LIMITS.results.default, 1, SEARCH_LIMITS.results.max),
    category: category as SearchCategory,
    timeRange: timeRange as SearchTimeRange | null,
    language,
    page: int(params, "page", 1, 1, SEARCH_LIMITS.page.max),
  };
}

function int(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestError(`${key} must be an integer from ${min} to ${max}`);
  return n;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engines?: string[];
  publishedDate?: string | null;
}

export async function search(project: string, p: SearchParams, log: Logger): Promise<SearchResponse> {
  // The query's case doesn't change results; the limit is applied after the cache.
  const key = `${cachePrefix(project)}q:${hash(JSON.stringify([p.q.toLowerCase(), p.category, p.timeRange, p.language, p.page]))}`;
  const hit = await cacheGet<SearchResult[]>(key, log);
  if (hit) return { query: p.q, results: hit.slice(0, p.limit), cached: true };
  if (!searchLimit.take(project)) throw new TooManyRequestsError("too many searches; at most 60 a minute per project", 60);

  const url = new URL(`${searxngUrl}/search`);
  url.search = new URLSearchParams({
    q: p.q,
    format: "json",
    categories: p.category,
    pageno: String(p.page),
    safesearch: "0",
    ...(p.timeRange && { time_range: p.timeRange }),
    ...(p.language && { language: p.language }),
  }).toString();

  const data = await searxngSlots(async () => {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    } catch (err) {
      log.warn("searxng unreachable", { err });
      throw new ServiceUnavailableError("the search engine (SearXNG) is unavailable");
    }
    if (!res.ok) {
      log.warn("searxng error", { status: res.status });
      throw new UpstreamError(`the search engine answered ${res.status}`);
    }
    return (await res.json()) as { results?: SearxngResult[]; unresponsive_engines?: [string, string][] };
  });

  const failed = data.unresponsive_engines ?? [];
  if (failed.length > 0) log.debug("search engines failed", { engines: failed.map(([name, why]) => `${name}: ${why}`) });
  const results = normalize(data.results ?? []);
  if (results.length === 0 && failed.length > 0) {
    const why = failed.map(([name, reason]) => `${name} (${reason})`).join(", ");
    throw new UpstreamError(`no results, and these search engines failed: ${why}. Try again in a few minutes.`);
  }
  // Empty answers aren't cached: a retry may do better.
  if (results.length > 0) await cacheSet(key, results, SEARCH_TTL_S, log);
  log.info("searched", { results: results.length, failedEngines: failed.length });
  return { query: p.q, results: results.slice(0, p.limit), cached: false };
}

function normalize(raw: SearxngResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (!r.url || !/^https?:\/\//.test(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    let snippet = (r.content ?? "").replace(/\s+/g, " ").trim();
    if (snippet.length > SNIPPET_CHARS) snippet = `${snippet.slice(0, SNIPPET_CHARS - 1)}…`;
    const date = r.publishedDate ? new Date(r.publishedDate) : null;
    out.push({
      title: (r.title ?? "").replace(/\s+/g, " ").trim() || r.url,
      url: r.url,
      snippet,
      engines: r.engines ?? [],
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    });
    if (out.length >= SEARCH_LIMITS.results.max) break;
  }
  return out;
}

// ---- fetch ------------------------------------------------------------------

export interface FetchParams {
  url: string;
  maxChars: number;
}

/** Checks `GET /search/<project>/fetch?…` query parameters. The URL itself is checked when it's read. */
export function parseFetchParams(params: URLSearchParams): FetchParams {
  const url = (params.get("url") ?? "").trim();
  if (!url) throw new BadRequestError("url is required");
  if (url.length > SEARCH_LIMITS.urlLength) throw new BadRequestError(`url must be at most ${SEARCH_LIMITS.urlLength} characters`);
  const { default: fallback, min, max } = SEARCH_LIMITS.maxChars;
  return { url, maxChars: int(params, "maxChars", fallback, min, max) };
}

export async function fetchPage(project: string, p: FetchParams, log: Logger): Promise<FetchResponse> {
  const key = `${cachePrefix(project)}f:${hash(p.url)}`;
  const hit = await cacheGet<Page>(key, log);
  // A cached page cut shorter than this request allows doesn't answer it.
  if (hit && (!hit.truncated || hit.markdown.length >= p.maxChars)) return { ...cut(hit, p.maxChars), cached: true };
  if (!fetchLimit.take(project)) throw new TooManyRequestsError("too many page reads; at most 120 a minute per project", 60);

  const page = await fetchSlots(() => readPage(p.url, SEARCH_LIMITS.maxChars.max));
  if (page.markdown.length <= MAX_CACHED_CHARS) await cacheSet(key, page, PAGE_TTL_S, log);
  log.info("page read", { host: new URL(page.url).host, chars: page.markdown.length, type: page.contentType });
  return { ...cut(page, p.maxChars), cached: false };
}

function cut(page: Page, maxChars: number): Page {
  if (page.markdown.length <= maxChars) return page;
  return { ...page, markdown: page.markdown.slice(0, maxChars), truncated: true };
}

// ---- helpers ----------------------------------------------------------------

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

// The cache is an optimization: with Valkey down, searches still work, just uncached. After a
// failure it's skipped for a while, so requests don't each wait out a connect timeout.
let cacheDownUntil = 0;

async function cacheGet<T>(key: string, log: Logger): Promise<T | null> {
  if (Date.now() < cacheDownUntil) return null;
  try {
    const raw = await send<string | null>("GET", [key]);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    cacheFailed(err, log);
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttl: number, log: Logger) {
  if (Date.now() < cacheDownUntil) return;
  try {
    await send("SET", [key, JSON.stringify(value), "EX", ttl]);
  } catch (err) {
    cacheFailed(err, log);
  }
}

function cacheFailed(err: unknown, log: Logger) {
  if (err instanceof ServiceUnavailableError) cacheDownUntil = Date.now() + 30_000;
  log.warn("search cache unavailable, answering uncached", { err });
}

/** Runs at most `n` tasks at once; the rest wait their turn. */
function slots(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

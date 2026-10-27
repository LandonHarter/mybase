import { describe, expect, test } from "bun:test";
import { createSearchClient, MybaseApiError, searchTools, type FetchResponse, type SearchResponse } from "./search";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const searchOk: SearchResponse = {
  query: "bun sql",
  results: [
    { title: "Bun SQL", url: "https://bun.test/docs/sql", snippet: "Postgres client", engines: ["bing", "mojeek"], publishedAt: null },
    { title: "News", url: "https://news.test/a", snippet: "", engines: ["bing news"], publishedAt: "2026-10-01T12:00:00.000Z" },
  ],
  cached: false,
};
const page: FetchResponse = { url: "https://bun.test/docs/sql", title: "SQL", markdown: "# SQL\n\nHello", truncated: true, contentType: "text/html", cached: false };

describe("createSearchClient", () => {
  test("search sends the query, options, and key", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(searchOk));
    const web = createSearchClient({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_x", fetch });
    expect(await web.search("bun sql", { limit: 5, category: "news", timeRange: "week", language: "en", page: 2 })).toEqual(searchOk);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://mb.test/search/shop");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "bun sql", limit: "5", category: "news", timeRange: "week", language: "en", page: "2" });
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer mb_x");
  });

  test("fetch sends the url and maxChars", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(page));
    const web = createSearchClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch });
    expect(await web.fetch("https://bun.test/docs/sql?a=1&b=2", { maxChars: 1000 })).toEqual(page);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/search/shop/fetch");
    expect(url.searchParams.get("url")).toBe("https://bun.test/docs/sql?a=1&b=2");
    expect(url.searchParams.get("maxChars")).toBe("1000");
  });

  test("errors become MybaseApiError with the status", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: "localhost isn't a public address" }, { status: 400 }));
    const web = createSearchClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch });
    const err = await web.fetch("http://localhost/").catch((e) => e);
    expect(err).toBeInstanceOf(MybaseApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("localhost isn't a public address");
  });
});

describe("searchTools", () => {
  const tools = (respond: (call: Call) => Response) => {
    const { fetch, calls } = fakeFetch(respond);
    const [webSearch, webFetch] = searchTools(createSearchClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch }), { maxChars: 5000 });
    return { webSearch: webSearch!, webFetch: webFetch!, calls };
  };

  test("are named web_search and web_fetch with object schemas", () => {
    const { webSearch, webFetch } = tools(() => Response.json({}));
    expect([webSearch.name, webFetch.name]).toEqual(["web_search", "web_fetch"]);
    expect(webSearch.inputSchema.required).toEqual(["query"]);
    expect(webFetch.inputSchema.required).toEqual(["url"]);
  });

  test("web_search returns numbered results and ignores unknown enum values", async () => {
    const { webSearch, calls } = tools(() => Response.json(searchOk));
    const text = await webSearch.run({ query: "bun sql", category: "images", timeRange: "week" });
    expect(text).toBe("1. Bun SQL\n   https://bun.test/docs/sql\n   Postgres client\n\n2. News (2026-10-01)\n   https://news.test/a");
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get("category")).toBeNull();
    expect(params.get("timeRange")).toBe("week");
    expect(params.get("limit")).toBe("8");
  });

  test("web_fetch returns the page with a cut-off note", async () => {
    const { webFetch, calls } = tools(() => Response.json(page));
    expect(await webFetch.run({ url: "https://bun.test/docs/sql" })).toBe("# SQL\nURL: https://bun.test/docs/sql\n\n# SQL\n\nHello\n\n[Cut off at 5000 characters.]");
    expect(new URL(calls[0]!.url).searchParams.get("maxChars")).toBe("5000");
  });

  test("bad input and recoverable errors come back as text", async () => {
    const { webSearch, webFetch } = tools(() => Response.json({ error: "example.com answered 404" }, { status: 502 }));
    expect(await webSearch.run({})).toBe("Error: query is required.");
    expect(await webFetch.run("nope")).toBe("Error: url is required.");
    expect(await webFetch.run({ url: "https://example.com/missing" })).toBe("Error: example.com answered 404");
  });

  test("a wrong key or disabled service throws", async () => {
    const { webSearch } = tools(() => Response.json({ error: "web search is not enabled for this project" }, { status: 404 }));
    await expect(webSearch.run({ query: "x" })).rejects.toBeInstanceOf(MybaseApiError);
  });
});

import { describe, expect, test } from "bun:test";
import { createVectorClient, MybaseApiError, retrievalTool, type VectorQueryResponse } from "./vector";

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

const bodyOf = (call: Call) => JSON.parse(call.init.body as string);
const client = (fetch: typeof globalThis.fetch) => createVectorClient({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_k", fetch });

const answer: VectorQueryResponse = {
  mode: "hybrid",
  matches: [{ id: "faq-1", score: 0.9, title: "Reset your password", text: "Open settings.", metadata: {} }],
};

describe("createVectorClient", () => {
  test("upserts one document or many, with the key", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ upserted: 1, embedded: 0 }));
    const docs = client(fetch).index("docs");
    await docs.upsert({ id: "a", text: "hi" });
    expect(calls[0]!.url).toBe("https://mb.test/vector/shop/indexes/docs/documents");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer mb_k");
    expect(bodyOf(calls[0]!)).toEqual({ documents: [{ id: "a", text: "hi" }] });
    await docs.upsert([{ id: "a" }, { id: "b" }]);
    expect(bodyOf(calls[1]!).documents).toHaveLength(2);
  });

  test("query takes text with options, or a full request", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(answer));
    const docs = client(fetch).index("docs");
    const res = await docs.query("forgot password", { topK: 3, filter: { lang: "en" } });
    expect(res.matches[0]!.id).toBe("faq-1");
    expect(calls[0]!.url).toBe("https://mb.test/vector/shop/indexes/docs/query");
    expect(bodyOf(calls[0]!)).toEqual({ topK: 3, filter: { lang: "en" }, text: "forgot password" });
    await docs.query({ vector: [1, 0], mode: "vector" });
    expect(bodyOf(calls[1]!)).toEqual({ vector: [1, 0], mode: "vector" });
  });

  test("get repeats id, delete takes ids or a filter", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ documents: [], next: null, deleted: 0 }));
    const docs = client(fetch).index("docs");
    await docs.get(["a", "b,c"]);
    expect(calls[0]!.url).toBe("https://mb.test/vector/shop/indexes/docs/documents?id=a&id=b%2Cc");
    await docs.delete("a");
    expect(bodyOf(calls[1]!)).toEqual({ ids: ["a"] });
    await docs.delete({ filter: { tenant: "t1" } });
    expect(calls[2]!.url).toEndWith("/documents/delete");
    expect(bodyOf(calls[2]!)).toEqual({ filter: { tenant: "t1" } });
  });

  test("index management and errors", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ error: "no index named \"x\"" }, { status: 404 }),
    );
    const vector = client(fetch);
    await expect(vector.deleteIndex("docs")).resolves.toBeUndefined();
    const err = await vector.createIndex("x", { dimensions: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(MybaseApiError);
    expect(err.status).toBe(404);
    expect(bodyOf(calls[1]!)).toEqual({ name: "x", dimensions: 3 });
  });
});

describe("retrievalTool", () => {
  test("formats matches and reports fixable errors as text", async () => {
    const { fetch } = fakeFetch(() => Response.json(answer));
    const tool = retrievalTool(client(fetch).index("docs"), { about: "the help center" });
    expect(tool.name).toBe("search_documents");
    expect(tool.description).toContain("the help center");
    expect(await tool.run({ query: "password" })).toBe("1. [faq-1] Reset your password\nOpen settings.");
    expect(await tool.run({})).toBe("Error: query is required.");

    const failing = fakeFetch(() => Response.json({ error: "embedding provider is unreachable" }, { status: 503 }));
    expect(await retrievalTool(client(failing.fetch).index("docs")).run({ query: "x" })).toBe("Error: embedding provider is unreachable");
    const unauthorized = fakeFetch(() => Response.json({ error: "invalid API key" }, { status: 401 }));
    await expect(retrievalTool(client(unauthorized.fetch).index("docs")).run({ query: "x" })).rejects.toBeInstanceOf(MybaseApiError);
  });
});

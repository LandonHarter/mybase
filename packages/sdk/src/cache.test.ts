import { describe, expect, test } from "bun:test";
import { createCache, MybaseApiError } from "./cache";

function fakeFetch(respond: (path: string, body: unknown) => unknown, status = 200) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body, auth: new Headers(init.headers).get("Authorization") });
    return Response.json(respond(new URL(url).pathname, body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const make = (fetch: typeof globalThis.fetch) => createCache({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_x", fetch });

describe("createCache", () => {
  test("prefixes keys and sends the API key", async () => {
    const { fetch, calls } = fakeFetch(() => ({ result: "OK" }));
    expect(await make(fetch).set("session:a", "u1", { ex: 60, nx: true })).toBe(true);
    expect(calls[0]).toEqual({ url: "https://mb.test/cache/shop", body: ["SET", "shop:session:a", "u1", "EX", 60, "NX"], auth: "Bearer mb_x" });
  });

  test("doesn't double a prefix that's already there", async () => {
    const { fetch, calls } = fakeFetch(() => ({ result: null }));
    await make(fetch).get("shop:a");
    expect(calls[0]!.body).toEqual(["GET", "shop:a"]);
  });

  test("set with nx answers false when the key exists", async () => {
    const { fetch } = fakeFetch(() => ({ result: null }));
    expect(await make(fetch).set("a", 1, { nx: true })).toBe(false);
  });

  test("hgetall turns a flat reply into an object", async () => {
    const { fetch } = fakeFetch(() => ({ result: ["f", "v", "g", "w"] }));
    expect(await make(fetch).hgetall("h")).toEqual({ f: "v", g: "w" });
  });

  test("json helpers round-trip", async () => {
    let stored = "";
    const { fetch } = fakeFetch((_p, body) => {
      const [cmd, , value] = body as string[];
      if (cmd === "SET") stored = value!;
      return { result: cmd === "SET" ? "OK" : stored };
    });
    const cache = make(fetch);
    await cache.setJson("user", { id: 1 });
    expect(await cache.getJson("user")).toEqual({ id: 1 });
  });

  test("a Valkey error reply throws", async () => {
    const { fetch } = fakeFetch(() => ({ error: "NOPERM No permissions to access a key" }), 400);
    await expect(make(fetch).command(["GET", "other:a"])).rejects.toBeInstanceOf(MybaseApiError);
  });

  test("pipelines go to /pipeline, transactions to /multi-exec", async () => {
    const { fetch, calls } = fakeFetch(() => [{ result: 1 }, { result: 1 }]);
    const cache = make(fetch);
    await cache.pipeline().incr("n").expire("n", 10).exec();
    await cache.pipeline().incr("n", 5).exec({ atomic: true });
    expect(calls[0]).toMatchObject({ url: "https://mb.test/cache/shop/pipeline", body: [["INCR", "shop:n"], ["EXPIRE", "shop:n", 10]] });
    expect(calls[1]).toMatchObject({ url: "https://mb.test/cache/shop/multi-exec", body: [["INCRBY", "shop:n", 5]] });
  });

  test("an empty pipeline sends nothing", async () => {
    const { fetch, calls } = fakeFetch(() => []);
    expect(await make(fetch).pipeline().exec()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { createRateLimiter, MybaseApiError, parseWindow, rateLimitHeaders } from "./ratelimit";

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

const ok = { success: true, limit: 5, remaining: 4, reset: 1_000 };

describe("parseWindow", () => {
  test("reads units and ms", () => {
    expect(parseWindow("10s")).toBe(10_000);
    expect(parseWindow("1m")).toBe(60_000);
    expect(parseWindow("2h")).toBe(7_200_000);
    expect(parseWindow(1500)).toBe(1500);
  });
  test("rejects windows outside 1s–30d", () => {
    expect(() => parseWindow("500ms")).toThrow(RangeError);
    expect(() => parseWindow("31d")).toThrow(RangeError);
    expect(() => parseWindow("soon")).toThrow(RangeError);
  });
});

describe("createRateLimiter", () => {
  test("sends a named rule with the key", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(ok));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_x", fetch });
    expect(await limiter.limit("login", "user:1")).toEqual(ok);
    expect(calls[0]!.url).toBe("https://mb.test/ratelimit/shop/limit");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer mb_x");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ id: "user:1", rule: "login" });
  });

  test("sends inline limits with the window in ms", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(ok));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch });
    await limiter.limit({ limit: 10, window: "1m", algorithm: "token", burst: 20 }, "ip", { cost: 2 });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ id: "ip", limit: 10, windowMs: 60_000, algorithm: "token", burst: 20, cost: 2 });
  });

  test("fails open by default when mybase is unreachable", async () => {
    const errors: unknown[] = [];
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch, onError: (e) => errors.push(e) });
    const result = await limiter.limit("login", "u");
    expect(result.success).toBe(true);
    expect(result.error).toBeInstanceOf(TypeError);
    expect(errors).toHaveLength(1);
  });

  test("fails closed when asked, on 5xx too", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: "the cache server (Valkey) is unavailable" }, { status: 503 }));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch, failClosed: true });
    const result = await limiter.limit("login", "u");
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(MybaseApiError);
  });

  test("throws on 4xx: a wrong key or unknown rule is a bug, not an outage", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: 'no rate limit rule "nope"' }, { status: 404 }));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    await expect(limiter.limit("nope", "u")).rejects.toThrow('no rate limit rule "nope"');
  });

  test("throws on a bad inline window before calling mybase", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(ok));
    const limiter = createRateLimiter({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    await expect(limiter.limit({ limit: 1, window: "1ms" }, "u")).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("rateLimitHeaders", () => {
  test("adds Retry-After only when blocked", () => {
    expect(rateLimitHeaders({ success: true, limit: 5, remaining: 4, reset: 10_500 }, 0)).toEqual({
      "RateLimit-Limit": "5",
      "RateLimit-Remaining": "4",
      "RateLimit-Reset": "11",
    });
    expect(rateLimitHeaders({ success: false, limit: 5, remaining: 0, reset: 3_000 }, 0)["Retry-After"]).toBe("3");
  });
});

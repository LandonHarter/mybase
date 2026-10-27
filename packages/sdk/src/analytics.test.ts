import { describe, expect, test } from "bun:test";
import { ANALYTICS_LIMITS, createAnalytics, describeError, normalizePath, type AnalyticsIngestRequest } from "./analytics";

/** A fetch that records each request body. */
function recorder(status = 202) {
  const calls: { url: string; body: AnalyticsIngestRequest; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), init });
    return new Response(JSON.stringify(status < 300 ? { accepted: 1 } : { error: "bad key" }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const base = { apiUrl: "https://mybase.test/", project: "shop", key: "mba_test" };

describe("normalizePath", () => {
  test("strips query and hash by default", () => expect(normalizePath("/search?q=x#top")).toBe("/search"));
  test("keeps the query when asked", () => expect(normalizePath("/search?q=x#top", true)).toBe("/search?q=x"));
  test("reduces full URLs to their path", () => expect(normalizePath("https://shop.test/a/b?x=1")).toBe("/a/b"));
  test("adds a leading slash", () => expect(normalizePath("pricing")).toBe("/pricing"));
  test("caps the length", () => expect(normalizePath(`/${"a".repeat(600)}`).length).toBe(ANALYTICS_LIMITS.path));
});

describe("describeError", () => {
  test("uses name and message", () => {
    const { message, stack } = describeError(new TypeError("x is undefined"));
    expect(message).toBe("TypeError: x is undefined");
    expect(stack).toContain("x is undefined");
  });
  test("stringifies other values", () => {
    expect(describeError("boom").message).toBe("boom");
    expect(describeError({ code: 1 }).message).toBe('{"code":1}');
  });
});

describe("createAnalytics (server)", () => {
  test("batches events into one request to the project's ingest URL", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch });
    analytics.track("signup", { plan: "pro" });
    analytics.pageview("/pricing?ref=x");
    await analytics.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mybase.test/analytics/shop/events");
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "text/plain" });
    const { key, events } = calls[0]!.body;
    expect(key).toBe("mba_test");
    expect(events.map((e) => [e.type, e.name, e.path])).toEqual([
      ["event", "signup", undefined],
      ["pageview", undefined, "/pricing"],
    ]);
    expect(events[0]!.props).toEqual({ plan: "pro" });
    expect(typeof events[0]!.ts).toBe("string");
  });

  test("sends as soon as the batch is full", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch, batchSize: 2 });
    analytics.track("a");
    analytics.track("b");
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
    analytics.stop();
  });

  test("flushes on the interval", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch, flushIntervalMs: 10 });
    analytics.track("a");
    await Bun.sleep(30);
    expect(calls).toHaveLength(1);
  });

  test("rejects bad event names without throwing", async () => {
    const { calls, fetch } = recorder();
    const errors: unknown[] = [];
    const analytics = createAnalytics({ ...base, fetch, onError: (err) => errors.push(err) });
    analytics.track("no/slashes");
    await analytics.flush();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test("drops props that would be rejected", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch });
    analytics.track("a", { ok: 1, long: "x".repeat(300), nan: Number.NaN, obj: {} as unknown as string });
    await analytics.flush();
    const props = calls[0]!.body.events[0]!.props!;
    expect(Object.keys(props).sort()).toEqual(["long", "ok"]);
    expect((props.long as string).length).toBe(ANALYTICS_LIMITS.propValue);
  });

  test("counts the same error once", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch });
    const err = new Error("boom");
    analytics.captureError(err);
    analytics.captureError(err);
    analytics.captureError(new Error("other"));
    await analytics.flush();
    expect(calls[0]!.body.events.map((e) => e.name)).toEqual(["Error: boom", "Error: other"]);
    expect(calls[0]!.body.events[0]!.stack).toContain("boom");
  });

  test("reports failed sends to onError instead of throwing", async () => {
    const { fetch } = recorder(401);
    const errors: unknown[] = [];
    const analytics = createAnalytics({ ...base, fetch, onError: (err) => errors.push(err) });
    analytics.track("a");
    await analytics.flush();
    expect((errors[0] as Error).message).toBe("bad key");
  });

  test("sends nothing after stop", async () => {
    const { calls, fetch } = recorder();
    const analytics = createAnalytics({ ...base, fetch });
    analytics.stop();
    analytics.track("a");
    await analytics.flush();
    expect(calls).toHaveLength(0);
  });
});

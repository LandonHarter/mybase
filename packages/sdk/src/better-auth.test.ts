import { describe, expect, test } from "bun:test";
import { authDatabaseUrl, mybaseAuth, mybaseCaptcha, mybaseSecondaryStorage, userContextQuery } from "./better-auth";
import { createCache } from "./cache";

function fakeCache(respond: (path: string, body: unknown) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const path = new URL(url).pathname;
    calls.push({ path, body });
    return Response.json(respond(path, body));
  }) as unknown as typeof globalThis.fetch;
  return { cache: createCache({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch }), calls };
}

describe("mybaseSecondaryStorage", () => {
  test("keys go under <project>:auth:, TTLs in seconds", async () => {
    const { cache, calls } = fakeCache(() => ({ result: "OK" }));
    const s = mybaseSecondaryStorage(cache);
    await s.set("tok1", '{"a":1}', 3600);
    await s.set("tok2", "x");
    await s.delete("tok1");
    expect(calls.map((c) => c.body)).toEqual([["SET", "shop:auth:tok1", '{"a":1}', "EX", 3600], ["SET", "shop:auth:tok2", "x"], ["DEL", "shop:auth:tok1"]]);
  });

  test("get and getAndDelete return the stored string", async () => {
    const { cache, calls } = fakeCache(() => ({ result: "v" }));
    const s = mybaseSecondaryStorage(cache);
    expect(await s.get("k")).toBe("v");
    expect(await s.getAndDelete("k")).toBe("v");
    expect(calls[1]!.body).toEqual(["GETDEL", "shop:auth:k"]);
  });

  test("increment sets the TTL only on creation, atomically", async () => {
    const { cache, calls } = fakeCache(() => [{ result: "OK" }, { result: 3 }]);
    expect(await mybaseSecondaryStorage(cache).increment("rl", 10)).toBe(3);
    expect(calls[0]).toEqual({
      path: "/cache/shop/multi-exec",
      body: [
        ["SET", "shop:auth:rl", 0, "EX", 10, "NX"],
        ["INCR", "shop:auth:rl"],
      ],
    });
  });
});

describe("mybaseAuth", () => {
  test("reports users and sessions through database hooks", async () => {
    const sent: unknown[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string), auth: new Headers(init.headers).get("Authorization") });
      return new Response(null, { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const plugin = mybaseAuth({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_x", fetch });
    expect(plugin.id).toBe("mybase");
    const hooks = plugin.init().options.databaseHooks;
    await hooks.user.create.after({ id: "u1" });
    await hooks.session.create.after({ userId: "u1", ipAddress: "203.0.113.9", userAgent: "UA" });
    await Bun.sleep(0);
    expect(sent).toEqual([
      { url: "https://mb.test/users/shop/events", body: { events: [{ type: "user.created", userId: "u1" }] }, auth: "Bearer mb_x" },
      { url: "https://mb.test/users/shop/events", body: { events: [{ type: "session.created", userId: "u1", ip: "203.0.113.9", userAgent: "UA" }] }, auth: "Bearer mb_x" },
    ]);
  });

  test("a failed send never throws", async () => {
    const errors: unknown[] = [];
    const fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const plugin = mybaseAuth({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch, onError: (e) => errors.push(e) });
    await plugin.init().options.databaseHooks.user.delete.after({ id: "u1" });
    await Bun.sleep(0);
    expect(errors).toHaveLength(1);
  });
});

test("mybaseCaptcha points Better Auth's Turnstile check at mybase", () => {
  expect(mybaseCaptcha({ apiUrl: "https://mb.test/", project: "shop", secretKey: "mbcap_x" })).toEqual({
    provider: "cloudflare-turnstile",
    secretKey: "mbcap_x",
    siteVerifyURLOverride: "https://mb.test/captcha/shop/siteverify",
  });
});

test("authDatabaseUrl sets search_path", () => {
  const url = new URL(authDatabaseUrl("postgres://shop:pw@db.test:5432/shop?sslmode=require", ["public"]));
  expect(url.searchParams.get("options")).toBe("-c search_path=auth,public");
  expect(url.searchParams.get("sslmode")).toBe("require");
});

test("userContextQuery binds the id", () => {
  expect(userContextQuery("u1")).toEqual({ text: "select set_config('mybase.user_id', $1, true)", values: ["u1"] });
});

import { describe, expect, test } from "bun:test";
import { createSecretsClient, MybaseApiError } from "./secrets";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const headerOf = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const options = { apiUrl: "https://mb.test/", project: "shop", env: "prod", apiKey: "mb_x" };

describe("createSecretsClient", () => {
  test("fetches the env with the key and revalidates with the ETag", async () => {
    const { fetch, calls } = fakeFetch((_call, n) =>
      n === 1
        ? Response.json({ env: "prod", version: "1.2.0", secrets: { A: "1" } }, { headers: { ETag: '"1.2.0"' } })
        : new Response(null, { status: 304 }),
    );
    const client = createSecretsClient({ ...options, fetch });
    expect(await client.all()).toEqual({ A: "1" });
    expect(await client.get("A")).toBe("1");
    expect(calls[0]!.url).toBe("https://mb.test/secrets/shop/prod");
    expect(headerOf(calls[0]!, "Authorization")).toBe("Bearer mb_x");
    expect(headerOf(calls[1]!, "If-None-Match")).toBe('"1.2.0"');
  });

  test("maxAgeMs skips the request", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ env: "prod", version: "v", secrets: { A: "1" } }));
    const client = createSecretsClient({ ...options, maxAgeMs: 60_000, fetch });
    await client.all();
    await client.all();
    expect(calls).toHaveLength(1);
  });

  test("load fills process.env without overriding", async () => {
    const { fetch } = fakeFetch(() => Response.json({ env: "prod", version: "v", secrets: { MB_TEST_A: "new", MB_TEST_B: "b" } }));
    process.env.MB_TEST_A = "old";
    try {
      const set = await createSecretsClient({ ...options, fetch }).load();
      expect(set).toEqual(["MB_TEST_B"]);
      expect(process.env.MB_TEST_A).toBe("old");
      expect(process.env.MB_TEST_B).toBe("b");
    } finally {
      delete process.env.MB_TEST_A;
      delete process.env.MB_TEST_B;
    }
  });

  test("set and unset PATCH the env", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ revision: 3, changed: 1 }));
    const client = createSecretsClient({ ...options, fetch });
    await client.set({ A: "1" }, { message: "hi" });
    await client.unset("B");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ set: { A: "1" }, message: "hi" });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ unset: ["B"] });
  });

  test("API errors throw MybaseApiError with the status", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: "this API key can't read env \"prod\"" }, { status: 403 }));
    const err = await createSecretsClient({ ...options, fetch }).all().catch((e) => e);
    expect(err).toBeInstanceOf(MybaseApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("prod");
  });
});

import { describe, expect, test } from "bun:test";
import { defineConfig } from "./config";
import {
  createCronClient,
  cronHandler,
  CronVerificationError,
  MybaseApiError,
  parseDelay,
  signApiRequest,
  signCronRequest,
  verifyApiSignature,
  verifyCronSignature,
  type CronRun,
} from "./cron";

const secret = "mbcron_test";
const run: CronRun = {
  job: "cleanup",
  runId: "00000000-0000-0000-0000-000000000000",
  attempt: 1,
  trigger: "schedule",
  scheduledAt: new Date().toISOString(),
  firedAt: new Date().toISOString(),
  payload: { days: 30 },
};
const body = JSON.stringify(run);

async function request(b = body, s = secret, t?: number) {
  return new Request("http://app.test/api/cron", {
    method: "POST",
    body: b,
    headers: { "Content-Type": "application/json", "X-Mybase-Signature": await signCronRequest(s, b, t) },
  });
}

describe("verifyCronSignature", () => {
  test("accepts a fresh signature", async () => {
    await verifyCronSignature({ body, signature: await signCronRequest(secret, body), secret });
  });

  test("rejects a tampered body", async () => {
    const signature = await signCronRequest(secret, body);
    expect(verifyCronSignature({ body: body.replace("30", "31"), signature, secret })).rejects.toThrow(CronVerificationError);
  });

  test("rejects the wrong secret", async () => {
    const signature = await signCronRequest("other", body);
    expect(verifyCronSignature({ body, signature, secret })).rejects.toThrow("does not match");
  });

  test("rejects an old timestamp", async () => {
    const signature = await signCronRequest(secret, body, Math.floor(Date.now() / 1000) - 600);
    expect(verifyCronSignature({ body, signature, secret })).rejects.toThrow("tolerance");
  });

  test("rejects missing and malformed headers", async () => {
    expect(verifyCronSignature({ body, signature: null, secret })).rejects.toThrow("missing");
    expect(verifyCronSignature({ body, signature: "v1=abc", secret })).rejects.toThrow("malformed");
  });

  test("accepts any of several secrets", async () => {
    const signature = await signCronRequest(secret, body);
    await verifyCronSignature({ body, signature, secret: ["new", secret] });
  });

  test("rejects an empty secret", async () => {
    const signature = await signCronRequest(secret, body);
    expect(verifyCronSignature({ body, signature, secret: "" })).rejects.toThrow("no cron secret");
  });
});

describe("cronHandler", () => {
  const config = defineConfig({ project: "shop", cron: { baseUrl: "http://app.test", jobs: { cleanup: { schedule: "0 3 * * *" } } } });
  let seen: CronRun | undefined;
  const handler = cronHandler<typeof config>({
    secret,
    jobs: {
      cleanup: (r) => {
        seen = r;
      },
    },
    onError: () => {},
  });

  test("runs the job and returns 200", async () => {
    const res = await handler(await request());
    expect(res.status).toBe(200);
    expect(seen?.payload).toEqual({ days: 30 });
  });

  test("401 on a bad signature", async () => {
    expect((await handler(await request(body, "wrong"))).status).toBe(401);
  });

  test("404 on an unknown job", async () => {
    expect((await handler(await request(JSON.stringify({ ...run, job: "nope" })))).status).toBe(404);
  });

  test("500 when the job throws", async () => {
    const failing = cronHandler({
      secret,
      jobs: {
        cleanup: () => {
          throw new Error("boom");
        },
      },
      onError: () => {},
    });
    expect((await failing(await request())).status).toBe(500);
  });

  test("405 on GET", async () => {
    expect((await handler(new Request("http://app.test/api/cron"))).status).toBe(405);
  });
});

describe("signApiRequest", () => {
  test("verifies for the same method, path, and body", async () => {
    const signature = await signApiRequest(secret, "post", "/cron/shop/tasks", "{}");
    await verifyApiSignature({ method: "POST", path: "/cron/shop/tasks", body: "{}", signature, secret });
  });

  test("rejects another path or method", async () => {
    const signature = await signApiRequest(secret, "GET", "/cron/shop/tasks/a", "");
    expect(verifyApiSignature({ method: "GET", path: "/cron/shop/tasks/b", body: "", signature, secret })).rejects.toThrow("does not match");
    expect(verifyApiSignature({ method: "DELETE", path: "/cron/shop/tasks/a", body: "", signature, secret })).rejects.toThrow("does not match");
  });

  test("a signed cron call can't pass as an API call", async () => {
    const signature = await signCronRequest(secret, body);
    expect(verifyApiSignature({ method: "POST", path: "/cron/shop/tasks", body, signature, secret })).rejects.toThrow("does not match");
  });
});

describe("parseDelay", () => {
  test("reads numbers and units", () => {
    expect(parseDelay(1500)).toBe(1500);
    expect(parseDelay("30s")).toBe(30_000);
    expect(parseDelay("15m")).toBe(900_000);
    expect(parseDelay("1.5h")).toBe(5_400_000);
    expect(parseDelay("7d")).toBe(604_800_000);
  });

  test("rejects junk", () => {
    expect(() => parseDelay("soon")).toThrow(RangeError);
    expect(() => parseDelay(-1)).toThrow(RangeError);
  });
});

describe("createCronClient", () => {
  let sent: Request | undefined;
  const fakeFetch = (async (input: string, init: RequestInit) => {
    sent = new Request(input, init);
    return Response.json({ id: "t1" }, { status: 201 });
  }) as unknown as typeof fetch;
  const client = createCronClient({ apiUrl: "http://mybase.test/", project: "shop", secret, baseUrl: "http://app.test/base/", fetch: fakeFetch });

  test("schedule sends a signed request for baseUrl + path", async () => {
    await client.schedule("remind", { in: "15m", payload: { id: 1 }, key: "order-1" });
    expect(sent!.url).toBe("http://mybase.test/cron/shop/tasks");
    const raw = await sent!.text();
    expect(JSON.parse(raw)).toEqual({ job: "remind", url: "http://app.test/base/api/cron", delayMs: 900_000, key: "order-1", payload: { id: 1 } });
    await verifyApiSignature({ method: "POST", path: "/cron/shop/tasks", body: raw, signature: sent!.headers.get("X-Mybase-Signature"), secret });
  });

  test("at becomes an ISO runAt", async () => {
    await client.schedule("remind", { at: "2030-01-01T00:00:00Z", path: "/hooks" });
    expect(JSON.parse(await sent!.text())).toMatchObject({ runAt: "2030-01-01T00:00:00.000Z", url: "http://app.test/base/hooks" });
  });

  test("get returns null on 404, throws MybaseApiError otherwise", async () => {
    const notFound = createCronClient({ apiUrl: "http://m.test", project: "shop", secret, fetch: (async () => Response.json({ error: "no such task" }, { status: 404 })) as unknown as typeof fetch });
    expect(await notFound.get("x")).toBeNull();
    const conflict = createCronClient({ apiUrl: "http://m.test", project: "shop", secret, fetch: (async () => Response.json({ error: "task is success" }, { status: 409 })) as unknown as typeof fetch });
    expect(conflict.cancel("x")).rejects.toBeInstanceOf(MybaseApiError);
  });

  test("needs at or in, not both, and a url", async () => {
    expect(client.schedule("remind", { at: new Date(), in: 5 })).rejects.toThrow("not both");
    const bare = createCronClient({ apiUrl: "http://m.test", project: "shop", secret, fetch: fakeFetch });
    expect(bare.schedule("remind")).rejects.toThrow("baseUrl");
  });
});

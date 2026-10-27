import { describe, expect, test } from "bun:test";
import { createQueueClient, encodeBody, MybaseApiError, type QueueMessage } from "./queue";

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

const message = (n: number, groupId: string | null = null): QueueMessage => ({
  messageId: `m${n}`,
  receipt: `r${n}`,
  body: JSON.stringify({ n }),
  attributes: {},
  groupId,
  dedupId: null,
  sequence: null,
  receiveCount: 1,
  sentAt: "2026-01-01T00:00:00.000Z",
  firstReceivedAt: "2026-01-01T00:00:00.000Z",
});

describe("encodeBody", () => {
  test("sends strings as is and the rest as JSON", () => {
    expect(encodeBody("hi")).toBe("hi");
    expect(encodeBody({ a: 1 })).toBe('{"a":1}');
    expect(encodeBody(5)).toBe("5");
  });
});

describe("createQueueClient", () => {
  test("sends a message with the key, delay in ms", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ successful: [{ id: "0", messageId: "m1", sequence: null, duplicate: false }], failed: [] }));
    const queue = createQueueClient({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_x", fetch });
    const sent = await queue.send("emails", { to: "a@b.c" }, { delay: "30s", attributes: { kind: "welcome" } });
    expect(sent.messageId).toBe("m1");
    expect(calls[0]!.url).toBe("https://mb.test/queue/shop/queues/emails/messages");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer mb_x");
    expect(bodyOf(calls[0]!)).toEqual({ messages: [{ id: "0", body: '{"to":"a@b.c"}', delayMs: 30_000, attributes: { kind: "welcome" } }] });
  });

  test("send throws when its entry failed", async () => {
    const { fetch } = fakeFetch(() => Response.json({ successful: [], failed: [{ id: "0", error: "groupId is required on FIFO queues" }] }));
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    expect(queue.send("orders", "x")).rejects.toThrow("groupId is required");
  });

  test("receives with the long poll in ms and parses bodies on demand", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ messages: [message(1)] }));
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    const [m] = await queue.receive("emails", { max: 5, wait: "20s", visibilityTimeout: "2m" });
    expect(bodyOf(calls[0]!)).toEqual({ max: 5, waitMs: 20_000, visibilityTimeoutMs: 120_000 });
    expect(m!.json<{ n: number }>().n).toBe(1);
  });

  test("API errors throw MybaseApiError with the status", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: 'no queue named "nope"' }, { status: 404 }));
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    const err = await queue.getQueue("nope").catch((e) => e);
    expect(err).toBeInstanceOf(MybaseApiError);
    expect(err.status).toBe(404);
  });

  test("delete takes one receipt or many", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ done: 1, failed: [] }));
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    await queue.delete("emails", "r1");
    await queue.delete("emails", ["r1", "r2"]);
    expect(bodyOf(calls[0]!)).toEqual({ receipts: ["r1"] });
    expect(bodyOf(calls[1]!)).toEqual({ receipts: ["r1", "r2"] });
  });
});

describe("consume", () => {
  test("deletes handled messages and leaves failed ones", async () => {
    let receives = 0;
    const deleted: string[] = [];
    const { fetch } = fakeFetch(({ url, init }) => {
      if (url.endsWith("/receive")) return Response.json({ messages: receives++ === 0 ? [message(1), message(2), message(3)] : [] });
      if (url.endsWith("/delete")) {
        deleted.push(...JSON.parse(init.body as string).receipts);
        return Response.json({ done: 2, failed: [] });
      }
      return new Response(null, { status: 404 });
    });
    const errors: unknown[] = [];
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    const consumer = queue.consume(
      "emails",
      (m) => {
        if (m.json<{ n: number }>().n === 2) throw new Error("boom");
      },
      { onError: (e) => errors.push(e) },
    );
    while (receives < 2) await Bun.sleep(1);
    await consumer.stop();
    expect(deleted.sort()).toEqual(["r1", "r3"]);
    expect(errors).toHaveLength(1);
  });

  test("runs a FIFO group in order and stops it at the first failure", async () => {
    let receives = 0;
    const seen: number[] = [];
    const deleted: string[] = [];
    const { fetch } = fakeFetch(({ url, init }) => {
      if (url.endsWith("/receive")) return Response.json({ messages: receives++ === 0 ? [message(1, "g"), message(2, "g"), message(3, "g"), message(4, "h")] : [] });
      deleted.push(...JSON.parse(init.body as string).receipts);
      return Response.json({ done: 1, failed: [] });
    });
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    const consumer = queue.consume(
      "orders",
      async (m) => {
        const { n } = m.json<{ n: number }>();
        seen.push(n);
        await Bun.sleep(n === 1 ? 5 : 0);
        if (n === 2) throw new Error("boom");
      },
      { onError: () => {} },
    );
    while (receives < 2) await Bun.sleep(1);
    await consumer.stop();
    expect(seen.filter((n) => n !== 4)).toEqual([1, 2]);
    expect(seen).toContain(4);
    expect(deleted.sort()).toEqual(["r1", "r4"]);
  });

  test("backs off and keeps going when mybase is unreachable", async () => {
    const { fetch, calls } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const errors: unknown[] = [];
    const queue = createQueueClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    const consumer = queue.consume("emails", () => {}, { onError: (e) => errors.push(e) });
    while (errors.length < 1) await Bun.sleep(1);
    await consumer.stop();
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });
});

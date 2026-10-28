import { afterEach, describe, expect, test } from "bun:test";
import { signCronRequest } from "./cron";
import {
  channelAllowed,
  connectRealtime,
  createRealtimeClient,
  createRealtimeToken,
  decodeRealtimeToken,
  verifyRealtimeToken,
  verifyRealtimeWebhook,
  type ClientFrame,
  type RealtimeConnection,
  type ServerFrame,
} from "./realtime";

const SECRET = "mbrt_test";

describe("tokens", () => {
  test("round trip", async () => {
    const token = await createRealtimeToken(SECRET, { project: "shop", userId: "u1", userInfo: { name: "Ann" }, subscribe: ["room:*"], publish: ["room:1"], ttl: 60 });
    const result = await verifyRealtimeToken(SECRET, token, "shop");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toMatchObject({ p: "shop", uid: "u1", info: { name: "Ann" }, sub: ["room:*"], pub: ["room:1"] });
    expect(decodeRealtimeToken(token)?.uid).toBe("u1");
  });

  test("wrong secret, tampering, other project, expiry", async () => {
    const token = await createRealtimeToken(SECRET, { project: "shop", subscribe: ["*"], ttl: 60 });
    expect(await verifyRealtimeToken("other", token, "shop")).toEqual({ ok: false, error: "invalid" });
    const [prefix, , sig] = token.split(".");
    const forged = btoa(JSON.stringify({ p: "shop", sub: ["*"], pub: ["*"], exp: 9999999999 })).replace(/=+$/, "");
    expect(await verifyRealtimeToken(SECRET, `${prefix}.${forged}.${sig}`, "shop")).toEqual({ ok: false, error: "invalid" });
    expect(await verifyRealtimeToken(SECRET, token, "blog")).toEqual({ ok: false, error: "project" });
    expect(await verifyRealtimeToken(SECRET, token, "shop", Date.now() + 61_000)).toEqual({ ok: false, error: "expired" });
    expect(await verifyRealtimeToken(SECRET, "nope", "shop")).toEqual({ ok: false, error: "invalid" });
  });

  test("refuses bad options", async () => {
    await expect(createRealtimeToken(SECRET, { project: "shop", ttl: 0 })).rejects.toThrow("ttl");
    await expect(createRealtimeToken(SECRET, { project: "shop", ttl: 86_401 })).rejects.toThrow("ttl");
    await expect(createRealtimeToken(SECRET, { project: "shop", subscribe: ["bad channel"] })).rejects.toThrow("pattern");
    await expect(createRealtimeToken(SECRET, { project: "shop", userInfo: "x".repeat(2000) })).rejects.toThrow("userInfo");
    await expect(createRealtimeToken("", { project: "shop" })).rejects.toThrow("secret");
  });
});

test("channelAllowed", () => {
  expect(channelAllowed(["*"], "anything")).toBe(true);
  expect(channelAllowed(["room:*"], "room:1")).toBe(true);
  expect(channelAllowed(["room:*"], "rooms")).toBe(false);
  expect(channelAllowed(["room:1"], "room:1")).toBe(true);
  expect(channelAllowed(["room:1"], "room:10")).toBe(false);
  expect(channelAllowed([], "room:1")).toBe(false);
});

describe("createRealtimeClient", () => {
  test("publishes with the API key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ids: ["m1"] });
    }) as unknown as typeof globalThis.fetch;
    const client = createRealtimeClient({ apiUrl: "https://mb.test/", project: "shop", apiKey: "mb_key", fetch });
    expect(await client.publish("room:1", "chat", { text: "hi" })).toBe("m1");
    expect(calls[0]!.url).toBe("https://mb.test/realtime/shop/publish");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer mb_key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "room:1", event: "chat", data: { text: "hi" } });
  });

  test("throws the API's error", async () => {
    const fetch = (async () => Response.json({ error: "realtime is not enabled for this project" }, { status: 404 })) as unknown as typeof globalThis.fetch;
    const client = createRealtimeClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "k", fetch });
    await expect(client.channels()).rejects.toThrow("not enabled");
  });
});

describe("verifyRealtimeWebhook", () => {
  const body = JSON.stringify({ project: "shop", events: [{ type: "channel", channel: "a", action: "occupied", at: "2026-01-01T00:00:00Z" }] });
  const req = async (secret: string) =>
    new Request("https://app.test/hook", { method: "POST", body, headers: { "X-Mybase-Signature": await signCronRequest(secret, body) } });

  test("accepts a signed call", async () => {
    expect((await verifyRealtimeWebhook(await req(SECRET), SECRET)).events).toHaveLength(1);
  });

  test("rejects a wrong signature", async () => {
    await expect(verifyRealtimeWebhook(await req("other"), SECRET)).rejects.toThrow("does not match");
  });
});

// A tiny server speaking the protocol, to check the client's reconnects, resubscribes, and acks.
describe("connectRealtime", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let conn: RealtimeConnection | null = null;
  afterEach(() => {
    conn?.close();
    server?.stop(true);
  });

  function fakeServer(onFrame: (ws: Bun.ServerWebSocket<{ n: number }>, frame: ClientFrame) => void) {
    let connections = 0;
    server = Bun.serve<{ n: number }>({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { data: { n: ++connections } }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          onFrame(ws, JSON.parse(String(message)));
        },
      },
    });
    return `http://localhost:${server.port}`;
  }

  const reply = (ws: Bun.ServerWebSocket<{ n: number }>, frame: ServerFrame) => ws.send(JSON.stringify(frame));

  test("auths, subscribes, receives, publishes, and resubscribes after a drop", async () => {
    const seen: ClientFrame[] = [];
    const apiUrl = fakeServer((ws, frame) => {
      seen.push(frame);
      if (frame.type === "auth") reply(ws, { type: "ready", connectionId: "c", uid: "u1", ref: frame.ref });
      if (frame.type === "subscribe") {
        reply(ws, { type: "subscribed", channel: frame.channel, members: [{ uid: "u1" }], ref: frame.ref });
        reply(ws, { type: "message", channel: frame.channel, event: "hello", data: ws.data.n, uid: null, id: "m", at: "" });
        // The first connection drops right after, to test reconnecting.
        if (ws.data.n === 1) setTimeout(() => ws.close(1001, "restart"), 20);
      }
      if (frame.type === "publish") reply(ws, { type: "ok", id: "p1", ref: frame.ref });
    });
    let tokens = 0;
    conn = connectRealtime({ apiUrl, project: "shop", token: () => `t${++tokens}` });
    const ch = conn.channel("presence:room");
    const got: unknown[] = [];
    ch.on("hello", (data) => got.push(data));
    await ch.ready();
    expect(ch.members()).toEqual([{ uid: "u1" }]);
    await Bun.sleep(1500);
    expect(got).toEqual([1, 2]);
    expect(tokens).toBe(2);
    await ch.publish("chat", { text: "hi" });
    expect(seen.filter((f) => f.type === "subscribe")).toHaveLength(2);
    expect(seen.find((f) => f.type === "publish")).toMatchObject({ channel: "presence:room", event: "chat", data: { text: "hi" } });
  });

  test("a refused subscribe rejects ready()", async () => {
    const apiUrl = fakeServer((ws, frame) => {
      if (frame.type === "auth") reply(ws, { type: "ready", connectionId: "c", uid: null, ref: frame.ref });
      if (frame.type === "subscribe") reply(ws, { type: "error", code: "forbidden", message: "no", ref: frame.ref, channel: frame.channel });
    });
    conn = connectRealtime({ apiUrl, project: "shop" });
    await expect(conn.channel("secret").ready()).rejects.toMatchObject({ code: "forbidden" });
  });

  test("a fixed token that's refused stops reconnecting", async () => {
    const apiUrl = fakeServer((ws) => ws.close(4001, "invalid token"));
    conn = connectRealtime({ apiUrl, project: "shop", token: "bad" });
    const errors: string[] = [];
    conn.on("error", (e) => errors.push(e.code));
    await Bun.sleep(200);
    expect(conn.state).toBe("closed");
    expect(errors).toContain("unauthorized");
  });
});

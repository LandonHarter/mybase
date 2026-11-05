import { afterAll, expect, test } from "bun:test";
import { proxyTarget, startDbProxy } from "./db-proxy";

// Stands in for the API's /db WebSocket: echoes bytes back, upper-cased, and records the auth header.
let auth: string | null = null;
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    auth = req.headers.get("authorization");
    return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    message(ws, msg) {
      const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
      ws.send(new TextEncoder().encode(text.toUpperCase()));
    },
  },
});
afterAll(() => server.stop(true));

test("wss URL from the API URL", () => {
  expect(proxyTarget("https://mybase.example.com/")).toBe("wss://mybase.example.com/db");
  expect(proxyTarget("http://192.168.1.20:4000")).toBe("ws://192.168.1.20:4000/db");
});

test("pipes TCP bytes through the WebSocket and back, with the CLI token", async () => {
  const proxy = await startDbProxy(0, { url: `ws://127.0.0.1:${server.port}/db`, token: "mb_test" });
  try {
    const got = await new Promise<string>((resolve, reject) => {
      let buf = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port: proxy.port,
        socket: {
          open(s) {
            // Sent before the WebSocket is open: must be queued, not lost.
            s.write("startup");
          },
          data(s, chunk) {
            buf += new TextDecoder().decode(chunk);
            if (buf.length >= 7) {
              s.end();
              resolve(buf);
            }
          },
          error: (_s, err) => reject(err),
        },
      });
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    expect(got).toBe("STARTUP");
    expect(auth).toBe("Bearer mb_test");
  } finally {
    proxy.stop();
  }
});

test("a busy port is a clear error", async () => {
  const first = await startDbProxy(0, { url: "ws://127.0.0.1:1/db", token: null });
  try {
    await expect(startDbProxy(first.port, { url: "ws://127.0.0.1:1/db", token: null })).rejects.toThrow(/in use/);
  } finally {
    first.stop();
  }
});

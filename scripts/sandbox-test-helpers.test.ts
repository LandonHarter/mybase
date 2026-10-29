import { expect, test } from "bun:test";
import { probeBrowser, stopTestWorker } from "./sandbox-test-helpers";

test("CDP test fails promptly if the bridge disconnects before replying", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { if (server.upgrade(req, { data: undefined })) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws) { ws.close(); } },
  });
  try {
    await expect(probeBrowser(`ws://127.0.0.1:${server.port}`, {}, 1000)).rejects.toThrow("disconnected before answering");
  } finally { server.stop(true); }
});

test("CDP test has a deadline when an open bridge never answers", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { if (server.upgrade(req, { data: undefined })) return; return new Response(null, { status: 400 }); },
    websocket: { message() {} },
  });
  try {
    await expect(probeBrowser(`ws://127.0.0.1:${server.port}`, {}, 100)).rejects.toThrow("timed out");
  } finally { server.stop(true); }
});

test("CDP test waits for the disconnect after receiving a browser version", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) { if (server.upgrade(req, { data: undefined })) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws) { ws.send(JSON.stringify({ id: 1, result: { product: "Chrome/fixture" } })); } },
  });
  try { expect(await probeBrowser(`ws://127.0.0.1:${server.port}`, {})).toBe("Chrome/fixture"); }
  finally { server.stop(true); }
});

test("test-worker cleanup escalates when SIGTERM is ignored", async () => {
  const child = Bun.spawn([process.execPath, "--eval", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], {
    stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL",
  });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  await stopTestWorker(child, 100);
  expect(child.signalCode).toBe("SIGKILL");
});

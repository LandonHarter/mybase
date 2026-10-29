import { expect, test } from "bun:test";

test("CDP bridge buffers the first command until the browser WebSocket opens", async () => {
  // Feed stdin immediately, while a controlled browser socket takes time to open.
  // Run in a subprocess so mock browser globals cannot affect other tests.
  const bridge = new URL("../../../docker/sandbox/cdp.mjs", import.meta.url).href;
  const source = `
    globalThis.fetch = async () => ({json: async () => ({webSocketDebuggerUrl: 'ws://fixture'})});
    globalThis.WebSocket = class extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 150);
      }
      send(data) {
        if (this.readyState !== 1) throw new Error('CDP command sent before browser connection opened');
        this.dispatchEvent(new MessageEvent('message', {data}));
        setTimeout(() => this.dispatchEvent(new Event('close')), 5);
      }
      close() { this.dispatchEvent(new Event('close')); }
    };
    await import(${JSON.stringify(bridge)});
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 3000, killSignal: "SIGKILL",
  });
  const command = JSON.stringify({ id: 1, method: "Browser.getVersion" });
  child.stdin.write(JSON.stringify({ data: command }) + "\n");
  await child.stdin.flush();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
    { ready: true }, { data: command },
  ]);
});

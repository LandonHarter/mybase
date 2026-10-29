import readline from "node:readline";
const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version", {
  signal: AbortSignal.timeout(5000),
})).json();
const ws = new WebSocket(webSocketDebuggerUrl);
ws.addEventListener("message", e => process.stdout.write(JSON.stringify({ data: e.data }) + "\n"));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error("browser CDP connection timed out")); }, 5000);
  ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("browser CDP connection failed")); }, { once: true });
  ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error("browser CDP connection closed before opening")); }, { once: true });
});
process.stdout.write('{"ready":true}\n');
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", () => process.exit(1));
// The external CDP client can send immediately after HTTP upgrade. Keep stdin paused until
// Chromium's own WebSocket is ready, otherwise ws.send throws and silently kills the bridge.
readline.createInterface({ input: process.stdin }).on("line", line => ws.send(JSON.parse(line).data));
process.stdin.on("end", () => process.exit(0));

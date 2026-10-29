import readline from "node:readline";
const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(webSocketDebuggerUrl);
ws.addEventListener("open", () => process.stdout.write('{"ready":true}\n'));
ws.addEventListener("message", e => process.stdout.write(JSON.stringify({ data: e.data }) + "\n"));
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", () => process.exit(1));
readline.createInterface({ input: process.stdin }).on("line", line => ws.send(JSON.parse(line).data));
process.stdin.on("end", () => process.exit(0));

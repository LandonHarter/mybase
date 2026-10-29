// Only loopback exists. This HTTP proxy transports checked TCP streams over docker exec stdio.
import net from "node:net";
import readline from "node:readline";
const sockets = new Map();
let seq = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function data(id, bytes) {
  for (let i = 0; i < bytes.length; i += 16384) send({ op: "data", id, data: bytes.subarray(i,i+16384).toString("base64") });
}
const proxy = net.createServer(socket => {
  if (sockets.size >= 32) return socket.destroy();
  const id = ++seq;
  sockets.set(id,socket);
  let headers = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { sockets.delete(id); send({ op: "close",id }); });
  function parse(chunk) {
    headers = Buffer.concat([headers,chunk]);
    if (headers.length > 65536) return socket.destroy();
    const end = headers.indexOf("\r\n\r\n");
    if (end < 0) return;
    socket.pause(); socket.removeListener("data",parse);
    try {
      const lines = headers.subarray(0,end).toString("latin1").split("\r\n");
      const [method,target,version] = lines.shift().split(" ");
      const connect = method === "CONNECT";
      const url = new URL(connect ? `https://${target}` : target);
      const port = Number(url.port || (connect ? 443 : 80));
      if (url.username || url.password || (connect ? url.protocol !== "https:" || port !== 443 : !["http:","ws:"].includes(url.protocol) || port !== 80)) throw new Error();
      socket.first = connect ? null : Buffer.from(`${method} ${url.pathname}${url.search} ${version}\r\n${lines.filter(h => !/^proxy-(authorization|connection):/i.test(h)).join("\r\n")}\r\n\r\n`,"latin1");
      socket.tail = headers.subarray(end+4);
      socket.on("data", chunk => data(id,chunk));
      send({ op: "open",id,host: url.hostname.replace(/^\[|\]$/g,""),port });
    } catch { socket.destroy(); }
  }
  socket.on("data",parse);
});
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line); const socket = sockets.get(msg.id);
  if (!socket) return;
  if (msg.op === "ready") {
    if (socket.first === null) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    else data(msg.id,socket.first);
    if (socket.tail.length) data(msg.id,socket.tail);
    socket.first = undefined; socket.tail = undefined;
    socket.resume();
  } else if (msg.op === "data") socket.write(Buffer.from(msg.data,"base64"));
  else socket.end(); // Flush already-received response bytes before forwarding remote EOF.
});
process.stdin.on("end", () => process.exit(0));
proxy.listen(3128,"127.0.0.1");

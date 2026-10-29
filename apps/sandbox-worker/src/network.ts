import { lookup } from "node:dns/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { publicSandboxIp as isPublicIp } from "@mybase/shared/public-ip";
import { limits } from "./runtime";

export async function publicDestination(host: string, port: number, denied: Set<string>, resolve = lookup): Promise<string> {
  if (typeof host !== "string" || host.length > 253 || ![80, 443].includes(port) || /[\s%/\\@]/.test(host)) throw new Error("destination denied");
  const name = host.toLowerCase().replace(/\.$/, "");
  if (denied.has(name)) throw new Error("destination denied");
  const addresses = isIP(name) ? [{ address: name }] : await resolve(name, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicIp(a.address) || denied.has(a.address))) throw new Error("destination denied");
  // Do not resolve again when connecting: closes DNS rebinding between validation and connect.
  return addresses[0]!.address;
}
export function deniedDestinations(hosts: string[]): Set<string> {
  return new Set([
    ...hosts.map(h => h.toLowerCase().replace(/\.$/, "")),
    ...Object.values(networkInterfaces()).flatMap(interfaces => interfaces?.map(i => i.address) ?? []),
  ]);
}

/** Untrusted frames retain shape/buffering bounds; concurrency is a host setting, traffic has no lifetime quota. */
export function startEgress(name: string, denied: Set<string>, exhausted: () => void,
  transport: { resolve?: typeof lookup; connect?: typeof createConnection } = {}) {
  const child = Bun.spawn(["docker", "exec", "-i", name, "node", "/opt/runtime/relay.mjs", String(limits.networkStreams)], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const sockets = new Map<number, Socket | null>();
  let closed = false;
  let pendingBytes = 0;
  const stop = () => { if (closed) return; closed = true; for (const socket of sockets.values()) socket?.destroy(); sockets.clear(); child.kill(); };
  const write = (message: unknown) => {
    if (closed) return;
    const line = JSON.stringify(message) + "\n";
    // FileSink buffers writes; flush each frame and kill on accumulated pipe backlog.
    pendingBytes += line.length;
    if (pendingBytes > 1024 * 1024) { stop(); exhausted(); return; }
    void Promise.resolve(child.stdin.write(line)).then(() => child.stdin.flush()).then(() => { pendingBytes -= line.length; }).catch(() => { stop(); exhausted(); });
  };
  void (async () => {
    try {
      let pending = "";
      for await (const chunk of child.stdout) {
        pending += Buffer.from(chunk).toString("utf8");
        if (pending.length > 128 * 1024) throw new Error("relay frame too large");
        let at: number;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          const msg = JSON.parse(line);
          if (!Number.isSafeInteger(msg.id) || msg.id < 1) throw new Error("invalid relay id");
          if (msg.op === "open") {
            if (sockets.has(msg.id) || sockets.size >= limits.networkStreams) throw new Error("simultaneous connection limit reached");
            sockets.set(msg.id, null);
            void publicDestination(msg.host, msg.port, denied, transport.resolve ?? lookup).then(address => {
              if (closed || !sockets.has(msg.id)) return;
              const socket = (transport.connect ?? createConnection)({ host: address, port: msg.port, timeout: limits.networkIdleMs });
              sockets.set(msg.id, socket);
              socket.on("connect", () => write({ op: "ready", id: msg.id }));
              socket.on("data", (data: Buffer) => {
                for (let i = 0; i < data.length; i += 16384) write({ op: "data", id: msg.id, data: data.subarray(i, i + 16384).toString("base64") });
              });
              socket.on("timeout", () => socket.destroy());
              socket.on("error", () => socket.destroy());
              socket.on("close", () => { sockets.delete(msg.id); write({ op: "close", id: msg.id }); });
            }).catch(() => { sockets.delete(msg.id); write({ op: "close", id: msg.id }); });
          } else if (msg.op === "data") {
            if (typeof msg.data !== "string" || msg.data.length > 32768) throw new Error("invalid relay data");
            const socket = sockets.get(msg.id);
            if (socket && (socket.writableLength > 256 * 1024 || !socket.write(Buffer.from(msg.data, "base64")))) socket.destroy();
          } else if (msg.op === "close") { sockets.get(msg.id)?.destroy(); sockets.delete(msg.id); }
          else throw new Error("invalid relay operation");
        }
      }
      if (!closed) exhausted();
    } catch { if (!closed) exhausted(); }
    finally { stop(); }
  })();
  return stop;
}

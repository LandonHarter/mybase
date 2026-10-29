// Trusted host agent. The control plane never receives Docker access; guests never receive this key.
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "@mybase/shared/logger";
import { SANDBOX_LIMITS, sandboxInteger, sandboxKey, sandboxPath } from "@mybase/shared/sandbox";
import type { ExecuteSandbox, SandboxExecution } from "@mybase-dev/sdk/sandbox";
import { PROJECT_NAME_PATTERN } from "@mybase/shared";
import { containerName, createArgs, docker, runExecution } from "./runtime";
import { deniedDestinations, startEgress } from "./network";

const log = createLogger("sandbox-worker");
const secret = process.env.MYBASE_SANDBOX_WORKER_KEY ?? "";
if (secret.length < 32) throw new Error("MYBASE_SANDBOX_WORKER_KEY must contain at least 32 characters");
// Must include public control-plane/S3/worker hostnames AND their public/NAT addresses.
const blocked = process.env.MYBASE_SANDBOX_DENY_HOSTS?.split(",").filter(Boolean) ?? [];
if (!blocked.length) throw new Error("MYBASE_SANDBOX_DENY_HOSTS must name control-plane infrastructure");
const denied = deniedDestinations(blocked);
for (const host of blocked) {
  // Record public aliases' addresses too: IP literals must not bypass hostname denial.
  const { lookup } = await import("node:dns/promises");
  for (const address of await lookup(host, { all: true })) denied.add(address.address);
}
const image = process.env.MYBASE_SANDBOX_IMAGE ?? "mybase-sandbox:local";
const info = JSON.parse((await docker(["info", "--format", "{{json .}}"])).toString());
if (!info.Runtimes?.runsc || info.CgroupVersion !== "2" || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit) throw new Error("sandbox worker requires runsc and functioning cgroup v2 memory/swap/CPU/pids limits");
// Kill orphan guests BEFORE listening. A worker restart never silently resumes interrupted work.
async function prune() {
  const names = (await docker(["ps", "-a", "--filter=label=mybase.sandbox=true", "--format={{.Names}}"])).toString().trim().split("\n").filter(Boolean);
  for (const name of names) await docker(["rm", "-f", name]);
}
await prune();
interface Box {
  project: string; state: string; reason: string | null; expiresAt: number; idleMs: number; touched: number;
  stopEgress: () => void; runs: Map<string, ReturnType<typeof runExecution>>; busy: string | null;
  browser?: { close(): void }; createdAt: number; finishedAt?: number; cleanup?: Promise<void>;
}
const boxes = new Map<string, Box>();
let admitting = false;
let stopping = false;
const authorize = (req: Request) => {
  const received = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
};
async function terminate(id: string, box: Box, state = "terminated", reason = "requested") {
  if (box.cleanup) return box.cleanup;
  // Install the cleanup promise before cancelling runs, whose stop callback re-enters terminate.
  const pending = Promise.resolve().then(() => cleanupBox(id,box,state,reason));
  box.cleanup = pending;
  try { await pending; }
  finally { if (box.cleanup === pending) box.cleanup = undefined; }
}
async function cleanupBox(id: string, box: Box, state: string, reason: string) {
  if (["terminated", "expired", "failed"].includes(box.state)) return;
  box.state = "stopping"; box.reason = reason;
  box.browser?.close(); box.stopEgress();
  for (const run of box.runs.values()) run.cancel();
  await docker(["rm", "-f", containerName(id)]).catch(async () => {
    // A missing container is clean. A Docker outage must leave state stopping for retry.
    const names = (await docker(["ps", "-a", "--format={{.Names}}"])).toString();
    if (names.split("\n").includes(containerName(id))) throw new Error("cleanup pending");
  });
  box.state = state; box.busy = null; box.finishedAt = Date.now();
  log.info("sandbox stopped", { sandbox: id, project: box.project, state, reason });
}
function available(box: Box) {
  if (box.state !== "ready") throw Object.assign(new Error("sandbox is not ready"), { status: 409 });
  if (box.busy) throw Object.assign(new Error("sandbox has an active execution, transfer, or browser connection"), { status: 409 });
  box.touched = Date.now();
}
function view(box: Box) { return { state: box.state, reason: box.reason, expiresAt: box.expiresAt }; }
type BrowserSocket = { child: ReturnType<typeof Bun.spawn>; box: Box; pendingBytes: number; timer?: ReturnType<typeof setTimeout> };
const server = Bun.serve<BrowserSocket>({
  hostname: process.env.MYBASE_SANDBOX_WORKER_BIND ?? "127.0.0.1",
  port: Number(process.env.MYBASE_SANDBOX_WORKER_PORT ?? 4010),
  maxRequestBodySize: SANDBOX_LIMITS.fileBytes,
  async fetch(req, server) {
    if (!authorize(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      try {
        await docker(["info","--format={{.ServerVersion}}"],undefined,1024,3000);
        return Response.json({ ok: !stopping, capacity: SANDBOX_LIMITS.workers, active: [...boxes.values()].filter(b => !["failed", "expired", "terminated"].includes(b.state)).length },{status:stopping?503:200});
      } catch { return Response.json({ok:false,error:"Docker unavailable"},{status:503}); }
    }
    const [, route, id = "", operation, runId] = url.pathname.split("/");
    try {
      if (route !== "boxes") return new Response(null, { status: 404 });
      containerName(id);
      const project = req.headers.get("x-mybase-project") ?? "";
      if (!PROJECT_NAME_PATTERN.test(project)) return new Response(null, { status: 404 });
      let box = boxes.get(id);
      if (box && box.project !== project) return new Response(null, { status: 404 });
      if (!operation && req.method === "PUT") {
        if (box) return Response.json(view(box));
        if (stopping || admitting || [...boxes.values()].filter(b => !["failed", "expired", "terminated"].includes(b.state)).length >= SANDBOX_LIMITS.workers) return Response.json({ error: "worker full" }, { status: 429 });
        admitting = true;
        try {
          const body = await req.json() as { ttlSeconds?: number; idleSeconds?: number };
          const ttl = sandboxInteger(body.ttlSeconds, 300, 10, 600);
          const idle = sandboxInteger(body.idleSeconds, 120, 10, 300);
          box = { project, state: "provisioning", reason: null, expiresAt: Date.now() + ttl * 1000, idleMs: idle * 1000, touched: Date.now(), stopEgress: () => {}, runs: new Map(), busy: null, createdAt: Date.now() };
          boxes.set(id, box);
          await docker(createArgs(id, project, image, ttl));
          if (box.state !== "provisioning") { await docker(["rm", "-f", containerName(id)]); throw new Error("provisioning cancelled"); }
          const current = box;
          box.stopEgress = startEgress(containerName(id), denied, () => { void terminate(id, current, "failed", "network_limit_or_relay_failure").catch(err => log.error("cleanup failed", { sandbox: id, err })); });
          // Actual browser readiness, not merely a running container.
          let ready = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            if (box.state !== "provisioning") break;
            try { await docker(["exec", containerName(id), "node", "-e", "fetch('http://127.0.0.1:9222/json/version').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], undefined, 1024, 1500); ready = true; break; }
            catch { await Bun.sleep(250); }
          }
          if (!ready || box.state !== "provisioning") throw new Error("browser provisioning failed");
          box.state = "ready";
          log.info("sandbox ready", { sandbox: id, project });
          return Response.json(view(box));
        } catch (error) {
          if (box) await terminate(id, box, "failed", "provisioning_failed");
          throw error;
        } finally { admitting = false; }
      }
      if (!box && !operation && req.method === "DELETE") {
        // Fence delayed create retries: a delete arriving first must never resurrect a guest.
        box = { project, state:"terminated",reason:"requested",expiresAt:Date.now(),idleMs:0,touched:Date.now(),stopEgress:()=>{},runs:new Map(),busy:null,createdAt:Date.now(),finishedAt:Date.now() };
        boxes.set(id,box);
      }
      if (!box) return Response.json({ error: "sandbox missing (worker restarted)" }, { status: 404 });
      if (!operation && req.method === "GET") return Response.json(view(box));
      if (!operation && req.method === "DELETE") { await terminate(id, box); return Response.json(view(box)); }
      if (operation === "executions" && runId) {
        containerName(runId);
        const existing = box.runs.get(runId);
        if (req.method === "GET" || req.method === "DELETE") {
          if (!existing) return new Response(null, { status: 404 });
          if (req.method === "DELETE") { existing.cancel(); await terminate(id, box, "terminated", "execution_cancelled"); }
          return Response.json(existing.result);
        }
        if (req.method === "PUT") {
          if (existing) return Response.json(existing.result);
          available(box);
          if (box.runs.size >= SANDBOX_LIMITS.executions) return Response.json({ error: "execution limit reached" }, { status: 429 });
          const input = await req.json() as ExecuteSandbox;
          sandboxKey(input.key);
          input.timeoutMs = sandboxInteger(input.timeoutMs, 30_000, 100, 120_000);
          if ((typeof input.code === "string") === Array.isArray(input.command) || (input.code !== undefined && (typeof input.code !== "string" || input.code.length > 65536)) || (input.command && (!input.command.length || input.command.length > 64 || input.command.some(s => typeof s !== "string" || s.length > 4096 || s.includes("\0"))))) throw new Error("invalid execution");
          // Recheck after reading the body: another request may have acquired the workspace.
          available(box); box.busy = runId;
          const current = box;
          const run = runExecution(runId, id, input, result => {
            current.busy = null; current.touched = Date.now();
            if (!["timed_out", "cancelled"].includes(result.state) && (result.exitCode === 137 || (result.exitCode !== 0 && /ENOMEM|ENOSPC|EAGAIN|heap out of memory|Resource temporarily unavailable/i.test(result.stderr)))) {
              void terminate(id,current,"failed","execution_resource_limit").catch(err => log.error("cleanup failed", { sandbox:id,err }));
            }
          }, state => {
            void terminate(id,current,"terminated",`execution_${state}`).catch(err => log.error("cleanup failed", { sandbox:id,err }));
          });
          box.runs.set(runId, run);
          return Response.json(run.result, { status: 202 });
        }
      }
      if (operation === "files" && ["GET", "PUT"].includes(req.method)) {
        const path = sandboxPath(url.searchParams.get("path"));
        available(box); box.busy = "transfer";
        try {
          const input = req.method === "PUT" ? new Uint8Array(await req.arrayBuffer()) : undefined;
          const bytes = await docker(["exec", ...(input ? ["-i"] : []), containerName(id), "node", "/opt/runtime/file.mjs", input ? "write" : "read", path], input, SANDBOX_LIMITS.fileBytes);
          return input ? new Response(null, { status: 204 }) : new Response(bytes as BodyInit, { headers: { "Content-Type": "application/octet-stream" } });
        } finally { box.busy = null; }
      }
      if (operation === "browser" && req.method === "GET") {
        available(box); box.busy = "browser";
        const child = Bun.spawn(["docker", "exec", "-i", containerName(id), "node", "/opt/runtime/cdp.mjs"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        if (server.upgrade(req, { data: { child, box, pendingBytes: 0 } })) return;
        child.kill(); box.busy = null;
      }
      return new Response(null, { status: 404 });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return Response.json({ error: (err as Error).message }, { status });
    }
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      const child = ws.data.child;
      ws.data.box.browser = { close: () => ws.close() };
      ws.data.timer = setTimeout(() => ws.close(1000, "browser lease expired"), 60_000);
      void (async () => {
        let pending = "";
        try {
          for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
            pending += Buffer.from(chunk).toString();
            if (pending.length > 2 * 1024 * 1024) throw new Error("CDP frame too large");
            let at: number;
            while ((at = pending.indexOf("\n")) >= 0) {
              const message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
              if (typeof message.data === "string" && ws.send(message.data) === -1) throw new Error("CDP backpressure");
            }
          }
        } catch { /* Guest killed, malformed output, or client too slow. */ }
        finally { ws.close(); }
      })();
    },
    message(ws, message) {
      const child = ws.data.child;
      const input = JSON.stringify({ data: String(message) }) + "\n";
      ws.data.pendingBytes += Buffer.byteLength(input);
      if (ws.data.pendingBytes > 2 * 1024 * 1024) { ws.close(1009); return; }
      void Promise.resolve((child.stdin as import("bun").FileSink).write(input))
        .then(() => (child.stdin as import("bun").FileSink).flush())
        .catch(() => ws.close())
        .finally(() => { ws.data.pendingBytes -= Buffer.byteLength(input); });
    },
    close(ws) { clearTimeout(ws.data.timer); ws.data.child.kill(); ws.data.box.busy = null; ws.data.box.browser = undefined; ws.data.box.touched = Date.now(); },
  },
});
let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return; sweeping = true;
  try {
    for (const [id, box] of boxes) {
      if (["failed", "expired", "terminated"].includes(box.state)) {
        if (Date.now() - (box.finishedAt ?? box.createdAt) > 600_000) boxes.delete(id);
        continue;
      }
      if (box.state === "provisioning") continue;
      if (box.state === "stopping") { await terminate(id, box, "failed", box.reason ?? "cleanup_pending"); continue; }
      if (Date.now() >= box.expiresAt || (!box.busy && Date.now() - box.touched >= box.idleMs)) await terminate(id, box, "expired", "ttl_or_idle");
      else {
        const state = JSON.parse((await docker(["inspect", "--format={{json .State}}", containerName(id)])).toString());
        if (!state.Running) await terminate(id, box, "failed", state.OOMKilled ? "memory_limit" : "guest_exited");
        else {
          // Independent watchdog: guest code cannot disable resource checks by stopping PID 1.
          try {
            const probe = "const f=require('fs');for(const p of ['/workspace','/tmp','/dev/shm']){const s=f.statfsSync(p);if(s.bavail*s.bsize<1048576)process.exit(2)};if(f.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).length>=250)process.exit(3)";
            await docker(["exec",containerName(id),"node","-e",probe],undefined,1024,2000);
          } catch { await terminate(id,box,"failed","resource_limit_or_guest_unresponsive"); }
        }
      }
    }
  } catch (err) { log.error("sandbox sweep failed", { err }); }
  finally { sweeping = false; }
}, 1000);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  stopping = true; clearInterval(timer);
  void Promise.all([...boxes].map(([id, box]) => terminate(id, box, "failed", "worker_shutdown"))).then(() => server.stop(true)).catch(err => { log.error("shutdown cleanup failed", { err }); process.exit(1); });
});
log.info("sandbox worker listening", { port: server.port, capacity: SANDBOX_LIMITS.workers });

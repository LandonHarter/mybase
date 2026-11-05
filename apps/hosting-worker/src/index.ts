// Trusted host agent for the hosting service: runs site containers on this Docker host. The API
// never gets Docker access; it tells this worker what to run (rows in Postgres are the truth),
// and Docker itself is the worker's only state, so a restart loses nothing. Site containers
// never get this key, the socket, or a route to this worker (it isn't on project networks).
import { timingSafeEqual } from "node:crypto";
import { PROJECT_NAME_PATTERN } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import { BadInput, containerName, DEPLOY_ID, docker, IMAGE_REF, must, networkName, parseLabels, PROBE_HOST, probeHealthy, probeReachable, readSpec, runArgs } from "./runtime";

const log = createLogger("hosting-worker");
const secret = process.env.MYBASE_HOSTING_WORKER_KEY ?? "";
if (secret.length < 32) throw new Error("MYBASE_HOSTING_WORKER_KEY must contain at least 32 characters");
// The Compose project mybase runs in, and which of its services sites may reach. Caddy must be
// one of them (it proxies to the sites and runs health probes).
const composeProject = process.env.MYBASE_COMPOSE_PROJECT ?? "mybase";
const attach = (process.env.MYBASE_HOSTING_ATTACH ?? "mybase,postgres,valkey,garage,caddy").split(",").map((s) => s.trim()).filter(Boolean);

const authorize = (req: Request) => {
  const received = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
};

/** The running container of a Compose service, by its labels. */
async function serviceContainer(service: string): Promise<string | null> {
  const out = await must(["ps", "-q", "--filter", `label=com.docker.compose.project=${composeProject}`, "--filter", `label=com.docker.compose.service=${service}`]);
  return out.trim().split("\n")[0] || null;
}

/** Creates the project's network and connects mybase's services to it, under their service names. */
async function ensureNetwork(project: string) {
  const net = networkName(project);
  const exists = await docker(["network", "inspect", net, "--format", "{{.Name}}"]);
  if (exists.code !== 0) {
    const created = await docker(["network", "create", "--label", "mybase.hosting=true", "--label", `mybase.project=${project}`, net]);
    if (created.code !== 0 && !/already exists/.test(created.err)) throw new Error(`docker network create failed: ${created.err.trim()}`);
  }
  for (const service of attach) {
    const id = await serviceContainer(service);
    if (!id) continue;
    const r = await docker(["network", "connect", "--alias", service, net, id]);
    if (r.code !== 0 && !/already exists|already attached|endpoint with name/i.test(r.err)) throw new Error(`connecting ${service} failed: ${r.err.trim()}`);
  }
}

async function removeNetwork(project: string) {
  const net = networkName(project);
  const inspect = await docker(["network", "inspect", net, "--format", "{{range .Containers}}{{.Name}} {{end}}"]);
  if (inspect.code !== 0) return;
  for (const name of inspect.out.trim().split(/\s+/).filter(Boolean)) await docker(["network", "disconnect", "-f", net, name]);
  await must(["network", "rm", net]);
}

interface SiteContainer { deploy: string; project: string; site: string; name: string; running: boolean }

async function listContainers(): Promise<SiteContainer[]> {
  const out = await must(["ps", "-a", "--filter", "label=mybase.hosting=true", "--format", "{{.Names}}\t{{.State}}\t{{.Labels}}"]);
  return out.trim().split("\n").filter(Boolean).flatMap((line) => {
    const [name = "", state = "", labels = ""] = line.split("\t");
    const l = parseLabels(labels);
    return l["mybase.deploy"] ? [{ deploy: l["mybase.deploy"], project: l["mybase.project"] ?? "", site: l["mybase.site"] ?? "", name, running: state === "running" }] : [];
  });
}

const find = async (deploy: string) => (await listContainers()).find((c) => c.deploy === deploy) ?? null;

async function health(c: SiteContainer, port: number, path: string) {
  const state = JSON.parse(await must(["inspect", "--format", "{{json .State}}", c.name])) as { Running: boolean; OOMKilled: boolean; ExitCode: number; Restarting: boolean };
  if (!state.Running || state.Restarting) return { running: false, healthy: false, oom: state.OOMKilled, exitCode: state.ExitCode };
  const caddy = await serviceContainer("caddy");
  if (!caddy) throw new Error("the caddy container isn't running");
  const probe = await docker(["exec", caddy, "wget", "-q", "-S", "-O", "/dev/null", "-T", "3", `http://${c.name}:${port}${path}`], { timeoutMs: 6000 });
  return { running: true, healthy: probeHealthy(probe), oom: false, exitCode: null };
}

async function remove(c: SiteContainer) {
  await docker(["stop", "-t", "10", c.name], { timeoutMs: 20_000 });
  const r = await docker(["rm", "-f", c.name]);
  if (r.code !== 0 && !/No such container/i.test(r.err)) throw new Error(`docker rm failed: ${r.err.trim()}`);
}

/**
 * Tries TCP connections from the project network (through Caddy, which sits on every project
 * network) to the hosts a site's env points at. Never sees credentials: hosts and ports only.
 */
async function probe(project: string, targets: { host: string; port: number }[]) {
  await ensureNetwork(project);
  const caddy = await serviceContainer("caddy");
  if (!caddy) throw new Error("the caddy container isn't running");
  return Promise.all(
    targets.map(async ({ host, port }) => {
      const h = host.includes(":") ? `[${host}]` : host;
      const r = await docker(["exec", caddy, "wget", "-q", "-O", "/dev/null", "-T", "4", `http://${h}:${port}/`], { timeoutMs: 8000 });
      return { host, port, ...probeReachable(r) };
    }),
  );
}

/** Streams a container's logs (stdout + stderr interleaved) until the client goes away. */
function logs(c: SiteContainer, url: URL, signal: AbortSignal): Response {
  const tail = Math.min(Math.max(Number(url.searchParams.get("tail") ?? 200) || 200, 1), 5000);
  const args = ["logs", "--timestamps", "--tail", String(tail), ...(url.searchParams.get("follow") === "1" ? ["--follow"] : []), c.name];
  const child = Bun.spawn(["sh", "-c", 'exec docker logs "$@" 2>&1', "sh", ...args.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  signal.addEventListener("abort", () => child.kill());
  return new Response(child.stdout, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const server = Bun.serve({
  hostname: process.env.MYBASE_HOSTING_WORKER_BIND ?? "127.0.0.1",
  port: Number(process.env.MYBASE_HOSTING_WORKER_PORT ?? 4020),
  maxRequestBodySize: 1 << 20,
  // Log streams stay open; pulls can take minutes.
  idleTimeout: 0,
  async fetch(req) {
    if (!authorize(req)) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const [, route = "", id = "", op] = url.pathname.split("/");
    try {
      if (route === "health" && req.method === "GET") {
        const r = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 3000 });
        return r.code === 0 ? json({ ok: true, docker: r.out.trim() }) : json({ ok: false, error: "Docker unavailable" }, 503);
      }
      if (route === "networks" && PROJECT_NAME_PATTERN.test(id) && !op) {
        if (req.method === "PUT") { await ensureNetwork(id); return json({ ok: true }); }
        if (req.method === "DELETE") { await removeNetwork(id); return json({ ok: true }); }
      }
      if (route === "containers" && !id && req.method === "GET") return json(await listContainers());
      if (route === "containers" && DEPLOY_ID.test(id)) {
        const existing = await find(id);
        if (!op && req.method === "PUT") {
          const spec = readSpec(id, await req.json());
          if (existing) return json({ name: existing.name, running: existing.running });
          await ensureNetwork(spec.project);
          await must(["pull", "--quiet", spec.image], { timeoutMs: 600_000 });
          await must(runArgs(spec), { env: spec.env, timeoutMs: 120_000 });
          log.info("site container started", { project: spec.project, site: spec.site, deploy: id });
          return json({ name: containerName(spec.site, id), running: true }, 201);
        }
        if (!existing) return json({ error: "no such container" }, 404);
        if (!op && req.method === "DELETE") { await remove(existing); log.info("site container removed", { site: existing.site, deploy: id }); return json({ ok: true }); }
        if (op === "health" && req.method === "GET") {
          const port = Number(url.searchParams.get("port"));
          const path = url.searchParams.get("path") ?? "/";
          if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/[\x21-\x7e]*$/.test(path)) throw new BadInput("invalid port or path");
          return json(await health(existing, port, path));
        }
        if (op === "logs" && req.method === "GET") return logs(existing, url, req.signal);
      }
      if (route === "probe" && req.method === "POST") {
        const { project, targets } = (await req.json()) as { project?: unknown; targets?: unknown };
        if (typeof project !== "string" || !PROJECT_NAME_PATTERN.test(project)) throw new BadInput("invalid project");
        if (!Array.isArray(targets) || targets.length > 20) throw new BadInput("invalid targets");
        for (const t of targets as { host?: unknown; port?: unknown }[]) {
          if (typeof t.host !== "string" || !PROBE_HOST.test(t.host) || !Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535) throw new BadInput("invalid target");
        }
        return json(await probe(project, targets as { host: string; port: number }[]));
      }
      if (route === "images" && req.method === "DELETE") {
        const { images } = (await req.json()) as { images?: unknown };
        if (!Array.isArray(images) || images.some((i) => typeof i !== "string" || !IMAGE_REF.test(i))) throw new BadInput("invalid images");
        for (const image of images as string[]) await docker(["image", "rm", image]);
        return json({ ok: true });
      }
      if (route === "registry" && id === "gc" && req.method === "POST") {
        const registry = await serviceContainer("registry");
        if (!registry) return json({ error: "the registry container isn't running" }, 503);
        await must(["exec", registry, "registry", "garbage-collect", "/etc/distribution/config.yml"], { timeoutMs: 600_000 });
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof BadInput) return json({ error: err.message }, 400);
      log.error("hosting operation failed", { path: url.pathname, err });
      return json({ error: (err as Error).message }, 500);
    }
  },
});

log.info("hosting worker listening", { port: server.port, composeProject });

// The hosting service: sites run as containers on this Docker host, at <site>.<domain>.
//
// Images come from the project's container registry (registry.ts; enabling hosting enables it):
// `<project>/<site>`, pushed by digest. A deploy is a row pointing at a manifest digest. Rows are the truth:
// a reconcile loop asks the hosting worker (which holds the Docker socket; the API never does)
// to start a container, waits for its health path to answer, then switches Caddy to it and
// stops the old one. A failed deploy never touches the live one. At boot and every minute, the
// containers Docker has are compared with the live deploys, and Caddy's config is re-sent if
// it changed.
//
// Each project gets its own Docker network (`mybase-p-<project>`), with mybase's services
// attached under their names (postgres, valkey, garage, mybase), so sites can't reach other
// projects' sites, the workers, or SearXNG.
import {
  HOSTING_KEEP_DEPLOYS,
  HOSTING_MANAGED_ENV,
  HOSTING_RESERVED_SITES,
  HOSTING_SITE_PATTERN,
  HOSTING_SITE_RULES,
  isReservedHostingEnv,
  type HostingDeploy,
  type HostingDeployStatus,
  type HostingOverview,
  type HostingSite,
  type ProjectContext,
} from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { audit } from "./audit";
import type { Auth } from "./auth";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, UpstreamError } from "./errors";
import type { Grant } from "./permissions";
import { projectExists, sql } from "./postgres";
import { actorOf, getEnv, resolve as resolveSecrets, secretsMaster } from "./secrets";
import { openBlob, sameId, sealBlob } from "./secrets-crypto";
import { pushCaddy, type CaddyRoute } from "./hosting-caddy";
import { envTargets, envWarning } from "./hosting-envcheck";
import { currentTopology } from "./access";
import type { ServiceModule } from "./services";
import { DIGEST, deleteManifest, lastUpload, manifestExists, platform } from "./registry";

const log = createLogger("hosting");

const workerUrl = process.env.MYBASE_HOSTING_WORKER_URL?.replace(/\/$/, "");
const workerKey = process.env.MYBASE_HOSTING_WORKER_KEY;
const domain = process.env.MYBASE_HOSTING_DOMAIN?.trim().toLowerCase().replace(/^\.|\.$/g, "") || null;
const memory = process.env.MYBASE_HOSTING_MEMORY || "512m";
const hostingPort = Number(process.env.MYBASE_HOSTING_PORT ?? 80);
// The registry from the Docker daemon (pulls happen on the host).
const pullHost = process.env.MYBASE_REGISTRY_PULL_HOST ?? "127.0.0.1:5000";
const publicHost = new URL(process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").host;

/** How long a new container gets to answer its health path. */
const HEALTH_TIMEOUT_MS = 90_000;
/** How long the old container keeps serving in-flight requests after the switch. */
const DRAIN_MS = 15_000;
const SECRETS_GRANT: Grant = { permissions: ["admin"], projects: null, environments: null };

export const containerName = (site: string, deploy: string) => `mybase-site-${site}-${deploy.slice(0, 8)}`;
const imageRef = (project: string, site: string, digest: string) => `${pullHost}/${project}/${site}@${digest}`;

/** The site's public URL; null without a domain. */
export function siteUrl(site: string): string | null {
  return domain ? `https://${site}.${domain}` : null;
}

/** Hostnames Caddy routes to a site: the public one, and `<site>.localhost` for LAN/dev. */
export function siteHosts(site: string): string[] {
  return [...(domain ? [`${site}.${domain}`] : []), `${site}.localhost`];
}

// ---- worker -----------------------------------------------------------------

function configured() {
  if (!workerUrl || !workerKey) {
    throw new ServiceUnavailableError("the hosting worker isn't configured. On the Docker host, run `mybase server hosting` once");
  }
}

async function worker(path: string, method = "GET", body?: unknown, timeoutMs = 20_000): Promise<Response> {
  configured();
  let res: Response;
  try {
    res = await fetch(workerUrl + path, {
      method,
      headers: { Authorization: `Bearer ${workerKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ServiceUnavailableError("the hosting worker is unreachable");
  }
  if (res.status === 404 && path.startsWith("/containers/")) throw new NotFoundError("no such container");
  if (!res.ok) {
    const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new UpstreamError(`hosting worker: ${error ?? `status ${res.status}`}`);
  }
  return res;
}

const workerJson = async <T>(path: string, method = "GET", body?: unknown, timeoutMs?: number) => (await (await worker(path, method, body, timeoutMs)).json()) as T;

// ---- service ----------------------------------------------------------------

export const hostingService: ServiceModule = {
  id: "hosting",
  async enable(project, log) {
    await workerJson("/health");
    await workerJson(`/networks/${project}`, "PUT");
    await sql`insert into mybase.hosting_projects (project) values (${project}) on conflict do nothing`;
    log.info("hosting enabled");
  },
  async disable(project, log) {
    for (const { name } of await sql<{ name: string }[]>`select name from mybase.hosting_sites where project = ${project}`) {
      await deleteSite(project, name, log, false);
    }
    await sql`delete from mybase.hosting_projects where project = ${project}`;
    await syncCaddy(log);
    await workerJson(`/networks/${project}`, "DELETE").catch((err) => log.warn("removing the project network failed", { err }));
    log.info("hosting disabled");
  },
};

export async function requireHosting(project: string) {
  if (!(await projectExists(project)) || !(await sql`select 1 from mybase.hosting_projects where project = ${project}`).length) {
    throw new NotFoundError("hosting is not enabled for this project");
  }
}

// ---- sites ------------------------------------------------------------------

interface SiteRow {
  name: string;
  project: string;
  port: number;
  health_path: string;
  secrets_env: string | null;
  env: Uint8Array | null;
  env_master: Uint8Array | null;
  env_keys: string[];
  live_deploy: string | null;
  strict_env_check: boolean;
  created_at: Date;
}

interface DeployRow {
  id: string;
  site: string;
  digest: string;
  status: HostingDeployStatus;
  error: string | null;
  rollback_of: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  live_at: Date | null;
  stopped_at: Date | null;
  warnings: string[] | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

const deployView = (r: DeployRow): HostingDeploy => ({
  id: r.id,
  site: r.site,
  digest: r.digest,
  status: r.status,
  error: r.error,
  rollbackOf: r.rollback_of,
  createdBy: r.created_by,
  createdAt: iso(r.created_at)!,
  liveAt: iso(r.live_at),
  stoppedAt: iso(r.stopped_at),
  warnings: r.warnings ?? [],
});

function siteView(r: SiteRow, latest: DeployRow | undefined): HostingSite {
  return {
    name: r.name,
    project: r.project,
    url: siteUrl(r.name),
    port: r.port,
    healthPath: r.health_path,
    strictEnvCheck: r.strict_env_check ?? false,
    secretsEnv: r.secrets_env,
    envKeys: r.env_keys,
    liveDeploy: r.live_deploy,
    latest: latest ? deployView(latest) : null,
    createdAt: iso(r.created_at)!,
  };
}

async function siteRow(project: string, name: string): Promise<SiteRow> {
  const [row] = await sql<SiteRow[]>`select * from mybase.hosting_sites where project = ${project} and name = ${name}`;
  if (!row) throw new NotFoundError(`no site named "${name}" in this project`);
  return row;
}

export async function overview(project: string): Promise<HostingOverview> {
  await requireHosting(project);
  const sites = await sql<SiteRow[]>`select * from mybase.hosting_sites where project = ${project} order by name`;
  const latest = await sql<DeployRow[]>`
    select distinct on (d.site) d.* from mybase.hosting_deploys d
    join mybase.hosting_sites s on s.name = d.site where s.project = ${project}
    order by d.site, d.created_at desc`;
  const bySite = new Map(latest.map((d) => [d.site, d]));
  return { domain, registry: `${publicHost}/${project}`, platform: platform(), sites: sites.map((s) => siteView(s, bySite.get(s.name))) };
}

export async function getSite(project: string, name: string): Promise<HostingSite> {
  await requireHosting(project);
  const row = await siteRow(project, name);
  const [latest] = await sql<DeployRow[]>`select * from mybase.hosting_deploys where site = ${name} order by created_at desc limit 1`;
  return siteView(row, latest);
}

function readPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new BadRequestError("port must be an integer from 1 to 65535");
  return value;
}

function readHealthPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/[\x21-\x7e]{0,200}$/.test(value)) throw new BadRequestError("healthPath must be a path starting with /");
  return value;
}

/** Labels of mybase's own public hostnames: sites can't take them. */
function reservedNames(): Set<string> {
  const names = new Set<string>(HOSTING_RESERVED_SITES);
  for (const key of ["MYBASE_PUBLIC_URL", "MYBASE_S3_PUBLIC_URL", "MYBASE_DB_PUBLIC_HOST"]) {
    const raw = process.env[key];
    if (!raw) continue;
    const host = raw.includes("://") ? URL.parse(raw)?.hostname : raw;
    if (host && domain && host.endsWith(`.${domain}`)) names.add(host.slice(0, -domain.length - 1));
  }
  return names;
}

export async function createSite(project: string, body: Record<string, unknown>, log: Logger): Promise<HostingSite> {
  await requireHosting(project);
  const { name } = body;
  if (typeof name !== "string" || !HOSTING_SITE_PATTERN.test(name)) throw new BadRequestError(`site names are ${HOSTING_SITE_RULES}`);
  if (reservedNames().has(name)) throw new BadRequestError(`"${name}" is reserved: it's one of mybase's own hostnames`);
  const port = body.port === undefined ? 3000 : readPort(body.port);
  const healthPath = body.healthPath === undefined ? "/" : readHealthPath(body.healthPath);
  const [row] = await sql<SiteRow[]>`
    insert into mybase.hosting_sites (name, project, port, health_path) values (${name}, ${project}, ${port}, ${healthPath})
    on conflict (name) do nothing returning *`;
  if (!row) throw new ConflictError(`the site name "${name}" is taken (site names are unique across projects)`);
  log.info("site created", { site: name });
  audit({ action: "hosting.site.created", project, target: name });
  return siteView(row, undefined);
}

export async function updateSite(project: string, name: string, body: Record<string, unknown>, grant: Grant, log: Logger): Promise<HostingSite> {
  await requireHosting(project);
  const row = await siteRow(project, name);
  const port = body.port === undefined ? row.port : readPort(body.port);
  const healthPath = body.healthPath === undefined ? row.health_path : readHealthPath(body.healthPath);
  let secretsEnv = row.secrets_env;
  if (body.secretsEnv !== undefined) {
    if (body.secretsEnv === null || body.secretsEnv === "") secretsEnv = null;
    else if (typeof body.secretsEnv !== "string") throw new BadRequestError("secretsEnv must be an env name or null");
    else {
      // Throws if secrets is off, the env doesn't exist, or this key can't use it.
      await getEnv(project, body.secretsEnv, grant, false);
      secretsEnv = body.secretsEnv;
    }
  }
  if (body.strictEnvCheck !== undefined && typeof body.strictEnvCheck !== "boolean") throw new BadRequestError("strictEnvCheck must be true or false");
  const strict = body.strictEnvCheck === undefined ? row.strict_env_check : body.strictEnvCheck;
  await sql`update mybase.hosting_sites set port = ${port}, health_path = ${healthPath}, secrets_env = ${secretsEnv}, strict_env_check = ${strict} where name = ${name}`;
  log.info("site updated", { site: name });
  // A new port changes the upstream of the live deploy.
  if (port !== row.port) await syncCaddy(log).catch((err) => log.warn("caddy update failed", { err }));
  return getSite(project, name);
}

export async function deleteSite(project: string, name: string, log: Logger, push = true) {
  const row = await siteRow(project, name);
  const deploys = await sql<DeployRow[]>`select * from mybase.hosting_deploys where site = ${name}`;
  for (const d of deploys) await removeContainer(d.id);
  await sql`delete from mybase.hosting_sites where name = ${name}`;
  for (const digest of new Set(deploys.map((d) => d.digest))) await deleteManifest(`${row.project}/${name}`, digest);
  await workerJson("/images", "DELETE", { images: [...new Set(deploys.map((d) => imageRef(project, name, d.digest)))] }).catch(() => {});
  if (push) await syncCaddy(log).catch((err) => log.warn("caddy update failed", { err }));
  log.info("site deleted", { site: name });
  audit({ action: "hosting.site.deleted", project, target: name });
}

// ---- env --------------------------------------------------------------------

const envAad = (project: string, site: string) => `${project}\0hosting\0${site}`;

async function readSiteEnv(row: SiteRow): Promise<Record<string, string>> {
  if (!row.env) return {};
  let bytes: Uint8Array = new Uint8Array(row.env);
  if (row.env_master) {
    const master = secretsMaster();
    if (!master || !sameId(new Uint8Array(row.env_master), master.id)) {
      throw new ServiceUnavailableError("this site's env vars were stored with a different MYBASE_SECRETS_KEY; set them again");
    }
    bytes = await openBlob(master, bytes, envAad(row.project, row.name));
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
}

export async function getSiteEnv(project: string, name: string): Promise<{ env: Record<string, string> }> {
  await requireHosting(project);
  return { env: await readSiteEnv(await siteRow(project, name)) };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export async function putSiteEnv(project: string, name: string, body: Record<string, unknown>, log: Logger): Promise<{ env: Record<string, string> }> {
  await requireHosting(project);
  await siteRow(project, name);
  const env = body.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw new BadRequestError("env must map names to strings");
  const entries = Object.entries(env);
  if (entries.length > 200) throw new BadRequestError("at most 200 env vars per site");
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k)) throw new BadRequestError(`"${k}" isn't a valid env var name`);
    if ((HOSTING_MANAGED_ENV as readonly string[]).includes(k)) throw new BadRequestError(`${k} is set by mybase`);
    if (isReservedHostingEnv(k)) throw new BadRequestError(`${k} can't be set on a site: the hosting worker's docker client would read it`);
    if (typeof v !== "string" || v.includes("\0") || v.length > 32_768) throw new BadRequestError(`${k} must be a string up to 32 KB`);
  }
  const plain = new TextEncoder().encode(JSON.stringify(env));
  const master = secretsMaster();
  const stored = master ? await sealBlob(master, plain, envAad(project, name)) : plain;
  const keys = entries.map(([k]) => k).sort();
  await sql`
    update mybase.hosting_sites set env = ${Buffer.from(stored)}, env_master = ${master ? Buffer.from(master.id) : null},
      env_keys = ${sql.array(keys, "text")}
    where name = ${name}`;
  log.info("site env updated", { site: name, count: keys.length });
  return { env: env as Record<string, string> };
}

/** Everything the container gets: secrets env, then the site's own vars, then mybase's. */
async function containerEnv(row: SiteRow, deploy: string): Promise<Record<string, string>> {
  // Linked keys resolve to the project network's names (postgres:5432, …), TLS off.
  const fromSecrets = row.secrets_env ? (await resolveSecrets(row.project, row.secrets_env, SECRETS_GRANT, null, { kind: "hosting" })).body?.secrets ?? {} : {};
  return {
    ...fromSecrets,
    ...(await readSiteEnv(row)),
    PORT: String(row.port),
    HOSTNAME: "0.0.0.0",
    MYBASE_SITE: row.name,
    MYBASE_SITE_URL: siteUrl(row.name) ?? `http://${row.name}.localhost${hostingPort === 80 ? "" : `:${hostingPort}`}`,
    MYBASE_DEPLOY_ID: deploy,
  };
}

// ---- deploys ----------------------------------------------------------------

export async function listDeploys(project: string, name: string): Promise<HostingDeploy[]> {
  await requireHosting(project);
  await siteRow(project, name);
  return (await sql<DeployRow[]>`select * from mybase.hosting_deploys where site = ${name} order by created_at desc limit 50`).map(deployView);
}

async function queueDeploy(row: SiteRow, digest: string, auth: Auth, rollbackOf: string | null, log: Logger): Promise<HostingDeploy> {
  const id = crypto.randomUUID();
  const superseded = await sql.begin(async (tx) => {
    // Only the newest deploy of a site may go live: older unfinished ones give way.
    const older = await tx<{ id: string }[]>`
      update mybase.hosting_deploys set status = 'failed', error = ${`superseded by ${id}`}, stopped_at = now()
      where site = ${row.name} and status in ('queued', 'starting') returning id`;
    await tx`
      insert into mybase.hosting_deploys (id, site, digest, status, rollback_of, created_by)
      values (${id}, ${row.name}, ${digest}, 'queued', ${rollbackOf}, ${actorOf(auth)})`;
    return older;
  });
  for (const { id: old } of superseded) await removeContainer(old);
  log.info("deploy queued", { site: row.name, deploy: id, rollback: rollbackOf !== null });
  audit({ action: rollbackOf ? "hosting.rolled_back" : "hosting.deployed", project: row.project, target: row.name, meta: { deploy: id } });
  kick();
  const [created] = await sql<DeployRow[]>`select * from mybase.hosting_deploys where id = ${id}`;
  return deployView(created!);
}

/** Deploys a pushed image, or (no digest) the live one again, e.g. to pick up new env vars. */
export async function createDeploy(project: string, name: string, body: Record<string, unknown>, auth: Auth, log: Logger): Promise<HostingDeploy> {
  await requireHosting(project);
  const row = await siteRow(project, name);
  let digest = body.digest;
  if (digest === undefined) {
    const [live] = await sql<DeployRow[]>`select * from mybase.hosting_deploys where id = ${row.live_deploy}`;
    if (!live) throw new BadRequestError("this site has nothing live to redeploy; push an image and pass its digest");
    digest = live.digest;
  }
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new BadRequestError("digest must be a sha256:… manifest digest");
  if (!(await manifestExists(`${project}/${name}`, digest))) throw new NotFoundError(`no image ${digest} in ${project}/${name}; push it first`);
  return queueDeploy(row, digest, auth, null, log);
}

export async function rollback(project: string, name: string, body: Record<string, unknown>, auth: Auth, log: Logger): Promise<HostingDeploy> {
  await requireHosting(project);
  const row = await siteRow(project, name);
  let target: DeployRow | undefined;
  if (body.deployId !== undefined) {
    if (typeof body.deployId !== "string" || !/^[0-9a-f-]{36}$/.test(body.deployId)) throw new BadRequestError("deployId must be a deploy id");
    [target] = await sql<DeployRow[]>`select * from mybase.hosting_deploys where id = ${body.deployId} and site = ${name}`;
    if (!target) throw new NotFoundError("no such deploy for this site");
  } else {
    // The deploy that was live before the current one.
    [target] = await sql<DeployRow[]>`
      select * from mybase.hosting_deploys
      where site = ${name} and live_at is not null and id is distinct from ${row.live_deploy} and digest <> coalesce((select digest from mybase.hosting_deploys where id = ${row.live_deploy}), '')
      order by live_at desc limit 1`;
    if (!target) throw new NotFoundError("there's no earlier deploy to roll back to");
  }
  if (!(await manifestExists(`${project}/${name}`, target.digest))) throw new NotFoundError("that deploy's image is gone (only the last few are kept)");
  return queueDeploy(row, target.digest, auth, target.id, log);
}

/** Streams the logs of a deploy's container (the live one by default). */
export async function siteLogs(project: string, name: string, url: URL, signal: AbortSignal): Promise<Response> {
  await requireHosting(project);
  const row = await siteRow(project, name);
  const deploy = url.searchParams.get("deploy") ?? row.live_deploy;
  if (!deploy || !(await sql`select 1 from mybase.hosting_deploys where id = ${deploy} and site = ${name}`).length) {
    throw new NotFoundError("no deploy to show logs for");
  }
  const tail = url.searchParams.get("tail") ?? "200";
  const follow = url.searchParams.get("follow") === "1" ? "1" : "0";
  configured();
  let res: Response;
  try {
    res = await fetch(`${workerUrl}/containers/${deploy}/logs?tail=${encodeURIComponent(tail)}&follow=${follow}`, {
      headers: { Authorization: `Bearer ${workerKey}` },
      signal,
    });
  } catch {
    throw new ServiceUnavailableError("the hosting worker is unreachable");
  }
  if (res.status === 404) throw new NotFoundError("that deploy's container is gone");
  if (!res.ok) throw new UpstreamError("reading logs failed");
  // The deploy's env warnings first, so a P1001 in the output comes with its cause and fix.
  const [w] = await sql<{ warnings: string[] | null }[]>`select warnings from mybase.hosting_deploys where id = ${deploy}`;
  if (w?.warnings?.length && res.body) {
    const head = new TextEncoder().encode(w.warnings.map((x) => x.split("\n").map((l) => `[mybase] ${l}`).join("\n")).join("\n") + "\n");
    const body = res.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(head);
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
      cancel() {
        void body.cancel();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
  }
  return new Response(res.body, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
}

// ---- reconcile --------------------------------------------------------------

async function removeContainer(deploy: string) {
  await worker(`/containers/${deploy}`, "DELETE", undefined, 30_000).catch((err) => {
    if (!(err instanceof NotFoundError)) log.warn("removing a container failed", { deploy, err });
  });
}

/**
 * TCP check from the project's network to `targets` (the worker repairs the network first).
 * Null when the check couldn't run.
 */
export async function probeFromSites(project: string, targets: { host: string; port: number }[]) {
  try {
    return await workerJson<{ host: string; port: number; reachable: boolean; reason: string | null }[]>("/probe", "POST", { project, targets }, 30_000);
  } catch (err) {
    log.warn("probe from the hosting network failed", { project, err: (err as Error).message });
    return null;
  }
}

/** The last lines a container printed, kept in the failed deploy's error (the container goes). */
async function lastLines(deploy: string): Promise<string> {
  try {
    const res = await worker(`/containers/${deploy}/logs?tail=30&follow=0`, "GET", undefined, 5000);
    const text = (await res.text()).trim();
    return text ? `\n--- last output ---\n${text.slice(-3000)}` : "";
  } catch {
    return "";
  }
}

async function fail(deploy: string, error: string) {
  error += await lastLines(deploy);
  await sql`update mybase.hosting_deploys set status = 'failed', error = ${error}, stopped_at = now() where id = ${deploy} and status in ('queued', 'starting')`;
  await removeContainer(deploy);
  log.warn("deploy failed", { deploy, error });
}

/**
 * Tries every env URL from the project network (hosting-envcheck.ts). Returns the warnings, empty
 * when everything answers or the check couldn't run (it never blocks on its own failure).
 */
async function checkEnv(row: SiteRow, env: Record<string, string>): Promise<string[]> {
  const targets = envTargets(env);
  if (targets.length === 0) return [];
  const probed = targets.filter((t) => !t.loopback);
  let results: { host: string; port: number; reachable: boolean; reason: string | null }[] = [];
  if (probed.length) {
    try {
      results = await workerJson("/probe", "POST", { project: row.project, targets: probed.map(({ host, port }) => ({ host, port })) }, 30_000);
    } catch (err) {
      log.warn("env check skipped", { site: row.name, err: (err as Error).message });
      return [];
    }
  }
  const topo = currentTopology();
  const internal = Object.fromEntries(
    (["database", "cache", "storage", "api"] as const).map((s) => {
      const r = topo[s].find((x) => x.route === "internal")!;
      return [s, `${r.host}:${r.port}`];
    }),
  );
  const opts = { project: row.project, site: row.name, secretsEnv: row.secrets_env, internal };
  return targets
    .filter((t) => t.loopback || results.some((r) => r.host === t.host && r.port === t.port && !r.reachable))
    .map((t) => {
      const reason = results.find((r) => r.host === t.host && r.port === t.port)?.reason;
      return envWarning(t, opts).replace(" unreachable from site network.", ` unreachable from site network${reason ? ` (${reason})` : ""}.`);
    });
}

/** Deploys whose container is being pulled and started right now (not health-checked yet). */
const launching = new Set<string>();

async function start(d: DeployRow) {
  const [row] = await sql<SiteRow[]>`select * from mybase.hosting_sites where name = ${d.site}`;
  if (!row) return;
  // Claim it first, so a slow pull isn't started twice.
  const claimed = await sql`update mybase.hosting_deploys set status = 'starting', started_at = now() where id = ${d.id} and status = 'queued' returning id`;
  if (!claimed.length) return;
  launching.add(d.id);
  try {
    const env = await containerEnv(row, d.id);
    const warnings = await checkEnv(row, env);
    if (warnings.length) {
      await sql`update mybase.hosting_deploys set warnings = ${sql.array(warnings, "text")} where id = ${d.id}`;
      log.warn("deploy env check: unreachable addresses", { site: row.name, deploy: d.id, count: warnings.length, strict: row.strict_env_check });
      if (row.strict_env_check) {
        await fail(d.id, `env check failed (strictEnvCheck is on):\n\n${warnings.join("\n\n")}`);
        return;
      }
    }
    await worker(`/containers/${d.id}`, "PUT", { project: row.project, site: row.name, image: imageRef(row.project, row.name, d.digest), env, memory }, 15 * 60_000);
    // The health timeout counts from here, not from before the pull.
    await sql`update mybase.hosting_deploys set started_at = now() where id = ${d.id}`;
  } catch (err) {
    await fail(d.id, `starting the container failed: ${(err as Error).message}`);
  } finally {
    launching.delete(d.id);
  }
}

async function check(d: DeployRow) {
  const [row] = await sql<SiteRow[]>`select * from mybase.hosting_sites where name = ${d.site}`;
  if (!row) return;
  let state: { running: boolean; healthy: boolean; oom: boolean; exitCode: number | null };
  try {
    state = await workerJson(`/containers/${d.id}/health?port=${row.port}&path=${encodeURIComponent(row.health_path)}`);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(d.id, "the container disappeared");
    throw err;
  }
  if (!state.running) return fail(d.id, state.oom ? `out of memory (limit ${memory})` : `the container exited (code ${state.exitCode})`);
  if (!state.healthy) {
    if (Date.now() - +new Date(d.started_at!) > HEALTH_TIMEOUT_MS) {
      return fail(d.id, `nothing answered on port ${row.port} at ${row.health_path} within ${HEALTH_TIMEOUT_MS / 1000}s`);
    }
    return;
  }
  await promote(d, row);
}

/** Makes `d` the live deploy: Caddy first, then the old container goes after a drain. */
async function promote(d: DeployRow, row: SiteRow) {
  const previous = await sql.begin(async (tx) => {
    const ok = await tx`update mybase.hosting_deploys set status = 'live', live_at = now() where id = ${d.id} and status = 'starting' returning id`;
    if (!ok.length) return null;
    const old = await tx<{ id: string }[]>`
      update mybase.hosting_deploys set status = 'stopped', stopped_at = now() where site = ${d.site} and status = 'live' and id <> ${d.id} returning id`;
    await tx`update mybase.hosting_sites set live_deploy = ${d.id} where name = ${d.site}`;
    return old;
  });
  if (previous === null) return;
  log.info("deploy live", { site: d.site, deploy: d.id });
  await syncCaddy(log).catch((err) => log.error("caddy update failed", { err }));
  setTimeout(() => {
    for (const { id } of previous) void removeContainer(id);
  }, DRAIN_MS);
  await prune(row).catch((err) => log.warn("pruning old deploys failed", { site: d.site, err }));
}

/** Keeps the newest HOSTING_KEEP_DEPLOYS deploys (and the live one); the rest lose their images. */
async function prune(row: SiteRow) {
  const old = await sql<DeployRow[]>`
    select * from mybase.hosting_deploys where site = ${row.name} and id is distinct from ${row.live_deploy}
      and status in ('failed', 'stopped')
    order by created_at desc offset ${HOSTING_KEEP_DEPLOYS}`;
  if (!old.length) return;
  await sql`delete from mybase.hosting_deploys where id in ${sql(old.map((d) => d.id))}`;
  const kept = new Set((await sql<{ digest: string }[]>`select digest from mybase.hosting_deploys where site = ${row.name}`).map((r) => r.digest));
  const gone = [...new Set(old.map((d) => d.digest))].filter((digest) => !kept.has(digest));
  for (const digest of gone) await deleteManifest(`${row.project}/${row.name}`, digest);
  if (gone.length) await workerJson("/images", "DELETE", { images: gone.map((g) => imageRef(row.project, row.name, g)) }).catch(() => {});
}

/** Caddy's routes, from the live deploys. */
async function syncCaddy(log: Logger, force = false) {
  const rows = await sql<{ name: string; port: number; live_deploy: string }[]>`
    select name, port, live_deploy from mybase.hosting_sites where live_deploy is not null order by name`;
  const routes: CaddyRoute[] = rows.map((r) => ({ hosts: siteHosts(r.name), dial: `${containerName(r.name, r.live_deploy)}:${r.port}` }));
  await pushCaddy(routes, log, force);
}

/**
 * Makes Docker match the rows: live deploys missing a container get one again (Docker's
 * restart policy covers crashes; this covers pruned or hand-deleted containers), and labelled
 * containers nothing points at are removed.
 */
async function syncContainers() {
  const containers = await workerJson<{ deploy: string; running: boolean }[]>("/containers");
  const rows = await sql<{ id: string; status: HostingDeployStatus; stopped_at: Date | null }[]>`
    select id, status, stopped_at from mybase.hosting_deploys where status in ('queued', 'starting', 'live') or stopped_at > now() - interval '1 minute'`;
  const known = new Map(rows.map((r) => [r.id, r]));
  for (const c of containers) if (!known.has(c.deploy)) await removeContainer(c.deploy);
  const present = new Set(containers.map((c) => c.deploy));
  const missing = await sql<DeployRow[]>`select d.* from mybase.hosting_deploys d where d.status = 'live'`;
  for (const d of missing) {
    if (present.has(d.id)) continue;
    log.warn("live container missing, starting it again", { site: d.site, deploy: d.id });
    const [row] = await sql<SiteRow[]>`select * from mybase.hosting_sites where name = ${d.site}`;
    if (!row) continue;
    await worker(`/containers/${d.id}`, "PUT", { project: row.project, site: row.name, image: imageRef(row.project, row.name, d.digest), env: await containerEnv(row, d.id), memory }, 15 * 60_000).catch((err) =>
      log.error("restarting a live container failed", { site: d.site, err }),
    );
  }
}

let ticking = false;
let wake: (() => void) | null = null;
const kick = () => wake?.();

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const active = await sql<DeployRow[]>`select * from mybase.hosting_deploys where status in ('queued', 'starting') order by created_at`;
    // Starts run in the background (pulls are slow) and are claimed before the pull begins;
    // checks wait until the container is up.
    for (const d of active) if (d.status === "queued") void start(d).catch((err) => log.error("starting a deploy failed", { deploy: d.id, err }));
    await Promise.all(active.filter((d) => d.status === "starting" && !launching.has(d.id)).map(check));
  } catch (err) {
    if (!(err instanceof ServiceUnavailableError)) log.error("hosting reconcile failed", { err });
  } finally {
    ticking = false;
  }
}

/** Starts the reconcile loop. Does nothing until the worker is configured. */
export function startHosting() {
  if (!workerUrl || !workerKey) return;
  const boot = async () => {
    try {
      await syncContainers();
      await syncCaddy(log, true);
    } catch (err) {
      log.warn("hosting sync failed", { err });
    }
  };
  void boot();
  setInterval(boot, 60_000);
  // Every 2 s, or right away when a deploy is queued.
  const loop = async () => {
    for (;;) {
      await tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  };
  void loop();
  // Registry garbage collection: daily, when nobody pushed for 10 minutes.
  setInterval(() => {
    if (Date.now() - lastUpload() < 10 * 60_000) return;
    void workerJson("/registry/gc", "POST", undefined, 15 * 60_000).then(
      () => log.info("registry garbage collected"),
      (err) => log.warn("registry garbage collection failed", { err }),
    );
  }, 24 * 3600_000);
}

// ---- context ----------------------------------------------------------------

export async function hostingContext(project: string): Promise<NonNullable<ProjectContext["hosting"]>> {
  const o = await overview(project);
  return {
    registry: o.registry,
    sites: o.sites.map((s) => ({ name: s.name, url: s.url, port: s.port, status: s.latest?.status ?? null, liveDeploy: s.liveDeploy })),
  };
}

export const hostingDomain = () => domain;

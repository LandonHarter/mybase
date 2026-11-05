// The container registry service: a private Docker/OCI registry per project, at
// `<mybase host>/<project>/<name>`. One `registry:3` container holds every project's images; the
// API proxies `/v2/<project>/…` to it with API keys (`docker login <host> -u mybase`, password =
// a key with registry:write), so a key only reaches its own projects' repositories.
//
// Hosting stores its site images here too (`<project>/<site>`, pushed by digest, untagged), and
// prunes old digests in those repositories itself. Enabling hosting enables the registry first.
import type { ProjectContext, RegistryOverview, RegistryRepository, RegistryTag, RegistryTags } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { audit } from "./audit";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, UpstreamError } from "./errors";
import { listProjects, projectExists, sql, updateProjectMeta } from "./postgres";
import type { ServiceModule } from "./services";

const log = createLogger("registry");

// The registry from the API (proxy, listings, deletes).
const registryUrl = (process.env.MYBASE_REGISTRY_URL ?? "http://registry:5000").replace(/\/$/, "");
const publicHost = new URL(process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").host;

export const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const INDEX_TYPES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** One path component of a repository name (the distribution spec's rule). */
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
/** A repository name under a project: `api`, `tools/cli`, … */
const REPO_NAME = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
/** Tags shown per repository (details cost a request or two each). */
const MAX_TAGS = 200;

export const platform = () => `linux/${process.arch === "x64" ? "amd64" : process.arch}`;

let lastUploadAt = 0;
/** Registry pushes call this, so garbage collection never runs during one. */
export const notePush = () => {
  lastUploadAt = Date.now();
};
export const lastUpload = () => lastUploadAt;

// ---- registry calls ---------------------------------------------------------

async function registry(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  try {
    return await fetch(registryUrl + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ServiceUnavailableError("the image registry is unreachable. On the Docker host, run `mybase server registry`");
  }
}

/** `<project>/<name>` → its path in `/v2/…` (each component is already URL-safe). */
const repoPath = (repo: string) => `/v2/${repo}`;

/** Whether `repo` has a manifest `digest`. */
export async function manifestExists(repo: string, digest: string): Promise<boolean> {
  const res = await registry(`${repoPath(repo)}/manifests/${digest}`, { method: "HEAD", headers: { Accept: MANIFEST_TYPES.join(", ") } });
  return res.ok;
}

/** Deletes a manifest; logs instead of throwing (used for cleanup). */
export async function deleteManifest(repo: string, digest: string) {
  await registry(`${repoPath(repo)}/manifests/${digest}`, { method: "DELETE" }).catch((err) => log.warn("deleting a manifest failed", { repo, err }));
}

/** Every repository in the registry (the catalog, page by page). */
async function catalog(): Promise<string[]> {
  const repos: string[] = [];
  let last = "";
  for (let page = 0; page < 1000; page++) {
    const res = await registry(`/v2/_catalog?n=1000${last ? `&last=${encodeURIComponent(last)}` : ""}`);
    if (!res.ok) throw new UpstreamError(`the image registry answered ${res.status} listing repositories`);
    const { repositories } = (await res.json()) as { repositories?: string[] | null };
    const batch = repositories ?? [];
    repos.push(...batch);
    if (!res.headers.get("link") || batch.length === 0) break;
    last = batch[batch.length - 1]!;
  }
  return repos;
}

/** The project's repositories, as full names (`shop/api`). */
async function projectRepos(project: string): Promise<string[]> {
  return (await catalog()).filter((r) => r.startsWith(`${project}/`) && REPO_NAME.test(r.slice(project.length + 1)));
}

async function listTags(repo: string): Promise<string[]> {
  const res = await registry(`${repoPath(repo)}/tags/list?n=10000`);
  if (res.status === 404) return [];
  if (!res.ok) throw new UpstreamError(`the image registry answered ${res.status} listing tags`);
  return ((await res.json()) as { tags?: string[] | null }).tags ?? [];
}

interface Manifest {
  mediaType?: string;
  config?: { digest: string; size: number };
  layers?: { size: number }[];
  manifests?: { digest: string; size: number; mediaType?: string; platform?: { os: string; architecture: string; variant?: string } }[];
}

async function getManifest(repo: string, reference: string): Promise<{ digest: string; type: string; body: Manifest } | null> {
  const res = await registry(`${repoPath(repo)}/manifests/${reference}`, { headers: { Accept: MANIFEST_TYPES.join(", ") } });
  if (res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`the image registry answered ${res.status} reading a manifest`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const body = (await res.json()) as Manifest;
  return { digest: res.headers.get("docker-content-digest") ?? reference, type: body.mediaType ?? type, body };
}

const imageSize = (m: Manifest) => (m.config?.size ?? 0) + (m.layers ?? []).reduce((n, l) => n + l.size, 0);

/** Size and platforms of one tag or digest. */
async function describe(repo: string, reference: string, tag: string | null): Promise<RegistryTag | null> {
  const m = await getManifest(repo, reference);
  if (!m) return null;
  if (INDEX_TYPES.has(m.type) || m.body.manifests) {
    // Attestations (buildx provenance) show up as unknown/unknown: not a platform.
    const children = (m.body.manifests ?? []).filter((c) => c.platform && c.platform.os !== "unknown");
    const sizes = await Promise.all(children.slice(0, 16).map(async (c) => imageSize((await getManifest(repo, c.digest))?.body ?? {})));
    return {
      tag,
      digest: m.digest,
      size: Math.max(0, ...sizes),
      platforms: children.map((c) => `${c.platform!.os}/${c.platform!.architecture}${c.platform!.variant ? `/${c.platform!.variant}` : ""}`),
    };
  }
  let platforms: string[] = [];
  if (m.body.config && DIGEST.test(m.body.config.digest) && m.body.config.size < 1_000_000) {
    const res = await registry(`${repoPath(repo)}/blobs/${m.body.config.digest}`).catch(() => null);
    if (res?.ok) {
      const config = (await res.json().catch(() => ({}))) as { os?: string; architecture?: string; variant?: string };
      if (config.os && config.architecture) platforms = [`${config.os}/${config.architecture}${config.variant ? `/${config.variant}` : ""}`];
    } else await res?.body?.cancel();
  }
  return { tag, digest: m.digest, size: imageSize(m.body), platforms };
}

/** Runs `fn` over `items`, `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---- service ----------------------------------------------------------------

async function ping() {
  const res = await registry("/v2/", {}, 5000).catch(() => null);
  if (!res || (!res.ok && res.status !== 401)) {
    throw new ServiceUnavailableError("the image registry isn't running. On the Docker host, run `mybase server registry` once");
  }
}

/** Deletes every tagged manifest under `<project>/` (blobs go at the next garbage collection). */
async function deleteAllImages(project: string, log: Logger) {
  let count = 0;
  for (const repo of await projectRepos(project)) {
    const digests = new Set<string>();
    for (const tag of await listTags(repo)) {
      const m = await getManifest(repo, tag);
      if (m) digests.add(m.digest);
    }
    for (const digest of digests) {
      const res = await registry(`${repoPath(repo)}/manifests/${digest}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new UpstreamError(`the image registry answered ${res.status} deleting an image`);
      count++;
    }
  }
  log.info("registry images deleted", { count });
}

export const registryService: ServiceModule = {
  id: "registry",
  async enable(project, log) {
    await ping();
    await sql`insert into mybase.registry_projects (project) values (${project}) on conflict do nothing`;
    log.info("registry enabled");
  },
  async disable(project, log) {
    // Fails while the registry is down: a later project with the same name would get the images.
    await ping();
    await deleteAllImages(project, log);
    await sql`delete from mybase.registry_projects where project = ${project}`;
    log.info("registry disabled");
  },
};

export async function requireRegistry(project: string) {
  if (!(await projectExists(project)) || !(await sql`select 1 from mybase.registry_projects where project = ${project}`).length) {
    throw new NotFoundError("the container registry is not enabled for this project (mybase registry enable <project>)");
  }
}

/**
 * Projects that had hosting before the registry was its own service got a registry row from the
 * migration; this adds `registry` to their registry comment too. Runs at boot, cheap when done.
 */
export async function backfillRegistry(log: Logger) {
  const rows = await sql<{ project: string }[]>`select project from mybase.registry_projects`;
  if (!rows.length) return;
  const projects = new Map((await listProjects()).map((p) => [p.name, p]));
  for (const { project } of rows) {
    const p = projects.get(project);
    if (!p || p.services.includes("registry")) continue;
    await updateProjectMeta(project, (meta) => ({ ...meta, services: [...new Set([...(meta.services ?? []), "registry" as const])] }));
    log.info("registry service added to project", { project });
  }
}

// ---- listings ---------------------------------------------------------------

/** Repository name under the project from a query param; throws on anything else. */
function readRepo(project: string, value: string | null): string {
  if (!value) throw new BadRequestError("repo is required (a repository name under the project, e.g. api)");
  // Accept `shop/api` as well as `api`.
  const name = value.startsWith(`${project}/`) ? value.slice(project.length + 1) : value;
  if (name.length > 200 || !REPO_NAME.test(name)) throw new BadRequestError("repo must be lowercase letters, digits, and . _ - separated components (e.g. api or tools/cli)");
  return `${project}/${name}`;
}

/** Sites of `project`, by name (their repositories belong to hosting). */
async function siteNames(project: string): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`select s.name from mybase.hosting_sites s where s.project = ${project}`.catch(() => []);
  return new Set(rows.map((r) => r.name));
}

export async function overview(project: string): Promise<RegistryOverview> {
  await requireRegistry(project);
  const [repos, sites] = await Promise.all([projectRepos(project), siteNames(project)]);
  const repositories: RegistryRepository[] = await mapLimit(repos.sort(), 8, async (repo) => {
    const name = repo.slice(project.length + 1);
    return { name, tags: (await listTags(repo)).length, site: sites.has(name) ? name : null };
  });
  return { host: publicHost, prefix: `${publicHost}/${project}`, platform: platform(), repositories };
}

export async function tags(project: string, url: URL): Promise<RegistryTags> {
  await requireRegistry(project);
  const repo = readRepo(project, url.searchParams.get("repo"));
  const names = (await listTags(repo)).sort().slice(0, MAX_TAGS);
  const tagged = (await mapLimit(names, 6, (t) => describe(repo, t, t))).filter((t): t is RegistryTag => t !== null);
  // A site's deploys are pushed by digest, without tags: list the ones its deploys still use.
  const site = repo.slice(project.length + 1);
  const seen = new Set(tagged.map((t) => t.digest));
  const deployed = (await siteNames(project)).has(site)
    ? (await sql<{ digest: string }[]>`select digest from mybase.hosting_deploys where site = ${site} group by digest order by max(created_at) desc`).map((r) => r.digest).filter((d) => !seen.has(d))
    : [];
  const untagged = (await mapLimit(deployed, 6, (d) => describe(repo, d, null))).filter((t): t is RegistryTag => t !== null);
  return { repository: repo.slice(project.length + 1), tags: [...tagged, ...untagged] };
}

/** Throws 409 when a queued, starting, or live hosting deploy of `<project>/<name>` uses `digest`. */
async function notDeployed(project: string, name: string, digest: string) {
  const [used] = await sql<{ id: string; status: string }[]>`
    select d.id, d.status from mybase.hosting_deploys d join mybase.hosting_sites s on s.name = d.site
    where s.project = ${project} and d.site = ${name} and d.digest = ${digest} and d.status in ('queued', 'starting', 'live')
    limit 1`;
  if (used) throw new ConflictError(`site "${name}" uses this image (deploy ${used.id.slice(0, 8)}, ${used.status}); deploy another one first`);
}

export async function deleteImage(project: string, url: URL, log: Logger) {
  await requireRegistry(project);
  const repo = readRepo(project, url.searchParams.get("repo"));
  const digest = url.searchParams.get("digest") ?? "";
  if (!DIGEST.test(digest)) throw new BadRequestError("digest must be a sha256:… manifest digest");
  await notDeployed(project, repo.slice(project.length + 1), digest);
  const res = await registry(`${repoPath(repo)}/manifests/${digest}`, { method: "DELETE" });
  if (res.status === 404) throw new NotFoundError(`no image ${digest} in ${repo}`);
  if (!res.ok) throw new UpstreamError(`the image registry answered ${res.status}`);
  log.info("registry image deleted", { repo, digest });
  audit({ action: "registry.image.deleted", project, target: `${repo}@${digest}` });
}

// ---- proxy ------------------------------------------------------------------

// Hop-by-hop and credential headers stay on this side.
const DROP_REQUEST = new Set(["authorization", "cookie", "host", "connection", "keep-alive", "transfer-encoding", "te", "upgrade", "proxy-authorization"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "te", "upgrade"]);

/**
 * `/v2/<project>/<name>/(manifests|blobs|tags)/…` → the internal registry. The key was checked by
 * `logged` (`requirement` maps `/v2/<project>/…` to registry).
 */
export async function proxyRegistry(req: Request, project: string): Promise<Response> {
  await requireRegistry(project);
  const url = new URL(req.url);
  // Encoded characters could make the registry see another path than the one checked here.
  if (url.pathname.includes("%")) throw new NotFoundError("no such repository");
  const route = new RegExp(`^/v2/${project}/(${COMPONENT}(?:/${COMPONENT})*)/(manifests|blobs|tags)/(.*)$`).exec(url.pathname);
  if (!route) throw new NotFoundError("no such repository");
  const [, name, kind, rest] = route as unknown as [string, string, string, string];
  // Cross-repository blob mounts (`?mount=<digest>&from=<repo>`) may only take from this project's
  // repositories; without the check a key for one project could copy another's layers.
  const from = url.searchParams.get("from");
  if (from !== null && !from.startsWith(`${project}/`)) {
    url.searchParams.delete("mount");
    url.searchParams.delete("from");
  }
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!DROP_REQUEST.has(k.toLowerCase())) headers.set(k, v);
  });
  if (req.method === "DELETE" && kind === "manifests" && DIGEST.test(rest)) await notDeployed(project, name, rest);
  const write = req.method !== "GET" && req.method !== "HEAD";
  if (write) notePush();
  let res: Response;
  try {
    res = await fetch(`${registryUrl}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: write ? req.body : undefined,
      redirect: "manual",
      decompress: false,
    });
  } catch {
    throw new ServiceUnavailableError("the image registry is unreachable");
  }
  if (kind === "manifests" && res.ok && (req.method === "PUT" || req.method === "DELETE")) {
    const target = `${project}/${name}${rest.startsWith("sha256:") ? "@" : ":"}${rest}`;
    audit({ action: req.method === "PUT" ? "registry.image.pushed" : "registry.image.deleted", project, target });
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers: out });
}

// ---- context ----------------------------------------------------------------

export async function registryContext(project: string): Promise<NonNullable<ProjectContext["registry"]>> {
  const o = await overview(project);
  return { host: o.host, prefix: o.prefix, repositories: o.repositories.map(({ name, tags }) => ({ name, tags })) };
}

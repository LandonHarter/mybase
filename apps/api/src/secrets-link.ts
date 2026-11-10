// `mybase secrets link`: stores the project's own credentials as managed secrets. They were
// shown once at project creation and never stored, so linking rotates them (new database
// password, new storage key, new cache password if the cache is on) and keeps the new ones,
// encrypted, in every linked env. Apps holding the old credentials stop working.
//
// Every other service's keys go along: stored ones (cron secret, analytics key, captcha secret,
// realtime secret) are copied as they are, and one API key limited to the project
// (MYBASE_API_KEY) covers the services apps call with a key. Turning a service on can add its keys to the linked envs
// (`linkService`), turning it off removes them, and rotating one updates them.
import type {
  EnableServiceResponse,
  KeyPermission,
  LinkCredentialsResponse,
  LinkRef,
  LinkService,
  LinkServicesResponse,
  SecretsDoctorFinding,
  ServiceId,
} from "@mybase/shared";
import { SECRET_KEY_PATTERN } from "@mybase-dev/sdk/secrets";
import type { Logger } from "@mybase/shared/logger";
import { getSettings as analyticsSettings } from "./analytics";
import { createToken, deleteToken, updateToken } from "./auth";
import { rotatePassword } from "./cache";
import { getSettings as captchaSettings } from "./captcha";
import { getSettings as realtimeSettings } from "./realtime";
import { getSecret as cronSecret } from "./cron";
import { BadRequestError, ConflictError, NotFoundError, UpstreamError } from "./errors";
import { canSeeEnv, requireAllEnvs, requireEnv, type Grant } from "./permissions";
import { listProjects, rotateDatabasePassword, sql } from "./postgres";
import { actorOf, linkedEnvs, literalKeys, literalValues, managedKeys, overview, readCredentials, requireEnabled, unlinkKeys, writeCredentials, writeLinks, writeManaged } from "./secrets";
import type { Auth } from "./auth";
import { currentTopology } from "./access";
import { findOwnCredentials } from "./secrets-doctor";
import { isLinkRoute, isLinkService, isSslMode, linkKeys, LinkError, type LinkCredentials } from "./secrets-resolve";
import { projectKeyIds, rotateStorageKey } from "./storage";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** What MYBASE_API_KEY may do for each service apps call with an API key. */
const APP_PERMISSIONS: Partial<Record<ServiceId, KeyPermission>> = {
  cron: "cron:write",
  cache: "cache:write",
  ratelimit: "ratelimit:write",
  queue: "queue:write",
  search: "search:read",
  vector: "vector:write",
  users: "users:write",
  captcha: "captcha:write",
  realtime: "realtime:write",
  sandbox: "sandbox:write",
  email: "email:write",
};

/** Managed keys a service owns, besides its share of MYBASE_API_KEY. */
const SERVICE_KEYS: Partial<Record<ServiceId, string[]>> = {
  cache: ["REDIS_URL"],
  cron: ["MYBASE_CRON_SECRET"],
  analytics: ["MYBASE_ANALYTICS_KEY"],
  captcha: ["MYBASE_CAPTCHA_SECRET"],
  realtime: ["MYBASE_REALTIME_SECRET"],
};

/** Services that have something to link (everything but secrets itself). */
export const linkable = (id: ServiceId) => id in APP_PERMISSIONS || id in SERVICE_KEYS;

/**
 * A service's own keys. Stored ones are read as they are; the cache password isn't stored, so
 * it's rotated unless `cacheUrl` (from enabling or rotating it just now) is given.
 */
async function serviceValues(project: string, id: ServiceId, log: Logger, cacheUrl?: string): Promise<Record<string, string>> {
  switch (id) {
    case "cache":
      return { REDIS_URL: cacheUrl ?? (await rotatePassword(project, log)).url };
    case "cron":
      return { MYBASE_CRON_SECRET: (await cronSecret(project)).secret };
    case "analytics":
      return { MYBASE_ANALYTICS_KEY: (await analyticsSettings(project)).writeKey };
    case "captcha":
      return { MYBASE_CAPTCHA_SECRET: (await captchaSettings(project)).secretKey };
    case "realtime":
      return { MYBASE_REALTIME_SECRET: (await realtimeSettings(project)).secret };
    default:
      return {};
  }
}

async function projectServices(project: string): Promise<ServiceId[]> {
  const found = (await listProjects()).find((p) => p.name === project);
  if (!found) throw new NotFoundError(`project "${project}" not found`);
  return found.services;
}

const appPermissions = (services: ServiceId[]) => [...new Set(services.flatMap((s) => APP_PERMISSIONS[s] ?? []))];

/** Linked envs and the linked API key's id; null when secrets are off. */
async function linkState(project: string): Promise<{ envs: string[]; token: string | null } | null> {
  const [row]: { envs: string[]; token: string | null }[] = await sql`
    select linked_envs as envs, linked_token as token from mybase.secrets_projects where project = ${project}`;
  return row ?? null;
}

const setToken = (project: string, token: string | null) =>
  sql`update mybase.secrets_projects set linked_token = ${token} where project = ${project}`;

/** A new linked API key with `permissions` (the old one is revoked), or none when there's nothing to allow. */
async function rotateAppKey(project: string, permissions: KeyPermission[], log: Logger): Promise<string | null> {
  const old = (await linkState(project))?.token ?? null;
  let token: string | null = null;
  if (permissions.length > 0) {
    const created = await createToken({ name: `${project} (secrets link)`, permissions, projects: [project] }, log);
    await setToken(project, created.id);
    token = created.token;
  } else {
    await setToken(project, null);
  }
  if (old) await deleteToken(old, log);
  return token;
}

async function readEnvs(project: string, value: unknown, grant: Grant): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.some((e) => typeof e !== "string")) {
    throw new BadRequestError("envs must be a non-empty list of environment names");
  }
  const known = new Set((await overview(project, grant)).envs.map((e) => e.name));
  for (const env of value as string[]) if (!known.has(env)) throw new NotFoundError(`no secrets environment named "${env}"`);
  return [...new Set(value as string[])];
}

const setLinked = (project: string, envs: string[]) =>
  sql`update mybase.secrets_projects set linked_envs = ${sql.array(envs, "text")} where project = ${project}`;

/** Rotates the project's credentials and writes them to `envs` plus every env linked before. */
export async function linkCredentials(project: string, body: Record<string, unknown>, grant: Grant, log: Logger): Promise<LinkCredentialsResponse> {
  await requireEnabled(project);
  requireAllEnvs(grant);
  const requested = await readEnvs(project, body.envs, grant);
  const envs = [...new Set([...(await linkedEnvs(project)), ...requested])];
  const services = await projectServices(project);

  const values: Record<string, string> = { MYBASE_URL: publicApiUrl, MYBASE_PROJECT: project };
  // Each rotation makes the old credential useless, so whatever rotated is saved even if a
  // later step fails: losing a fresh password would leave the app with nothing that works.
  let step = "the database password";
  let failed: string | null = null;
  const stored: LinkCredentials = {};
  try {
    const db = await rotateDatabasePassword(project, log);
    values.DATABASE_URL = db.url;
    stored.database = { password: db.password };
    step = "the storage key";
    const s3 = await rotateStorageKey(project, log);
    stored.storage = { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey };
    Object.assign(values, {
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_BUCKET: s3.bucket,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    });
    for (const id of services) {
      step = `the ${id} keys`;
      Object.assign(values, await serviceValues(project, id, log));
    }
    if (values.REDIS_URL) stored.cache = { password: decodeURIComponent(new URL(values.REDIS_URL).password) };
    step = "the API key";
    const key = await rotateAppKey(project, appPermissions(services), log);
    if (key) values.MYBASE_API_KEY = key;
    stored.apiKey = key ?? undefined;
  } catch (err) {
    failed = step;
    log.error("credential rotation failed", { failed, err });
  }
  // Keys linked per service (`--database` …) read the stored credentials: keep them current too.
  await writeCredentials(project, stored, log);

  for (const env of envs) await writeManaged(project, env, values, failed === null ? "stale" : [], "linked project credentials", log);
  await setLinked(project, envs);
  if (failed) throw new UpstreamError(`rotating ${failed} failed; what rotated before it was saved. Run link again.`);
  log.info("secrets linked", { envs: envs.length, keys: Object.keys(values).length });
  return { envs, keys: Object.keys(values).sort() };
}

/** Removes the credentials from one env (nothing is rotated). */
export async function unlinkEnv(project: string, env: string, grant: Grant, log: Logger) {
  await requireEnabled(project);
  requireAllEnvs(grant);
  const linked = await linkedEnvs(project);
  if (!linked.includes(env)) throw new NotFoundError(`"${env}" isn't linked`);
  await writeManaged(project, env, {}, [...(await managedKeys(project, env))], "unlinked project credentials", log);
  await setLinked(project, linked.filter((e) => e !== env));
  log.info("secrets unlinked", { env });
}

/**
 * After `id` was turned on (and recorded): adds its keys to every linked env, and its permission
 * to the linked API key. Returns the envs written; none when nothing is linked.
 */
export async function linkService(project: string, id: ServiceId, enabled: EnableServiceResponse | void, log: Logger): Promise<string[]> {
  const state = await linkState(project);
  if (!state || state.envs.length === 0 || !linkable(id)) return [];
  await requireEnabled(project);
  const values = await serviceValues(project, id, log, enabled?.service === "cache" ? enabled.credentials.url : undefined);
  if (id in APP_PERMISSIONS) {
    const permissions = appPermissions(await projectServices(project));
    const updated = state.token ? await updateToken(state.token, { permissions }, log) : null;
    // No key yet, or someone revoked it: make one.
    if (!updated) values.MYBASE_API_KEY = (await rotateAppKey(project, permissions, log))!;
  }
  for (const env of state.envs) await writeManaged(project, env, values, [], `linked ${id} keys`, log);
  log.info("service keys linked", { service: id, envs: state.envs.length });
  return state.envs;
}

/** After `id` was turned off (and recorded): removes its keys from the linked envs and narrows the API key. */
export async function unlinkService(project: string, id: ServiceId, log: Logger) {
  // Linked REDIS_URLs stop resolving (with a clear error) instead of pointing at a dead user.
  if (id === "cache" && (await sql`select 1 from mybase.secrets_credentials where project = ${project}`).length) {
    await writeCredentials(project, { cache: undefined }, log).catch((err) => log.warn("forgetting the cache password failed", { err }));
  }
  const state = await linkState(project);
  if (!state || state.envs.length === 0 || !linkable(id)) return;
  const unset = [...(SERVICE_KEYS[id] ?? [])];
  if (id in APP_PERMISSIONS && state.token) {
    const permissions = appPermissions(await projectServices(project));
    if (permissions.length > 0) {
      await updateToken(state.token, { permissions }, log);
    } else {
      await rotateAppKey(project, [], log);
      unset.push("MYBASE_API_KEY");
    }
  }
  if (unset.length === 0) return;
  await requireEnabled(project);
  for (const env of state.envs) await writeManaged(project, env, {}, unset, `unlinked ${id} keys`, log);
  log.info("service keys unlinked", { service: id, envs: state.envs.length });
}

/**
 * After a service's key was rotated: updates the envs that hold it (linked ones where it was
 * linked before). `cacheUrl` is the new cache URL, which isn't stored anywhere else.
 */
export async function relinkService(project: string, id: ServiceId, log: Logger, cacheUrl?: string) {
  if (id === "cache" && cacheUrl) await rememberCachePassword(project, cacheUrl, log);
  const state = await linkState(project);
  if (!state || state.envs.length === 0) return;
  const keys = SERVICE_KEYS[id] ?? [];
  const holding: string[] = [];
  for (const env of state.envs) {
    const managed = await managedKeys(project, env);
    if (keys.some((k) => managed.has(k))) holding.push(env);
  }
  if (holding.length === 0) return;
  const values = await serviceValues(project, id, log, cacheUrl);
  for (const env of holding) await writeManaged(project, env, values, [], `rotated ${id} keys`, log);
  log.info("service keys relinked", { service: id, envs: holding.length });
}

// ---- service links (`secrets link --database` …) ------------------------------------

/**
 * Keeps the stored cache password current when it changes outside `link` (enable, rotate), so
 * linked REDIS_URLs follow. Only when one is stored already; never fails the caller.
 */
export async function rememberCachePassword(project: string, url: string, log: Logger) {
  try {
    const [row] = await sql`select 1 from mybase.secrets_credentials where project = ${project}`;
    if (!row) return;
    const { creds } = await readCredentials(project);
    if (!creds.cache) return;
    await writeCredentials(project, { cache: { password: decodeURIComponent(new URL(url).password) } }, log);
  } catch (err) {
    log.warn("updating the linked cache password failed", { err });
  }
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function readParams(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("params must map names to strings");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new BadRequestError("at most 20 params");
  for (const [k, v] of entries) {
    if (!PARAM_NAME.test(k) || typeof v !== "string" || v.length > 200) throw new BadRequestError(`param ${JSON.stringify(k)} must be a name with a string value up to 200 characters`);
    if (k === "sslmode") throw new BadRequestError("set sslmode with --sslmode, not --param");
  }
  return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

/** Credentials mybase must hold for a service link; rotated when missing (they were shown once). */
async function ensureCredentials(project: string, services: LinkService[], rotate: boolean, log: Logger): Promise<LinkService[]> {
  const { creds } = await readCredentials(project);
  const rotated: LinkService[] = [];
  const patch: LinkCredentials = {};
  const literal: Record<string, string> = {};
  for (const service of services) {
    switch (service) {
      case "database":
        if (creds.database && !rotate) break;
        {
          const db = await rotateDatabasePassword(project, log);
          patch.database = { password: db.password };
          literal.DATABASE_URL = db.url;
        }
        rotated.push(service);
        break;
      case "storage":
        if (creds.storage && !rotate) break;
        {
          const s3 = await rotateStorageKey(project, log);
          patch.storage = { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey };
          Object.assign(literal, { S3_ACCESS_KEY_ID: s3.accessKeyId, S3_SECRET_ACCESS_KEY: s3.secretAccessKey });
        }
        rotated.push(service);
        break;
      case "cache": {
        if (!(await projectServices(project)).includes("cache")) throw new BadRequestError(`the cache isn't on for "${project}": mybase cache enable ${project}`);
        if (creds.cache && !rotate) break;
        const cache = await rotatePassword(project, log);
        patch.cache = { password: cache.password };
        literal.REDIS_URL = cache.url;
        rotated.push(service);
        break;
      }
      case "api": {
        if (creds.apiKey && !rotate) break;
        const key = await rotateAppKey(project, appPermissions(await projectServices(project)), log);
        if (!key) break;
        patch.apiKey = key;
        literal.MYBASE_API_KEY = key;
        rotated.push(service);
        break;
      }
    }
  }
  if (rotated.length === 0) return rotated;
  await writeCredentials(project, patch, log);
  // Envs linked the old way (`link --env`) hold literal copies: give them the new ones, or they break.
  const state = await linkState(project);
  for (const env of state?.envs ?? []) {
    const held = await managedKeys(project, env);
    const update = Object.fromEntries(Object.entries(literal).filter(([k]) => held.has(k)));
    if (Object.keys(update).length) await writeManaged(project, env, update, [], "rotated linked credentials", log);
  }
  return rotated;
}

/**
 * `POST /projects/:name/secrets/envs/:env/links`: links keys of one env to the project's own
 * services. Values aren't stored: they're resolved per reader (secrets-resolve.ts).
 */
export async function linkServices(project: string, env: string, body: Record<string, unknown>, auth: Auth, log: Logger): Promise<LinkServicesResponse> {
  await requireEnabled(project);
  // Storing credentials rotates them for every env, so like `link --env` this needs all envs.
  requireAllEnvs(auth);
  const services = body.services;
  if (!Array.isArray(services) || services.length === 0 || !services.every(isLinkService)) {
    throw new BadRequestError("services must be a non-empty list of database, cache, storage, api");
  }
  const unique = [...new Set(services)] as LinkService[];
  const as = body.as;
  if (as !== undefined && (typeof as !== "string" || !SECRET_KEY_PATTERN.test(as))) throw new BadRequestError("as must be a valid key name");
  if (as !== undefined && unique.length !== 1) throw new BadRequestError("as works with one service at a time");
  const route = body.route ?? "auto";
  if (!isLinkRoute(route)) throw new BadRequestError("route must be auto, internal, localhost, lan, tailscale, public, or proxy");
  if (route === "proxy" && unique.some((s) => s !== "database")) throw new BadRequestError("the proxy route is for the database only");
  if (body.sslmode !== undefined && !isSslMode(body.sslmode)) throw new BadRequestError("sslmode must be disable, require, or verify-full");
  if (body.sslmode !== undefined && unique.some((s) => s !== "database")) throw new BadRequestError("sslmode is for the database only");
  const params = readParams(body.params);
  if (params && unique.some((s) => s !== "database" && s !== "cache")) throw new BadRequestError("params are for database and cache URLs only");

  // MYBASE_API_KEY only when some service that's on is called with a key (as with `link --env`).
  const includeKey = appPermissions(await projectServices(project)).length > 0;
  const links = new Map<string, LinkRef>();
  try {
    for (const service of unique) {
      for (const [key, field] of linkKeys(service, as as string | undefined, { includeKey })) {
        const routed = field === "url" || field === "endpoint";
        links.set(key, {
          service,
          field,
          route: routed ? route : "auto",
          ...(service === "database" && body.sslmode ? { sslmode: body.sslmode as LinkRef["sslmode"] } : {}),
          ...(params && routed ? { params } : {}),
        });
      }
    }
  } catch (err) {
    if (err instanceof LinkError) throw new BadRequestError(err.message);
    throw err;
  }

  // Check the keys first (409 before anything rotates), then store credentials, then write.
  const replace = body.replace === true;
  if (!replace) {
    const taken = await literalKeys(project, env, [...links.keys()]);
    if (taken.length) throw new ConflictError(`already set in "${env}": ${taken.join(", ")}. Replace with links (the old values stay in the history)? Pass replace (CLI: --yes)`);
  }
  if (body.rotate !== true && body.rotateMissing !== true) {
    const { creds } = await readCredentials(project);
    const held = { database: creds.database, storage: creds.storage, cache: creds.cache, api: creds.apiKey ?? (includeKey ? undefined : "not needed") };
    const missing = unique.filter((sv) => !held[sv]);
    if (missing.length) {
      throw new ConflictError(
        `mybase doesn't hold the ${missing.join(", ")} credentials of "${project}" yet (they were shown once): linking rotates them once, and apps using the current ones stop working until they read the linked env. Pass rotateMissing (CLI: --yes)`,
      );
    }
  }
  const rotated = await ensureCredentials(project, includeKey ? unique : unique.filter((sv) => sv !== "api"), body.rotate === true, log);
  const result = await writeLinks(project, env, links, replace, actorOf(auth), log);
  log.info("services linked", { env, services: unique.length, rotated: rotated.length });
  return { env, revision: result.revision, links: Object.fromEntries(links), rotated };
}

/** `DELETE /projects/:name/secrets/envs/:env/links/:key`. Nothing is rotated. */
export async function unlinkServiceKey(project: string, env: string, key: string, auth: Auth, log: Logger) {
  await requireEnabled(project);
  requireEnv(auth, env);
  return unlinkKeys(project, env, [key], actorOf(auth), log);
}

/** `GET /projects/:name/secrets/doctor`: literal values that look like this project's own credentials. */
export async function secretsDoctor(project: string, env: string | null, auth: Auth): Promise<SecretsDoctorFinding[]> {
  await requireEnabled(project);
  const keyIds = await projectKeyIds(project).catch(() => [] as string[]);
  const topo = currentTopology();
  const apiUrls = topo.api.flatMap((r) => (r.url ? [r.url] : []));
  const findings: SecretsDoctorFinding[] = [];
  for (const e of (await overview(project, auth)).envs) {
    if (env !== null && e.name !== env) continue;
    if (!canSeeEnv(auth, e.name)) continue;
    const values = await literalValues(project, e.name);
    findings.push(...findOwnCredentials(project, e.name, values, { storageKeyIds: keyIds, apiUrls }));
  }
  return findings;
}

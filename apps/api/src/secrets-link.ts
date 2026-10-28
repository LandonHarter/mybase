// `mybase secrets link`: stores the project's own credentials as managed secrets. They were
// shown once at project creation and never stored, so linking rotates them (new database
// password, new storage key, new cache password if the cache is on) and keeps the new ones,
// encrypted, in every linked env. Apps holding the old credentials stop working.
//
// Every other service's keys go along: stored ones (cron secret, analytics key, captcha secret)
// are copied as they are, and one API key limited to the project (MYBASE_API_KEY) covers the
// services apps call with a key. Turning a service on can add its keys to the linked envs
// (`linkService`), turning it off removes them, and rotating one updates them.
import type { EnableServiceResponse, KeyPermission, LinkCredentialsResponse, ServiceId } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { getSettings as analyticsSettings } from "./analytics";
import { createToken, deleteToken, updateToken } from "./auth";
import { rotatePassword } from "./cache";
import { getSettings as captchaSettings } from "./captcha";
import { getSecret as cronSecret } from "./cron";
import { BadRequestError, NotFoundError, UpstreamError } from "./errors";
import { requireAllEnvs, type Grant } from "./permissions";
import { listProjects, rotateDatabasePassword, sql } from "./postgres";
import { linkedEnvs, managedKeys, overview, requireEnabled, writeManaged } from "./secrets";
import { rotateStorageKey } from "./storage";

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
};

/** Managed keys a service owns, besides its share of MYBASE_API_KEY. */
const SERVICE_KEYS: Partial<Record<ServiceId, string[]>> = {
  cache: ["REDIS_URL"],
  cron: ["MYBASE_CRON_SECRET"],
  analytics: ["MYBASE_ANALYTICS_KEY"],
  captcha: ["MYBASE_CAPTCHA_SECRET"],
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
  try {
    values.DATABASE_URL = (await rotateDatabasePassword(project, log)).url;
    step = "the storage key";
    const s3 = await rotateStorageKey(project, log);
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
    step = "the API key";
    const key = await rotateAppKey(project, appPermissions(services), log);
    if (key) values.MYBASE_API_KEY = key;
  } catch (err) {
    failed = step;
    log.error("credential rotation failed", { failed, err });
  }

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
  await writeManaged(project, env, {}, "stale", "unlinked project credentials", log);
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

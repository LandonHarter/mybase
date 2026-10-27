// `mybase secrets link`: stores the project's own credentials as managed secrets. They were
// shown once at project creation and never stored, so linking rotates them (new database
// password, new storage key, new cache password if the cache is on) and keeps the new ones,
// encrypted, in every linked env. Apps holding the old credentials stop working.
import type { LinkCredentialsResponse } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { cacheEnabled, rotatePassword } from "./cache";
import { BadRequestError, NotFoundError, UpstreamError } from "./errors";
import { requireAllEnvs, type Grant } from "./permissions";
import { rotateDatabasePassword, sql } from "./postgres";
import { linkedEnvs, overview, requireEnabled, writeManaged } from "./secrets";
import { rotateStorageKey } from "./storage";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

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

  const values: Record<string, string> = { MYBASE_URL: publicApiUrl, MYBASE_PROJECT: project };
  // Each rotation makes the old credential useless, so whatever rotated is saved even if a
  // later step fails: losing a fresh password would leave the app with nothing that works.
  let failed: string | null = null;
  try {
    values.DATABASE_URL = (await rotateDatabasePassword(project, log)).url;
    const s3 = await rotateStorageKey(project, log);
    Object.assign(values, {
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_BUCKET: s3.bucket,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    });
    if (await cacheEnabled(project)) values.REDIS_URL = (await rotatePassword(project, log)).url;
  } catch (err) {
    failed = values.S3_ACCESS_KEY_ID ? "the cache password" : values.DATABASE_URL ? "the storage key" : "the database password";
    log.error("credential rotation failed", { failed, err });
  }

  for (const env of envs) await writeManaged(project, env, values, failed === null, "linked project credentials", log);
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
  await writeManaged(project, env, {}, true, "unlinked project credentials", log);
  await setLinked(project, linked.filter((e) => e !== env));
  log.info("secrets unlinked", { env });
}

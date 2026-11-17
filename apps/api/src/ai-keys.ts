// Provider keys for the AI gateway: literal values in the project's secrets env (`ai` by
// default). Read in memory per project and re-read only when the env (or its parent) has a new
// revision: one cheap `select` per request. Values are never logged or returned.
import type { Logger } from "@mybase/shared/logger";
import type { Auth } from "./auth";
import { ConflictError } from "./errors";
import { sql } from "./postgres";
import { literalValues, updateSecrets } from "./secrets";

const cache = new Map<string, { version: string; keys: Record<string, string> }>();

async function envVersion(project: string, env: string): Promise<string | null> {
  const [row]: { version: string }[] = await sql`
    select e.id::text || '.' || e.revision || '.' || coalesce(p.id::text || '.' || p.revision, '0') as version
    from mybase.secrets_envs e left join mybase.secrets_envs p on p.id = e.parent_id
    where e.project = ${project} and e.name = ${env}`;
  return row?.version ?? null;
}

/** The env's literal values (provider keys and settings like AZURE_RESOURCE_NAME). */
export async function providerKeys(project: string, env: string): Promise<Record<string, string>> {
  const version = await envVersion(project, env);
  if (version === null) throw new ConflictError(`the AI keys env "${env}" doesn't exist in secrets: create it, or change the keys env in the AI settings`);
  const key = `${project}\0${env}`;
  const hit = cache.get(key);
  if (hit?.version === version) return hit.keys;
  const keys = await literalValues(project, env);
  cache.set(key, { version, keys });
  return keys;
}

/** Names of the keys set in the env (no values). */
export async function keyNames(project: string, env: string): Promise<Set<string>> {
  try {
    return new Set(Object.keys(await providerKeys(project, env)));
  } catch {
    return new Set();
  }
}

/** Sets and removes keys as one secrets revision (history, restore, and audit work as usual). */
export async function setKeys(project: string, env: string, set: Record<string, string>, unset: string[], auth: Auth, log: Logger) {
  const result = await updateSecrets(project, env, { set, unset, message: "AI provider keys" }, auth, log);
  cache.delete(`${project}\0${env}`);
  return result;
}

export function forgetKeys(project: string) {
  for (const k of cache.keys()) if (k.startsWith(`${project}\0`)) cache.delete(k);
}

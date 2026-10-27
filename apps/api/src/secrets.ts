// The secrets service: env vars and secrets per environment, Doppler-style. Each project
// starts with dev, staging, and prod; branch envs (e.g. dev_alice) inherit a root env's keys
// and override some. Apps get them with `mybase run -- <cmd>` or the SDK.
//
// Values are encrypted (secrets-crypto.ts) and never logged; key names are logged as counts
// only. Every change is a revision with old and new ciphertexts, so history and restore never
// need to re-encrypt. Agents see names only: the MCP tools never ask for values.
import type {
  ProjectContext,
  SecretChange,
  SecretEntry,
  SecretsEnv,
  SecretsEnvDetail,
  SecretsOverview,
  SecretsResponse,
  SecretsRevision,
  UpdateSecretsResponse,
} from "@mybase/shared";
import {
  DEFAULT_SECRETS_ENVS,
  SECRET_KEY_PATTERN,
  SECRET_KEY_RULES,
  SECRETS_ENV_PATTERN,
  SECRETS_ENV_RULES,
  SECRETS_LIMITS,
} from "@mybase-dev/sdk/secrets";
import type { Logger } from "@mybase/shared/logger";
import type { Auth } from "./auth";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors";
import { canSeeEnv, requireAllEnvs, requireEnv, type Grant } from "./permissions";
import { sql } from "./postgres";
import {
  decodeKey,
  decryptValue,
  encryptValue,
  importMaster,
  newDataKey,
  rewrapDataKey,
  sameId,
  unwrapDataKey,
  type MasterKey,
} from "./secrets-crypto";
import { overlay, rewind, sameBytes, type StoredChange } from "./secrets-state";
import type { ServiceModule } from "./services";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

// ---- master key -------------------------------------------------------------

let master: MasterKey | null = null;

/**
 * Reads MYBASE_SECRETS_KEY at boot. Unset: the service answers 503 and nothing else changes.
 * Malformed: throws, since secrets would be unreadable. With MYBASE_SECRETS_KEY_OLD also set,
 * re-wraps every project's data key from the old master to the new one (values untouched).
 */
export async function startSecrets(bootLog: Logger) {
  const raw = process.env.MYBASE_SECRETS_KEY;
  if (!raw) {
    const [{ count }]: { count: number }[] = await sql`select count(*)::int as count from mybase.secrets_projects`;
    if (count > 0) bootLog.error("MYBASE_SECRETS_KEY is not set: secrets are unavailable", { projects: count });
    return;
  }
  master = await importMaster(decodeKey(raw, "MYBASE_SECRETS_KEY"));

  const rows: { project: string; wrapped: Uint8Array; masterId: Uint8Array }[] = await sql`
    select project, wrapped_key as wrapped, master_id as "masterId" from mybase.secrets_projects`;
  const oldRaw = process.env.MYBASE_SECRETS_KEY_OLD;
  const old = oldRaw ? await importMaster(decodeKey(oldRaw, "MYBASE_SECRETS_KEY_OLD")) : null;
  let rewrapped = 0;
  let unreadable = 0;
  for (const row of rows) {
    if (sameId(row.masterId, master.id)) continue;
    if (old && sameId(row.masterId, old.id)) {
      const wrapped = await rewrapDataKey(old, master, row.wrapped);
      await sql`update mybase.secrets_projects set wrapped_key = ${Buffer.from(wrapped)}, master_id = ${Buffer.from(master.id)} where project = ${row.project}`;
      rewrapped++;
    } else {
      unreadable++;
    }
  }
  if (rewrapped > 0) bootLog.info("secrets re-encrypted with the new MYBASE_SECRETS_KEY; remove MYBASE_SECRETS_KEY_OLD", { projects: rewrapped });
  if (unreadable > 0) bootLog.error("some projects' secrets were stored with a different MYBASE_SECRETS_KEY", { projects: unreadable });
}

function requireMaster(): MasterKey {
  if (!master) {
    throw new ServiceUnavailableError("secrets need MYBASE_SECRETS_KEY: set it to 32 random bytes (openssl rand -base64 32) and restart mybase");
  }
  return master;
}

/** Unwrapped data keys by project. */
const dataKeys = new Map<string, CryptoKey>();

async function dataKey(project: string): Promise<CryptoKey> {
  const cached = dataKeys.get(project);
  if (cached) return cached;
  const m = requireMaster();
  const [row]: { wrapped: Uint8Array; masterId: Uint8Array }[] = await sql`
    select wrapped_key as wrapped, master_id as "masterId" from mybase.secrets_projects where project = ${project}`;
  if (!row) throw new NotFoundError("secrets are not enabled for this project");
  if (!sameId(row.masterId, m.id)) {
    throw new ServiceUnavailableError("this project's secrets were stored with a different MYBASE_SECRETS_KEY (set MYBASE_SECRETS_KEY_OLD to rotate)");
  }
  const key = await unwrapDataKey(m, row.wrapped);
  dataKeys.set(project, key);
  return key;
}

// ---- service ----------------------------------------------------------------

/** Projects known to have the service on. */
const enabled = new Set<string>();

export const secretsService: ServiceModule = {
  id: "secrets",
  async enable(project, log) {
    const { wrapped } = await newDataKey(requireMaster());
    await sql.begin(async (tx) => {
      const inserted = await tx`
        insert into mybase.secrets_projects (project, wrapped_key, master_id)
        values (${project}, ${Buffer.from(wrapped)}, ${Buffer.from(master!.id)})
        on conflict do nothing returning project`;
      if (inserted.length === 0) return;
      for (const name of DEFAULT_SECRETS_ENVS) await tx`insert into mybase.secrets_envs (project, name) values (${project}, ${name})`;
    });
    log.info("secrets enabled");
  },
  async disable(project, log) {
    // Cascades to envs, values, and history.
    await sql`delete from mybase.secrets_projects where project = ${project}`;
    enabled.delete(project);
    dataKeys.delete(project);
    log.info("secrets disabled");
  },
};

export async function requireEnabled(project: string) {
  requireMaster();
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.secrets_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("secrets are not enabled for this project");
  enabled.add(project);
}

/** Who made a change, for the history. Never a secret. */
export const actorOf = (auth: Auth) => (auth.kind === "session" ? "admin" : `key:${auth.tokenName}`);

// ---- environments -----------------------------------------------------------

interface EnvRow {
  id: string;
  name: string;
  parentId: string | null;
  parent: string | null;
  revision: number;
  keys: number;
  createdAt: Date;
  updatedAt: Date;
}

async function envRows(project: string): Promise<EnvRow[]> {
  return sql`
    select e.id::text, e.name, e.parent_id::text as "parentId", p.name as parent, e.revision, e.created_at as "createdAt", e.updated_at as "updatedAt",
      (select count(*) from mybase.secrets_values v where v.env_id = e.id)::int as keys
    from mybase.secrets_envs e left join mybase.secrets_envs p on p.id = e.parent_id
    where e.project = ${project}
    order by coalesce(p.name, e.name), e.parent_id nulls first, e.name`;
}

async function envRow(project: string, name: string): Promise<{ env: EnvRow; parent: EnvRow | null }> {
  const rows = await envRows(project);
  const env = rows.find((r) => r.name === name);
  if (!env) throw new NotFoundError(`no secrets environment named "${name}"`);
  return { env, parent: env.parentId ? (rows.find((r) => r.id === env.parentId) ?? null) : null };
}

export async function linkedEnvs(project: string): Promise<string[]> {
  const [row]: { linked: string[] }[] = await sql`select linked_envs as linked from mybase.secrets_projects where project = ${project}`;
  if (!row) throw new NotFoundError("secrets are not enabled for this project");
  return row.linked;
}

const toEnv = (row: EnvRow, linked: string[]): SecretsEnv => ({
  name: row.name,
  parent: row.parent,
  revision: row.revision,
  keys: row.keys,
  linked: linked.includes(row.name),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function overview(project: string, grant: Grant): Promise<SecretsOverview> {
  await requireEnabled(project);
  const [row]: { createdAt: Date; linked: string[] }[] = await sql`
    select created_at as "createdAt", linked_envs as linked from mybase.secrets_projects where project = ${project}`;
  const envs = (await envRows(project)).filter((e) => canSeeEnv(grant, e.name)).map((e) => toEnv(e, row!.linked));
  return { envs, apiUrl: publicApiUrl, enabledAt: row!.createdAt.toISOString() };
}

function readEnvName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || !SECRETS_ENV_PATTERN.test(value)) throw new BadRequestError(`${field} must be ${SECRETS_ENV_RULES}`);
  return value;
}

const isUniqueViolation = (err: unknown) => (err as { errno?: string }).errno === "23505";

export async function createEnv(project: string, body: Record<string, unknown>, grant: Grant, log: Logger): Promise<SecretsEnv> {
  await requireEnabled(project);
  requireAllEnvs(grant);
  const name = readEnvName(body.name);
  const rows = await envRows(project);
  if (rows.length >= SECRETS_LIMITS.envsPerProject) throw new ConflictError(`a project can have up to ${SECRETS_LIMITS.envsPerProject} environments`);
  let parentId: string | null = null;
  if (body.parent !== undefined && body.parent !== null) {
    const parentName = readEnvName(body.parent, "parent");
    const parent = rows.find((r) => r.name === parentName);
    if (!parent) throw new NotFoundError(`no secrets environment named "${parentName}"`);
    if (parent.parentId) throw new BadRequestError(`"${parentName}" is a branch env; branch from its root, "${parent.parent}"`);
    parentId = parent.id;
  }
  try {
    await sql`insert into mybase.secrets_envs (project, name, parent_id) values (${project}, ${name}, ${parentId})`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`an environment named "${name}" already exists`);
    throw err;
  }
  log.info("secrets env created", { env: name, branch: parentId !== null });
  const { env } = await envRow(project, name);
  return toEnv(env, await linkedEnvs(project));
}

export async function renameEnv(project: string, name: string, body: Record<string, unknown>, grant: Grant, log: Logger): Promise<SecretsEnv> {
  await requireEnabled(project);
  requireAllEnvs(grant);
  const next = readEnvName(body.name);
  await envRow(project, name);
  try {
    await sql.begin(async (tx) => {
      await tx`update mybase.secrets_envs set name = ${next}, updated_at = now() where project = ${project} and name = ${name}`;
      await tx`update mybase.secrets_projects set linked_envs = array_replace(linked_envs, ${name}, ${next}) where project = ${project}`;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`an environment named "${next}" already exists`);
    throw err;
  }
  log.info("secrets env renamed", { env: name, to: next });
  const { env } = await envRow(project, next);
  return toEnv(env, await linkedEnvs(project));
}

/** Deletes the env with its history, and its branch envs. */
export async function deleteEnv(project: string, name: string, grant: Grant, log: Logger) {
  await requireEnabled(project);
  requireAllEnvs(grant);
  const { env } = await envRow(project, name);
  const gone = (await envRows(project)).filter((r) => r.id === env.id || r.parentId === env.id).map((r) => r.name);
  await sql.begin(async (tx) => {
    await tx`delete from mybase.secrets_envs where id = ${env.id}`;
    const linked = (await linkedEnvs(project)).filter((n) => !gone.includes(n));
    await tx`update mybase.secrets_projects set linked_envs = ${sql.array(linked, "text")} where project = ${project}`;
  });
  log.info("secrets env deleted", { env: name, branches: gone.length - 1 });
}

// ---- values -----------------------------------------------------------------

interface ValueRow {
  key: string;
  value: Uint8Array;
  managed: boolean;
  updatedAt: Date;
}

async function ownValues(envId: string): Promise<Map<string, ValueRow>> {
  const rows: ValueRow[] = await sql`
    select key, value, managed, updated_at as "updatedAt" from mybase.secrets_values where env_id = ${envId}`;
  return new Map(rows.map((r) => [r.key, r]));
}

/** An env's keys with branch overrides applied, still encrypted. `envId` on each says whose row it is (for decryption). */
async function resolvedRows(env: EnvRow, parent: EnvRow | null) {
  const tag = (id: string) => async () => new Map([...(await ownValues(id))].map(([k, r]) => [k, { ...r, envId: id }]));
  const [own, inherited] = await Promise.all([tag(env.id)(), parent ? tag(parent.id)() : null]);
  return overlay(inherited, own);
}

export async function getEnv(project: string, name: string, grant: Grant, withValues: boolean): Promise<SecretsEnvDetail> {
  await requireEnabled(project);
  requireEnv(grant, name);
  const { env, parent } = await envRow(project, name);
  const rows = await resolvedRows(env, parent);
  const key = withValues ? await dataKey(project) : null;
  const secrets: SecretEntry[] = await Promise.all(
    [...rows.values()].map(async (r) => ({
      key: r.key,
      ...(key ? { value: await decryptValue(key, project, r.envId, r.key, r.value) } : {}),
      managed: r.managed,
      inherited: r.inherited,
      updatedAt: r.updatedAt.toISOString(),
    })),
  );
  return { env: toEnv(env, await linkedEnvs(project)), secrets };
}

/** Changes whenever the env or its parent changes. */
const versionOf = (env: EnvRow, parent: EnvRow | null) => `${env.id}.${env.revision}.${parent ? `${parent.id}.${parent.revision}` : "0"}`;

/**
 * Every value, resolved (`GET /secrets/:project/:env`). Null when `ifNoneMatch` names the
 * current version, so polling SDKs cost one small query and no decryption.
 */
export async function resolve(project: string, name: string, grant: Grant, ifNoneMatch: string | null): Promise<{ etag: string; body: SecretsResponse | null }> {
  requireEnv(grant, name);
  const { env, parent } = await envRow(project, name);
  const version = versionOf(env, parent);
  const etag = `"${version}"`;
  if (ifNoneMatch === etag) return { etag, body: null };
  const key = await dataKey(project);
  const secrets: Record<string, string> = {};
  for (const r of (await resolvedRows(env, parent)).values()) secrets[r.key] = await decryptValue(key, project, r.envId, r.key, r.value);
  return { etag, body: { env: name, version, secrets } };
}

export async function getValue(project: string, name: string, key: string, grant: Grant): Promise<{ value: string }> {
  requireEnv(grant, name);
  const { env, parent } = await envRow(project, name);
  const row = (await resolvedRows(env, parent)).get(key);
  if (!row) throw new NotFoundError(`no secret named "${key}" in "${name}"`);
  return { value: await decryptValue(await dataKey(project), project, row.envId, key, row.value) };
}

// ---- writing ----------------------------------------------------------------

interface Change {
  key: string;
  /** Ciphertext, or null to remove the key. */
  value: Uint8Array | null;
  managed: boolean;
}

type Current = Map<string, { value: Uint8Array; managed: boolean }>;

/**
 * Applies changes to one env as one revision. `build` sees the env's current rows (locked)
 * and returns only real changes. Prunes revisions past the kept count.
 */
async function commit(
  project: string,
  name: string,
  build: (envId: string, current: Current, revision: number) => Promise<Change[]>,
  actor: string,
  message: string | null,
): Promise<UpdateSecretsResponse> {
  return sql.begin(async (tx) => {
    const [env]: { id: string; revision: number }[] = await tx`
      select id::text, revision from mybase.secrets_envs where project = ${project} and name = ${name} for update`;
    if (!env) throw new NotFoundError(`no secrets environment named "${name}"`);
    const rows: { key: string; value: Uint8Array; managed: boolean }[] = await tx`
      select key, value, managed from mybase.secrets_values where env_id = ${env.id}`;
    const current: Current = new Map(rows.map((r) => [r.key, r]));
    const changes = await build(env.id, current, env.revision);
    if (changes.length === 0) return { revision: env.revision, changed: 0 };

    const after = new Set(current.keys());
    for (const c of changes) c.value ? after.add(c.key) : after.delete(c.key);
    if (after.size > SECRETS_LIMITS.keysPerEnv) throw new ConflictError(`an environment can hold up to ${SECRETS_LIMITS.keysPerEnv} keys`);

    const revision = env.revision + 1;
    await tx`update mybase.secrets_envs set revision = ${revision}, updated_at = now() where id = ${env.id}`;
    await tx`insert into mybase.secrets_revisions (env_id, revision, actor, message) values (${env.id}, ${revision}, ${actor}, ${message})`;
    const bytes = (v: Uint8Array | null | undefined) => (v ? Buffer.from(v) : null);
    await tx`insert into mybase.secrets_changes ${tx(
      changes.map((c) => ({
        env_id: env.id,
        revision,
        key: c.key,
        old_value: bytes(current.get(c.key)?.value),
        new_value: bytes(c.value),
        managed: c.managed,
      })),
    )}`;
    for (const c of changes) {
      if (c.value) {
        await tx`
          insert into mybase.secrets_values (env_id, key, value, managed) values (${env.id}, ${c.key}, ${Buffer.from(c.value)}, ${c.managed})
          on conflict (env_id, key) do update set value = excluded.value, managed = excluded.managed, updated_at = now()`;
      } else {
        await tx`delete from mybase.secrets_values where env_id = ${env.id} and key = ${c.key}`;
      }
    }
    await tx`delete from mybase.secrets_revisions where env_id = ${env.id} and revision <= ${revision - SECRETS_LIMITS.revisionsKept}`;
    return { revision, changed: changes.length };
  });
}

function readKey(key: unknown): string {
  if (typeof key !== "string" || !SECRET_KEY_PATTERN.test(key)) throw new BadRequestError(`invalid key ${JSON.stringify(key)}: ${SECRET_KEY_RULES}`);
  return key;
}

function readMessage(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > SECRETS_LIMITS.messageLength) {
    throw new BadRequestError(`message must be a string of up to ${SECRETS_LIMITS.messageLength} characters`);
  }
  return value;
}

/** `{ set, unset }` from a request body, validated. */
function readUpdate(body: Record<string, unknown>): { set: Map<string, string>; unset: Set<string> } {
  const set = new Map<string, string>();
  if (body.set !== undefined) {
    if (typeof body.set !== "object" || body.set === null || Array.isArray(body.set)) throw new BadRequestError("set must map keys to string values");
    for (const [k, v] of Object.entries(body.set)) {
      if (typeof v !== "string") throw new BadRequestError(`the value of ${readKey(k)} must be a string`);
      if (Buffer.byteLength(v) > SECRETS_LIMITS.valueBytes) throw new BadRequestError(`the value of ${k} is over ${SECRETS_LIMITS.valueBytes / 1024} KB`);
      set.set(readKey(k), v);
    }
  }
  const unset = new Set<string>();
  if (body.unset !== undefined) {
    if (!Array.isArray(body.unset)) throw new BadRequestError("unset must be a list of keys");
    for (const k of body.unset) unset.add(readKey(k));
  }
  for (const k of unset) if (set.has(k)) throw new BadRequestError(`${k} is in both set and unset`);
  if (set.size === 0 && unset.size === 0) throw new BadRequestError("nothing to change: send set and/or unset");
  if (set.size + unset.size > SECRETS_LIMITS.keysPerEnv) throw new BadRequestError(`up to ${SECRETS_LIMITS.keysPerEnv} keys per change`);
  return { set, unset };
}

/**
 * Sets and removes keys in one revision. `managed: "protect"` (people, apps) refuses to touch
 * keys `link` wrote; `"write"` (link itself) writes them as managed and may remove them.
 */
async function writeValues(
  project: string,
  name: string,
  set: Map<string, string>,
  unset: Set<string>,
  opts: { managed: "protect" | "write"; actor: string; message: string | null },
): Promise<UpdateSecretsResponse> {
  const key = await dataKey(project);
  const managed = opts.managed === "write";
  const protect = (k: string, current: Current) => {
    if (!managed && current.get(k)?.managed) {
      throw new ConflictError(`${k} holds the project's credentials (mybase secrets link): link again to rotate it, or unlink the env first`);
    }
  };
  return commit(
    project,
    name,
    async (envId, current) => {
      const changes: Change[] = [];
      for (const [k, v] of set) {
        protect(k, current);
        const cur = current.get(k);
        if (cur && cur.managed === managed && (await decryptValue(key, project, envId, k, cur.value)) === v) continue;
        changes.push({ key: k, value: await encryptValue(key, project, envId, k, v), managed });
      }
      for (const k of unset) {
        if (!current.has(k)) continue;
        protect(k, current);
        changes.push({ key: k, value: null, managed });
      }
      return changes;
    },
    opts.actor,
    opts.message,
  );
}

export async function updateSecrets(project: string, name: string, body: Record<string, unknown>, auth: Auth, log: Logger): Promise<UpdateSecretsResponse> {
  await requireEnabled(project);
  requireEnv(auth, name);
  const { set, unset } = readUpdate(body);
  const result = await writeValues(project, name, set, unset, { managed: "protect", actor: actorOf(auth), message: readMessage(body.message) });
  if (result.changed > 0) log.info("secrets changed", { env: name, revision: result.revision, changed: result.changed });
  return result;
}

/** For `link`: writes `values` as the env's managed keys. With `prune`, removes managed keys not in it. */
export async function writeManaged(project: string, name: string, values: Record<string, string>, prune: boolean, message: string, log: Logger) {
  const set = new Map(Object.entries(values));
  const { env } = await envRow(project, name);
  const stale = new Set(prune ? [...(await ownValues(env.id)).values()].filter((r) => r.managed && !set.has(r.key)).map((r) => r.key) : []);
  const result = await writeValues(project, name, set, stale, { managed: "write", actor: "link", message });
  log.info("secrets credentials written", { env: name, revision: result.revision, changed: result.changed });
  return result;
}

// ---- history ----------------------------------------------------------------

async function storedChanges(envId: string, revisions: number[] | { after: number }): Promise<StoredChange[]> {
  return Array.isArray(revisions)
    ? sql`
        select revision, key, old_value as "oldValue", new_value as "newValue", managed
        from mybase.secrets_changes where env_id = ${envId} and revision in ${sql(revisions)} order by revision desc, key`
    : sql`
        select revision, key, old_value as "oldValue", new_value as "newValue", managed
        from mybase.secrets_changes where env_id = ${envId} and revision > ${revisions.after}`;
}

async function toChanges(project: string, envId: string, changes: StoredChange[], withValues: boolean): Promise<SecretChange[]> {
  const key = withValues ? await dataKey(project) : null;
  return Promise.all(
    changes.map(async (c) => ({
      key: c.key,
      action: c.oldValue === null ? "added" : c.newValue === null ? "removed" : "changed",
      managed: c.managed,
      ...(key
        ? {
            oldValue: c.oldValue && (await decryptValue(key, project, envId, c.key, c.oldValue)),
            newValue: c.newValue && (await decryptValue(key, project, envId, c.key, c.newValue)),
          }
        : {}),
    })),
  );
}

export async function listRevisions(project: string, name: string, grant: Grant, limit: number, before: number | null): Promise<SecretsRevision[]> {
  await requireEnabled(project);
  requireEnv(grant, name);
  const { env } = await envRow(project, name);
  const rows: { revision: number; actor: string; message: string | null; createdAt: Date }[] = await sql`
    select revision, actor, message, created_at as "createdAt" from mybase.secrets_revisions
    where env_id = ${env.id} and revision < ${before ?? env.revision + 1}
    order by revision desc limit ${limit}`;
  if (rows.length === 0) return [];
  const changes = await storedChanges(env.id, rows.map((r) => r.revision));
  return Promise.all(
    rows.map(async (r) => ({
      revision: r.revision,
      actor: r.actor,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
      changes: await toChanges(project, env.id, changes.filter((c) => c.revision === r.revision), false),
    })),
  );
}

export async function getRevision(project: string, name: string, revision: number, grant: Grant, withValues: boolean): Promise<SecretsRevision> {
  await requireEnabled(project);
  requireEnv(grant, name);
  const { env } = await envRow(project, name);
  const [row]: { revision: number; actor: string; message: string | null; createdAt: Date }[] = await sql`
    select revision, actor, message, created_at as "createdAt" from mybase.secrets_revisions where env_id = ${env.id} and revision = ${revision}`;
  if (!row) throw new NotFoundError(`no revision ${revision} in "${name}" (the last ${SECRETS_LIMITS.revisionsKept} are kept)`);
  return {
    revision: row.revision,
    actor: row.actor,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    changes: await toChanges(project, env.id, await storedChanges(env.id, [revision]), withValues),
  };
}

/**
 * Puts the env's values back as they were after `revision`, as a new revision. Keys that
 * `link` manages are left alone (credentials are never rolled back).
 */
export async function restoreRevision(project: string, name: string, revision: number, auth: Auth, log: Logger): Promise<UpdateSecretsResponse> {
  await requireEnabled(project);
  requireEnv(auth, name);
  const result = await commit(
    project,
    name,
    async (envId, current, latest) => {
      if (revision < 0 || revision > latest) throw new NotFoundError(`no revision ${revision} in "${name}"`);
      if (revision === latest) return [];
      const [{ oldest }]: { oldest: number | null }[] = await sql`
        select min(revision)::int as oldest from mybase.secrets_revisions where env_id = ${envId}`;
      if (oldest === null || oldest > revision + 1) {
        throw new ConflictError(`revision ${revision} is too old to restore: only the last ${SECRETS_LIMITS.revisionsKept} revisions are kept`);
      }
      const { target, skipped } = rewind(new Map([...current].map(([k, r]) => [k, r.value])), await storedChanges(envId, { after: revision }));
      const changes: Change[] = [];
      for (const k of new Set([...current.keys(), ...target.keys()])) {
        const cur = current.get(k);
        if (skipped.has(k) || cur?.managed) continue;
        const want = target.get(k) ?? null;
        if (want === null && cur) changes.push({ key: k, value: null, managed: false });
        else if (want !== null && (!cur || !sameBytes(cur.value, want))) changes.push({ key: k, value: want, managed: false });
      }
      return changes;
    },
    actorOf(auth),
    `restored revision ${revision}`,
  );
  log.info("secrets restored", { env: name, from: revision, revision: result.revision, changed: result.changed });
  return result;
}

// ---- agents -----------------------------------------------------------------

/** Env and key names for `projectContext`; never values. */
export async function secretsContext(project: string, grant: Grant): Promise<NonNullable<ProjectContext["secrets"]>> {
  const [rows, linked] = await Promise.all([envRows(project), linkedEnvs(project)]);
  const keyRows: { envId: string; key: string }[] = await sql`
    select v.env_id::text as "envId", v.key from mybase.secrets_values v join mybase.secrets_envs e on e.id = v.env_id
    where e.project = ${project} order by v.key`;
  const keysOf = (id: string | null) => keyRows.filter((r) => r.envId === id).map((r) => r.key);
  return {
    envs: rows
      .filter((e) => canSeeEnv(grant, e.name))
      .map((e) => ({
        name: e.name,
        parent: e.parent,
        keys: [...new Set([...keysOf(e.parentId), ...keysOf(e.id)])].sort(),
        linked: linked.includes(e.name),
      })),
  };
}

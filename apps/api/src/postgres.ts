// Provisions per-project databases on the shared Postgres server.
//
// Until the control-plane metadata store is decided (see CLAUDE.md), Postgres
// itself is the registry: a project is a database tagged with a mybase comment.
// That keeps projects across restarts without committing to a store.
import { SQL } from "bun";
import type { Logger } from "@mybase/shared/logger";
import { bucketName, type DatabaseCredentials, type DatabaseInfo, type ServiceId } from "@mybase/shared";
import { ProjectExistsError } from "./errors";

const env = process.env;
const host = env.POSTGRES_HOST ?? "localhost";
const port = Number(env.POSTGRES_PORT ?? 5432);

/** Where the API itself reaches Postgres (the WebSocket proxy connects here too). */
export const pgAddress = { host, port };

/** A superuser connection pool to one database on the shared server. */
export const connect = (database: string, max: number, idleTimeout?: number) =>
  new SQL({
    hostname: host,
    port,
    username: env.POSTGRES_USER ?? "mybase",
    password: env.POSTGRES_PASSWORD ?? "change-me",
    database,
    max,
    idleTimeout,
  });

export const sql = connect("postgres", 4);

// Where apps reach Postgres, which differs from the API's view inside Docker.
const publicHost = env.MYBASE_DB_PUBLIC_HOST ?? "localhost";
const publicPort = Number(env.MYBASE_DB_PUBLIC_PORT ?? port);
// The WebSocket proxy (db-proxy.ts) is served by this API, so it follows the API's public URL.
const wsUrl = env.MYBASE_DB_WS_URL || `${(env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/^http/, "ws").replace(/\/$/, "")}/db`;

// SQLSTATEs for duplicate_object (role) and duplicate_database.
const DUPLICATE = new Set(["42710", "42P04"]);
const isDuplicate = (err: unknown) => DUPLICATE.has((err as { errno?: string }).errno ?? "");

/** Waits for Postgres to accept connections, so the API can start before it in Compose. */
export async function waitForPostgres(log: Logger, attempts = 30) {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`select 1`;
      log.info("postgres connected", { host, port });
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      log.warn("postgres not ready, retrying", { host, port, attempt, err: (err as Error).message });
      await Bun.sleep(2000);
    }
  }
}

/** A registered project as Postgres knows it; projects.ts adds the storage details. */
export interface ProjectRecord {
  name: string;
  createdAt: string;
  database: DatabaseInfo;
  hasStorage: boolean;
  services: ServiceId[];
}

/** What a project database's comment holds (see listProjects). */
interface ProjectMeta {
  createdAt: string;
  storage?: { bucket: string };
  services?: ServiceId[];
}

// Single quotes doubled: the comment is a string literal, and identifiers can't be bound.
const commentSql = (name: string, meta: ProjectMeta) =>
  `comment on database "${name}" is '${JSON.stringify({ mybase: meta }).replaceAll("'", "''")}'`;

const databaseInfo = (name: string): DatabaseInfo => ({ host: publicHost, port: publicPort, name, user: name, wsUrl });

export async function listProjects(): Promise<ProjectRecord[]> {
  const rows: { name: string; comment: string }[] = await sql`
    select d.datname as name, shobj_description(d.oid, 'pg_database') as comment
    from pg_database d
    where shobj_description(d.oid, 'pg_database') like '{"mybase":%'
    order by d.datname`;
  return rows.map(({ name, comment }) => {
    const meta: ProjectMeta = JSON.parse(comment).mybase;
    return { name, createdAt: meta.createdAt, database: databaseInfo(name), hasStorage: Boolean(meta.storage), services: meta.services ?? [] };
  });
}

/** Rewrites a project's registry entry. `name` must already match PROJECT_NAME_PATTERN. */
export async function updateProjectMeta(name: string, update: (meta: ProjectMeta) => ProjectMeta) {
  const [row]: { comment: string | null }[] = await sql`
    select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${name}`;
  if (!row?.comment?.startsWith('{"mybase":')) return false;
  await sql.unsafe(commentSql(name, update(JSON.parse(row.comment).mybase)));
  return true;
}

/** Whether a mybase project database with this name exists. */
export async function projectExists(name: string): Promise<boolean> {
  const rows = await sql`
    select 1 from pg_database
    where datname = ${name} and shobj_description(oid, 'pg_database') like '{"mybase":%'`;
  return rows.length > 0;
}

/**
 * Creates a login role and a database it owns, both named after the project.
 * The database comment registers it as a project (see listProjects).
 * `name` must already match PROJECT_NAME_PATTERN: identifiers can't be bound as
 * parameters, so the pattern is what makes the interpolation below safe.
 */
export async function createDatabase(name: string, log: Logger): Promise<{ project: ProjectRecord; credentials: DatabaseCredentials }> {
  // Hex only, so it's safe inside the quoted literal below.
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const createdAt = new Date().toISOString();
  const ident = `"${name}"`;
  // Registers the bucket too. It's created right after; if that fails the caller drops this database.
  const storage = { bucket: bucketName(name) };

  try {
    await sql.unsafe(`create role ${ident} login password '${password}'`);
  } catch (err) {
    if (isDuplicate(err)) throw new ProjectExistsError(`project "${name}" already exists`);
    throw err;
  }

  // CREATE DATABASE can't run inside a transaction, so undo by hand on failure.
  // Only drop what this call created: a duplicate name means the database belongs to someone else.
  let createdDatabase = false;
  try {
    await sql.unsafe(`create database ${ident} owner ${ident}`);
    createdDatabase = true;
    await sql.unsafe(`revoke all on database ${ident} from public`);
    await sql.unsafe(commentSql(name, { createdAt, storage, services: [] }));
  } catch (err) {
    if (createdDatabase) {
      await sql.unsafe(`drop database ${ident}`).catch((dropErr) => log.error("database cleanup failed", { database: name, err: dropErr }));
    }
    await sql.unsafe(`drop role ${ident}`).catch((dropErr) => log.error("role cleanup failed", { role: name, err: dropErr }));
    if (isDuplicate(err)) throw new ProjectExistsError(`project "${name}" already exists`);
    throw err;
  }

  const credentials: DatabaseCredentials = {
    host: publicHost,
    port: publicPort,
    database: name,
    user: name,
    password,
    url: `postgres://${name}:${password}@${publicHost}:${publicPort}/${name}`,
  };
  return { project: { name, createdAt, database: databaseInfo(name), hasStorage: true, services: [] }, credentials };
}

/**
 * Drops the project's database and role, disconnecting anyone still using it.
 * Each step tolerates the object already being gone, so a partial delete can be retried.
 * `name` must already match PROJECT_NAME_PATTERN (see createDatabase).
 */
export async function dropDatabase(name: string, log: Logger) {
  const ident = `"${name}"`;
  // FORCE terminates open connections (Postgres 13+).
  await sql.unsafe(`drop database if exists ${ident} with (force)`);
  await sql.unsafe(`drop role if exists ${ident}`);
  log.info("database dropped", { database: name });
}

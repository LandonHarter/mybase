// Provisions per-project databases on the shared Postgres server.
//
// Until the control-plane metadata store is decided (see CLAUDE.md), Postgres
// itself is the registry: a project is a database tagged with a mybase comment.
// That keeps projects across restarts without committing to a store.
import { SQL } from "bun";
import type { Logger } from "@mybase/shared/logger";
import type { Project, ProjectCredentials } from "@mybase/shared";

const env = process.env;
const host = env.POSTGRES_HOST ?? "localhost";
const port = Number(env.POSTGRES_PORT ?? 5432);

const sql = new SQL({
  hostname: host,
  port,
  username: env.POSTGRES_USER ?? "mybase",
  password: env.POSTGRES_PASSWORD ?? "change-me",
  database: "postgres",
  max: 4,
});

// Where apps reach Postgres, which differs from the API's view inside Docker.
const publicHost = env.MYBASE_DB_PUBLIC_HOST ?? "localhost";
const publicPort = Number(env.MYBASE_DB_PUBLIC_PORT ?? port);

/** Thrown when a database or role with the project's name already exists. */
export class ProjectExistsError extends Error {}

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

export async function listProjects(): Promise<Project[]> {
  const rows: { name: string; comment: string }[] = await sql`
    select d.datname as name, shobj_description(d.oid, 'pg_database') as comment
    from pg_database d
    where shobj_description(d.oid, 'pg_database') like '{"mybase":%'
    order by d.datname`;
  return rows.map(({ name, comment }) => ({
    name,
    createdAt: JSON.parse(comment).mybase.createdAt,
    database: { name, user: name },
  }));
}

/**
 * Creates a login role and a database it owns, both named after the project.
 * `name` must already match PROJECT_NAME_PATTERN: identifiers can't be bound as
 * parameters, so the pattern is what makes the interpolation below safe.
 */
export async function createProject(name: string, log: Logger): Promise<{ project: Project; credentials: ProjectCredentials }> {
  // Hex only, so it's safe inside the quoted literal below.
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const createdAt = new Date().toISOString();
  const ident = `"${name}"`;

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
    await sql.unsafe(`comment on database ${ident} is '${JSON.stringify({ mybase: { createdAt } })}'`);
  } catch (err) {
    if (createdDatabase) {
      await sql.unsafe(`drop database ${ident}`).catch((dropErr) => log.error("database cleanup failed", { database: name, err: dropErr }));
    }
    await sql.unsafe(`drop role ${ident}`).catch((dropErr) => log.error("role cleanup failed", { role: name, err: dropErr }));
    if (isDuplicate(err)) throw new ProjectExistsError(`project "${name}" already exists`);
    throw err;
  }

  const credentials: ProjectCredentials = {
    host: publicHost,
    port: publicPort,
    database: name,
    user: name,
    password,
    url: `postgres://${name}:${password}@${publicHost}:${publicPort}/${name}`,
  };
  return { project: { name, createdAt, database: { name, user: name } }, credentials };
}

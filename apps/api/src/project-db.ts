// Connections into each project's own database, for the dashboard's database tools.
// The registry and role/database DDL use the shared `postgres` database (postgres.ts);
// anything inside a project's database (catalog, extensions, rows) goes through here.
//
// Two kinds of pool per project:
//  - `projectSql`: superuser. Catalog reads and DDL on objects mybase owns only. Never touch
//    anything the project role owns or can replace (its tables, views, functions, triggers):
//    that code would run as superuser.
//  - `internalSql` / `asProject`: logged in as `mybase-as-<project>`, an unprivileged role that
//    may `SET ROLE` to the project (but doesn't inherit its rights). `RESET ROLE` in project
//    code only gets back to that role, never to superuser.
import type { SQL, TransactionSQL } from "bun";
import { ConflictError, QueryFailedError } from "./errors";
import { connect, connectAs, sql } from "./postgres";

// Opened on first use, small and idle-closing so unused projects hold no connections.
const pools = new Map<string, SQL>();
const internalPools = new Map<string, Promise<SQL>>();

// The internal roles' password: random per boot, never stored. Hex, so it's safe in a literal.
const internalPassword = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");

/** The internal login role for a project. `-` can't appear in project names, so it never collides with one. */
export const internalRole = (name: string) => `mybase-as-${name}`;

/** A superuser pool on the project's database. `name` must already match PROJECT_NAME_PATTERN. */
export function projectSql(name: string): SQL {
  let pool = pools.get(name);
  if (!pool) {
    pool = connect(name, 2, 30);
    pools.set(name, pool);
  }
  return pool;
}

/** Creates (or resets) the internal role: no attributes, member of the project without inheriting it. */
async function ensureInternalRole(name: string) {
  const role = quoteIdent(internalRole(name));
  await sql.unsafe(`
    do $$ begin
      if not exists (select from pg_roles where rolname = '${internalRole(name)}') then create role ${role}; end if;
    end $$;
    alter role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 6 password '${internalPassword}';
    grant ${quoteIdent(name)} to ${role};
    grant connect on database ${quoteIdent(name)} to ${role};`);
}

/**
 * A pool on the project's database as its internal role. Use `asProject` to act as the project;
 * without it, queries run with only what the internal role was granted (vector indexes).
 */
export function internalSql(name: string): Promise<SQL> {
  let pool = internalPools.get(name);
  if (!pool) {
    pool = ensureInternalRole(name).then(() => connectAs(name, internalRole(name), internalPassword, 2, 30));
    pool.catch(() => internalPools.delete(name));
    internalPools.set(name, pool);
  }
  return pool;
}

/** Call before dropping the database, so the pools don't hold (or reopen) connections to it. */
export async function closeProjectSql(name: string) {
  const pool = pools.get(name);
  pools.delete(name);
  const internal = internalPools.get(name);
  internalPools.delete(name);
  await pool?.close({ timeout: 0 });
  await (await internal?.catch(() => null))?.close({ timeout: 0 });
}

/**
 * The owner of `schema` in the project's database (null when it doesn't exist), and whether it's
 * a superuser. Services check this before putting their objects in a schema: one the project made
 * first would let it swap them for its own (a trigger there would run as whoever writes).
 */
export async function schemaOwner(name: string, schema: string): Promise<{ owner: string; superuser: boolean } | null> {
  const [row]: { owner: string; superuser: boolean }[] = await projectSql(name)`
    select r.rolname as owner, r.rolsuper as superuser from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = ${schema}`;
  return row ?? null;
}

/** Throws unless `schema` is missing or belongs to a superuser (or `allowed`). */
export async function requireOwnSchema(name: string, schema: string, allowed?: string) {
  const owner = await schemaOwner(name, schema);
  if (owner && !owner.superuser && owner.owner !== allowed) {
    throw new ConflictError(`schema "${schema}" already exists in this database and belongs to "${owner.owner}"; mybase needs it for itself. Drop or rename it first`);
  }
}

/** Quotes a Postgres identifier. Still check names against the catalog before interpolating. */
export const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

/**
 * Runs `fn` in a transaction as the project's role, with a statement timeout, so user
 * queries and row edits get the project's privileges. The session belongs to the internal
 * role, so project code that runs `RESET ROLE` gains nothing.
 */
export async function asProject<T>(name: string, fn: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  return (await internalSql(name)).begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(name)}; set local statement_timeout = '15s'`);
    return fn(tx);
  });
}

interface PostgresError {
  name: string;
  message: string;
  errno?: string;
  position?: string;
  detail?: string;
  hint?: string;
}

const isPostgresError = (err: unknown): err is PostgresError => (err as { name?: string }).name === "PostgresError";

/** SQLSTATE of a Postgres error, if `err` is one. */
export const sqlState = (err: unknown) => (isPostgresError(err) ? err.errno : undefined);

/** Turns Postgres rejecting user input into a QueryFailedError (a 400); rethrows anything else. */
export function userError(err: unknown): never {
  // Connection failures have no SQLSTATE: those are ours, not the user's.
  if (!isPostgresError(err) || !err.errno) throw err;
  throw new QueryFailedError(err.message, err.position ? Number(err.position) : undefined, err.detail || undefined, err.hint || undefined);
}

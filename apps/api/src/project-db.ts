// Connections into each project's own database, for the dashboard's database tools.
// The registry and role/database DDL use the shared `postgres` database (postgres.ts);
// anything inside a project's database (catalog, extensions, rows) goes through here.
import type { SQL, TransactionSQL } from "bun";
import { QueryFailedError } from "./errors";
import { connect } from "./postgres";

// Opened on first use, small and idle-closing so unused projects hold no connections.
const pools = new Map<string, SQL>();

/** A superuser pool on the project's database. `name` must already match PROJECT_NAME_PATTERN. */
export function projectSql(name: string): SQL {
  let pool = pools.get(name);
  if (!pool) {
    pool = connect(name, 2, 30);
    pools.set(name, pool);
  }
  return pool;
}

/** Call before dropping the database, so the pool doesn't hold (or reopen) connections to it. */
export async function closeProjectSql(name: string) {
  const pool = pools.get(name);
  if (!pool) return;
  pools.delete(name);
  await pool.close({ timeout: 0 });
}

/** Quotes a Postgres identifier. Still check names against the catalog before interpolating. */
export const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

/**
 * Runs `fn` in a transaction as the project's role, with a statement timeout, so user
 * queries and row edits get the project's privileges instead of superuser. This guards
 * against accidents, not attackers: SQL can `RESET ROLE`. Revisit when platform auth lands.
 */
export function asProject<T>(name: string, fn: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  return projectSql(name).begin(async (tx) => {
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

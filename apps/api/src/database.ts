// The database page's settings: live stats, the connection limit, and extensions.
// `name` must already match PROJECT_NAME_PATTERN everywhere below.
import type { DatabaseDetails, Extension } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { ConflictError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { projectSql, quoteIdent, sqlState } from "./project-db";

/** Relations the user made: not system schemas, not owned by an extension (e.g. PostGIS' spatial_ref_sys). */
export const USER_RELATION = `
  n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`;

export async function databaseDetails(name: string): Promise<DatabaseDetails> {
  const [[server], [inside]] = await Promise.all([
    sql`
      select pg_database_size(${name})::float8 as size,
        -- The API's own pools connect as the admin user; count only the app's connections.
        (select count(*) from pg_stat_activity where datname = ${name} and usename <> current_user)::int as active,
        (select rolconnlimit from pg_roles where rolname = ${name}) as "limit"`,
    projectSql(name).unsafe(`
      select count(*)::int as tables
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${USER_RELATION}`),
  ]);
  return {
    sizeBytes: server.size,
    tables: inside.tables,
    activeConnections: server.active,
    connectionLimit: server.limit < 0 ? null : server.limit,
  };
}

/** `limit` is null (no limit) or an integer the caller already range-checked. */
export async function setConnectionLimit(name: string, limit: number | null, log: Logger) {
  await sql.unsafe(`alter role ${quoteIdent(name)} connection limit ${limit ?? -1}`);
  log.info("connection limit set", { limit: limit ?? "none" });
}

export async function listExtensions(name: string): Promise<Extension[]> {
  const rows: { name: string; description: string | null; default_version: string; installed_version: string | null }[] = await projectSql(name)`
    select name, comment as description, default_version, installed_version
    from pg_available_extensions order by name`;
  return rows.map((r) => ({
    name: r.name,
    description: r.description ?? "",
    defaultVersion: r.default_version,
    installedVersion: r.installed_version,
  }));
}

async function checkAvailable(name: string, extension: string) {
  const rows = await projectSql(name)`select 1 from pg_available_extensions where name = ${extension}`;
  if (rows.length === 0) throw new NotFoundError(`extension "${extension}" isn't available on this server`);
}

/** Runs as superuser: many extensions can't be created by an ordinary role. CASCADE pulls in what it needs. */
export async function enableExtension(name: string, extension: string, log: Logger) {
  await checkAvailable(name, extension);
  await projectSql(name).unsafe(`create extension if not exists ${quoteIdent(extension)} cascade`);
  log.info("extension enabled", { extension });
}

/** No CASCADE: dropping an extension that tables still use is refused, never silently destructive. */
export async function disableExtension(name: string, extension: string, log: Logger) {
  await checkAvailable(name, extension);
  try {
    await projectSql(name).unsafe(`drop extension if exists ${quoteIdent(extension)}`);
  } catch (err) {
    // dependent_objects_still_exist: Postgres' detail names what depends on it.
    if (sqlState(err) === "2BP01") {
      const { message, detail } = err as { message: string; detail?: string };
      throw new ConflictError(detail ? `${message}: ${detail.replaceAll("\n", "; ")}` : message);
    }
    throw err;
  }
  log.info("extension disabled", { extension });
}

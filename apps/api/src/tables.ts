// The database page's table editor and SQL editor. Reads of user data, row edits,
// and user SQL all run as the project's role (asProject), never as superuser.
// `name` must already match PROJECT_NAME_PATTERN everywhere below.
import type { Column, QueryResult, RowValues, SchemaTable, TableRows, TableSummary } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { USER_RELATION } from "./database";
import { asProject, projectSql, quoteIdent, userError } from "./project-db";

const KINDS: Record<string, TableSummary["kind"]> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

/** Above this many estimated rows, counting exactly is too slow for a page load. */
const EXACT_COUNT_LIMIT = 10_000;
/** Most rows one SQL editor statement returns to the dashboard. */
const MAX_RESULT_ROWS = 1000;

/**
 * A query result from Bun's Postgres client: the rows, plus the command tag and affected count.
 * `begin()` drops those extra fields from what its callback returns, so read them inside it.
 */
type BunResult = Record<string, unknown>[] & { command?: string; count?: number };

/** Rows a statement changed; Postgres errors become user errors. */
const affected = async (query: Promise<unknown>) => ((await query.catch(userError)) as BunResult).count ?? 0;

export async function listTables(name: string): Promise<TableSummary[]> {
  const rows: { schema: string; name: string; kind: string; reltuples: number }[] = await projectSql(name).unsafe(`
    select n.nspname as schema, c.relname as name, c.relkind as kind, c.reltuples::float8 as reltuples
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_RELATION}
    order by n.nspname, c.relname`);
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    kind: KINDS[r.kind]!,
    // -1 (Postgres 14+) means never analyzed; views have no stats at all.
    estimatedRows: r.kind === "v" || r.reltuples < 0 ? null : Math.round(r.reltuples),
  }));
}

/** Every user table and view with its columns, in one query (agents' project context, `/database/schema`). */
export async function schemaOverview(name: string): Promise<SchemaTable[]> {
  const rows: { schema: string; name: string; kind: string; columns: Column[] }[] = await projectSql(name).unsafe(`
    select n.nspname as schema, c.relname as name, c.relkind as kind,
      coalesce(json_agg(json_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', not a.attnotnull,
        'default', pg_get_expr(d.adbin, d.adrelid), 'primaryKey', coalesce(a.attnum = any(i.indkey), false)
      ) order by a.attnum) filter (where a.attnum is not null), '[]') as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_index i on i.indrelid = c.oid and i.indisprimary
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_RELATION}
    group by n.nspname, c.relname, c.relkind
    order by n.nspname, c.relname`);
  return rows.map((r) => ({ schema: r.schema, name: r.name, kind: KINDS[r.kind]!, columns: r.columns }));
}

interface Relation {
  oid: number;
  kind: string;
  reltuples: number;
  /** `"schema"."table"`, quoted, safe to interpolate. */
  ident: string;
  columns: Column[];
}

/** Looks the table up in the catalog, so only names that exist ever reach interpolated SQL. */
async function relation(name: string, schema: string, table: string): Promise<Relation> {
  const db = projectSql(name);
  const [rel]: { oid: number; kind: string; reltuples: number }[] = await db.unsafe(
    `select c.oid::int as oid, c.relkind as kind, c.reltuples::float8 as reltuples
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_RELATION}`,
    [schema, table],
  );
  if (!rel) throw new NotFoundError(`table "${schema}.${table}" not found`);
  const columns: Column[] = await db`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
      pg_get_expr(d.adbin, d.adrelid) as default,
      coalesce(a.attnum = any(i.indkey), false) as "primaryKey"
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
    where a.attrelid = ${rel.oid} and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;
  return { ...rel, ident: `${quoteIdent(schema)}.${quoteIdent(table)}`, columns };
}

const primaryKey = (rel: Relation) => rel.columns.filter((c) => c.primaryKey);

export async function tableRows(name: string, schema: string, table: string, limit: number, offset: number): Promise<TableRows> {
  const rel = await relation(name, schema, table);
  const pk = primaryKey(rel);
  // Text output: every value arrives as Postgres prints it, ready to show and to edit.
  const select = rel.columns.map((c) => `${quoteIdent(c.name)}::text as ${quoteIdent(c.name)}`).join(", ") || "null as _";
  // Qualified, so ORDER BY sorts the real column, not its ::text output alias.
  const order = pk.length > 0 ? `order by ${pk.map((c) => `t.${quoteIdent(c.name)}`).join(", ")}` : "";
  const exact = rel.reltuples < EXACT_COUNT_LIMIT;

  return asProject(name, async (tx) => {
    try {
      const rows: RowValues[] = await tx.unsafe(`select ${select} from ${rel.ident} t ${order} limit $1 offset $2`, [limit, offset]);
      const total = exact ? Number((await tx.unsafe(`select count(*) as n from ${rel.ident}`))[0].n) : Math.round(rel.reltuples);
      return { columns: rel.columns, rows, total, totalExact: exact, editable: pk.length > 0 && (rel.kind === "r" || rel.kind === "p") };
    } catch (err) {
      return userError(err);
    }
  });
}

/** Checks every key is a real column, then builds `"col" = $n::type` pieces starting at `$start`. */
function assignments(rel: Relation, values: RowValues, start: number) {
  const byName = new Map(rel.columns.map((c) => [c.name, c]));
  return Object.entries(values).map(([col, value], i) => {
    const column = byName.get(col);
    if (!column) throw new BadRequestError(`no column "${col}" in this table`);
    // The type comes from format_type, so it's safe to interpolate; Postgres parses the text value.
    return { ident: quoteIdent(col), param: `$${start + i}::${column.type}`, value };
  });
}

/** The row's primary key, as a WHERE clause. The key must name exactly the PK columns. */
function whereKey(rel: Relation, key: RowValues, start: number) {
  const pk = primaryKey(rel);
  if (pk.length === 0) throw new ConflictError("this table has no primary key, so its rows can't be edited here");
  if (Object.keys(key).length !== pk.length || pk.some((c) => !(c.name in key) || key[c.name] === null)) {
    throw new BadRequestError("key must give every primary key column");
  }
  const parts = assignments(rel, key, start);
  return { sql: parts.map((p) => `${p.ident} = ${p.param}`).join(" and "), values: parts.map((p) => p.value) };
}

async function editable(name: string, schema: string, table: string) {
  const rel = await relation(name, schema, table);
  if (rel.kind !== "r" && rel.kind !== "p") throw new ConflictError("only tables can be edited here, not views");
  return rel;
}

export async function insertRow(name: string, schema: string, table: string, values: RowValues, log: Logger) {
  const rel = await editable(name, schema, table);
  const parts = assignments(rel, values, 1);
  const text =
    parts.length === 0
      ? `insert into ${rel.ident} default values`
      : `insert into ${rel.ident} (${parts.map((p) => p.ident).join(", ")}) values (${parts.map((p) => p.param).join(", ")})`;
  await asProject(name, (tx) => tx.unsafe(text, parts.map((p) => p.value)).catch(userError));
  log.info("row inserted", { table: `${schema}.${table}` });
}

export async function updateRow(name: string, schema: string, table: string, key: RowValues, values: RowValues, log: Logger) {
  const rel = await editable(name, schema, table);
  const set = assignments(rel, values, 1);
  if (set.length === 0) throw new BadRequestError("nothing to update");
  const where = whereKey(rel, key, set.length + 1);
  const text = `update ${rel.ident} set ${set.map((p) => `${p.ident} = ${p.param}`).join(", ")} where ${where.sql}`;
  const count = await asProject(name, (tx) => affected(tx.unsafe(text, [...set.map((p) => p.value), ...where.values])));
  if (count === 0) throw new NotFoundError("that row no longer exists");
  log.info("row updated", { table: `${schema}.${table}` });
}

export async function deleteRow(name: string, schema: string, table: string, key: RowValues, log: Logger) {
  const rel = await editable(name, schema, table);
  const where = whereKey(rel, key, 1);
  const count = await asProject(name, (tx) => affected(tx.unsafe(`delete from ${rel.ident} where ${where.sql}`, where.values)));
  if (count === 0) throw new NotFoundError("that row no longer exists");
  log.info("row deleted", { table: `${schema}.${table}` });
}

/** How a JS value from Bun's Postgres client reads in the results grid. */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toResult(result: BunResult): QueryResult {
  const columns = result.length > 0 ? Object.keys(result[0]!) : [];
  return {
    command: result.command ?? "",
    rowCount: result.count ?? result.length,
    columns,
    rows: result.slice(0, MAX_RESULT_ROWS).map((row) => columns.map((c) => cell(row[c]))),
    truncated: result.length > MAX_RESULT_ROWS,
  };
}

/** Runs the SQL editor's text: one or more statements, in one transaction, as the project role. */
export async function runQuery(name: string, text: string, log: Logger): Promise<QueryResult[]> {
  const results = await asProject(name, async (tx) => {
    const result = (await tx.unsafe(text).catch(userError)) as BunResult | BunResult[];
    // Several statements come back as an array of results; one comes back as the result itself.
    const all = result.length > 0 && Array.isArray(result[0]) ? (result as BunResult[]) : [result as BunResult];
    return all.map(toResult);
  });
  log.info("query run", { bytes: text.length, statements: results.length });
  return results;
}

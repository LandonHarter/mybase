import type { TableRows, TableSummary } from "@mybase/shared";
import { CodeBlock } from "@/components/code-block";
import { ErrorPanel, LinesSkeleton } from "@/components/states";
import { Badge, Empty, Mono, Section } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { href } from "@/lib/router";

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * One read-only catalog query per table (loaded only when Structure is opened): foreign keys,
 * indexes, RLS and policies, triggers, and size. It runs through the SQL editor's route, as the
 * project role, so it's audited like any other query.
 */
function structureSql(table: TableSummary) {
  const rel = `to_regclass(${lit(`${quote(table.schema)}.${quote(table.name)}`)})`;
  const keyCols = (rel: string, keys: string) => `(select string_agg(a.attname, ',' order by k.n) from unnest(${keys}) with ordinality k(attnum, n) join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum)`;
  return [
    `select c.conname, ${keyCols("c.conrelid", "c.conkey")} as cols, n.nspname as ref_schema, r.relname as ref_table, ${keyCols("c.confrelid", "c.confkey")} as ref_cols, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class r on r.oid = c.confrelid join pg_namespace n on n.oid = r.relnamespace where c.conrelid = ${rel} and c.contype = 'f' order by c.conname;`,
    `select i.indexrelid::regclass::text as name, pg_get_indexdef(i.indexrelid) as def, i.indisprimary::text as primary, i.indisunique::text as unique from pg_index i where i.indrelid = ${rel} order by 1;`,
    `select c.relrowsecurity::text as rls, c.relforcerowsecurity::text as forced, pg_size_pretty(pg_total_relation_size(c.oid)) as size from pg_class c where c.oid = ${rel};`,
    `select p.polname, case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check from pg_policy p where p.polrelid = ${rel} order by 1;`,
    `select t.tgname, pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgrelid = ${rel} and not t.tgisinternal order by 1;`,
  ].join("\n");
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export function Structure({ project, table, data }: { project: string; table: TableSummary; data: TableRows | null }) {
  const info = useLoad(`structure:${project}:${table.schema}.${table.name}`, () => api.runQuery(project, structureSql(table)), { maxAge: 60_000, refetchOnFocus: false });
  const [fks, indexes, meta, policies, triggers] = info.data?.results ?? [];
  const fkByCol = new Map<string, { schema: string; table: string; cols: string }>();
  for (const r of fks?.rows ?? []) for (const col of (r[1] ?? "").split(",")) fkByCol.set(col, { schema: r[2]!, table: r[3]!, cols: r[4] ?? "" });

  return (
    <div className="grid gap-2">
      <Section id="structure-columns" title="Columns" count={data?.columns.length}>
        {!data ? (
          <LinesSkeleton label="Loading columns" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Nullable</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>References</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.columns.map((c) => {
                const fk = fkByCol.get(c.name);
                return (
                  <TableRow key={c.name}>
                    <TableCell>
                      <Mono>{c.name}</Mono> {c.primaryKey && <Badge tone="outline">Primary key</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Mono>{c.type}</Mono>
                    </TableCell>
                    <TableCell>{c.nullable ? "Yes" : "No"}</TableCell>
                    <TableCell className="max-w-64 truncate" title={c.default ?? undefined}>
                      {c.default ? <Mono>{c.default}</Mono> : <Empty />}
                    </TableCell>
                    <TableCell>
                      {fk ? (
                        <a className="hover:underline" href={href({ page: "database", name: project, tab: "tables", table: `${fk.schema}.${fk.table}` })}>
                          <Mono>
                            {fk.schema === "public" ? fk.table : `${fk.schema}.${fk.table}`}({fk.cols})
                          </Mono>
                        </a>
                      ) : (
                        <Empty />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      {info.state.status === "loading" && <LinesSkeleton label="Loading indexes, policies, and triggers" />}
      {info.state.status === "error" && <ErrorPanel title="Can't load indexes, policies, and triggers" message={info.state.message} onRetry={() => void info.refresh()} />}
      {info.data && (
        <>
          <Section id="structure-indexes" title="Indexes" count={indexes?.rows.length}>
            {indexes && indexes.rows.length > 0 ? (
              <ul className="grid gap-2">
                {indexes.rows.map((r) => (
                  <li key={r[0]} className="grid gap-1">
                    <span>
                      <Mono>{r[0]}</Mono> {r[2] === "true" ? <Badge tone="outline">Primary</Badge> : r[3] === "true" ? <Badge tone="outline">Unique</Badge> : null}
                    </span>
                    <CodeBlock code={r[1] ?? ""} lang="sql" copy={false} wrap />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No indexes.</p>
            )}
          </Section>
          <Section id="structure-rls" title="Row-level security">
            <p>
              {meta?.rows[0]?.[0] === "true" ? "On" : "Off"}
              {meta?.rows[0]?.[1] === "true" && " (forced for the table owner too)"} · table size {meta?.rows[0]?.[2] ?? "unknown"}
            </p>
            {policies && policies.rows.length > 0 && (
              <ul className="mt-2 grid gap-2">
                {policies.rows.map((r) => (
                  <li key={r[0]} className="grid gap-1 rounded-md border p-3">
                    <span>
                      <Mono>{r[0]}</Mono> <Badge tone="outline">{r[1]}</Badge>
                    </span>
                    {r[2] && (
                      <span className="text-muted-foreground">
                        using <Mono className="text-foreground">{r[2]}</Mono>
                      </span>
                    )}
                    {r[3] && (
                      <span className="text-muted-foreground">
                        with check <Mono className="text-foreground">{r[3]}</Mono>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section id="structure-triggers" title="Triggers" count={triggers?.rows.length}>
            {triggers && triggers.rows.length > 0 ? (
              <ul className="grid gap-2">
                {triggers.rows.map((r) => (
                  <li key={r[0]}>
                    <CodeBlock code={r[1] ?? ""} lang="sql" copy={false} wrap title={r[0]} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No triggers.</p>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

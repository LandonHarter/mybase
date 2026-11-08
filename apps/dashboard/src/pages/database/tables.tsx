import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, Copy, Eye, Filter, PanelLeftClose, PanelLeftOpen, Plus, Search, SquareTerminal, Table2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ROW_FILTER_OPS, type Column, type Project, type RowFilterOp, type RowValues, type TableRows, type TableSummary } from "@mybase/shared";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorPanel, LinesSkeleton, TableSkeleton } from "@/components/states";
import { LiveIndicator, Mono } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useCommands } from "@/lib/commands";
import { compact, formatCount, plural } from "@/lib/format";
import { invalidate, useLoad } from "@/lib/load";
import { href, navigate, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DataGrid, isNumeric, type CellValue, type TimeMode } from "@/pages/database/grid";
import { DatabaseLayout } from "@/pages/database/layout";
import { RowInspector } from "@/pages/database/row-form";
import { prefillSql } from "@/pages/database/sql";
import { Structure } from "@/pages/database/structure";

type DbRoute = Extract<Route, { page: "database" }>;

/** How a table is named in the URL and the list: `public` is left implied. */
const tableId = (t: TableSummary) => `${t.schema}.${t.name}`;
const tableLabel = (t: TableSummary) => (t.schema === "public" ? t.name : `${t.schema}.${t.name}`);
const qident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const qualified = (t: TableSummary) => (t.schema === "public" ? qident(t.name) : `${qident(t.schema)}.${qident(t.name)}`);
const sqlLiteral = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

const OP_LABELS: Record<RowFilterOp, string> = { eq: "=", neq: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥", contains: "contains", null: "is NULL", notnull: "is not NULL" };

const LIST_KEY = "mybase.db.listOpen";

// --- Table list ---------------------------------------------------------------

function TableList({ project, tables, selected, onNew }: { project: string; tables: TableSummary[]; selected: string | null; onNew: () => void }) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle ? tables.filter((t) => tableLabel(t).toLowerCase().includes(needle)) : tables;
  return (
    <div className="grid content-start gap-2">
      {tables.length > 4 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Filter tables" placeholder="Filter tables" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <nav aria-label="Tables" className="grid gap-0.5">
        {visible.map((t) => {
          const id = tableId(t);
          const active = id === selected;
          const Icon = t.kind === "table" || t.kind === "partitioned table" ? Table2 : Eye;
          return (
            <a
              key={id}
              href={href({ page: "database", name: project, tab: "tables", table: id })}
              aria-current={active ? "page" : undefined}
              title={`${tableLabel(t)} (${t.kind})`}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2.5 text-muted-foreground outline-none transition-colors duration-150",
                "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active && "bg-selected font-medium text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{tableLabel(t)}</span>
              {t.estimatedRows !== null && (
                <span className="text-xs text-muted-foreground tabular-nums" title={`About ${formatCount(t.estimatedRows)} rows`}>
                  {compact(t.estimatedRows)}
                </span>
              )}
            </a>
          );
        })}
        {visible.length === 0 && <p className="px-2.5 py-1 text-muted-foreground">No matches</p>}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={onNew}>
        <Plus />
        New table
      </Button>
    </div>
  );
}

// --- New table builder (DB01): shows the SQL before running it ----------------

interface NewColumn {
  name: string;
  type: string;
  defaultValue: string;
  nullable: boolean;
  pk: boolean;
}

const TYPES = ["bigint generated always as identity", "uuid", "text", "integer", "bigint", "numeric", "boolean", "timestamptz", "date", "jsonb"];

function NewTableDialog({ project, open, onOpenChange, onCreated }: { project: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [cols, setCols] = useState<NewColumn[]>([
    { name: "id", type: "bigint generated always as identity", defaultValue: "", nullable: false, pk: true },
    { name: "created_at", type: "timestamptz", defaultValue: "now()", nullable: false, pk: false },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (i: number, patch: Partial<NewColumn>) => setCols((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const pks = cols.filter((c) => c.pk && c.name);
  const sql = `create table ${qident(name || "new_table")} (\n${cols
    .filter((c) => c.name)
    .map((c) => `  ${qident(c.name)} ${c.type}${c.defaultValue ? ` default ${c.defaultValue}` : ""}${!c.nullable && !c.pk ? " not null" : ""}`)
    .concat(pks.length ? [`  primary key (${pks.map((c) => qident(c.name)).join(", ")})`] : [])
    .join(",\n")}\n);`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return setError("Use lowercase letters, digits, and _, starting with a letter or _.");
    setPending(true);
    setError(null);
    try {
      await api.runQuery(project, sql);
      invalidate(`tables:${project}`);
      toast.success(`Created ${name}`);
      onOpenChange(false);
      onCreated(`public.${name}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader className="text-left">
            <DialogTitle>New table</DialogTitle>
            <DialogDescription>Runs the SQL below in the public schema, as the project's role. Check it first.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="nt-name" className="font-medium">
              Name
            </label>
            <Input id="nt-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="off" spellCheck={false} className="font-mono md:text-[13px]" placeholder="orders" />
          </div>
          <div className="grid gap-2">
            <p className="font-medium">Columns</p>
            {cols.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr] items-center gap-2 sm:grid-cols-[10rem_12rem_1fr_auto_auto_auto]">
                <Input aria-label={`Column ${i + 1} name`} value={c.name} onChange={(e) => set(i, { name: e.target.value })} className="font-mono md:text-[13px]" placeholder="name" />
                <Select aria-label={`Column ${i + 1} type`} value={c.type} onChange={(e) => set(i, { type: e.target.value })} className="font-mono md:text-[13px]">
                  {[...new Set([...TYPES, c.type])].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <Input aria-label={`Column ${i + 1} default`} value={c.defaultValue} onChange={(e) => set(i, { defaultValue: e.target.value })} className="font-mono md:text-[13px]" placeholder="default (SQL)" />
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={c.nullable} onCheckedChange={(v) => set(i, { nullable: v === true })} /> Nullable
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={c.pk} onCheckedChange={(v) => set(i, { pk: v === true })} /> Key
                </label>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove column ${c.name || i + 1}`} onClick={() => setCols((x) => x.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setCols((c) => [...c, { name: "", type: "text", defaultValue: "", nullable: true, pk: false }])}>
              <Plus />
              Add column
            </Button>
          </div>
          <CodeBlock code={sql} lang="sql" title="SQL that will run" />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name}>
              {pending ? "Creating…" : "Create table"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Filters (DB04) -------------------------------------------------------------

function parseFilter(f: string) {
  const [column = "", op = "eq", ...rest] = f.split(":");
  return { column, op: (ROW_FILTER_OPS as readonly string[]).includes(op) ? (op as RowFilterOp) : "eq", value: rest.join(":") };
}

function FilterBar({ columns, filters, onChange }: { columns: Column[]; filters: string[]; onChange: (filters: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [column, setColumn] = useState(columns[0]?.name ?? "");
  const [op, setOp] = useState<RowFilterOp>("eq");
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => e.key === "Escape" && setAdding(false)}>
      {filters.map((f, i) => {
        const p = parseFilter(f);
        return (
          <span key={f} className="inline-flex items-center gap-1 rounded-md border bg-surface py-0.5 pr-0.5 pl-2 text-sm">
            <Mono>{p.column}</Mono>
            <span className="text-muted-foreground">{OP_LABELS[p.op]}</span>
            {p.op !== "null" && p.op !== "notnull" && <Mono>{p.value || '""'}</Mono>}
            <Button variant="ghost" size="icon-xs" aria-label={`Remove filter on ${p.column}`} onClick={() => onChange(filters.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </span>
        );
      })}
      {adding && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onChange([...filters, `${column}:${op}:${op === "null" || op === "notnull" ? "" : value}`]);
            setValue("");
            setAdding(false);
          }}
        >
          <Select aria-label="Filter column" value={column} onChange={(e) => setColumn(e.target.value)} className="h-8 font-mono md:text-[13px]">
            {columns.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </Select>
          <Select aria-label="Filter operator" value={op} onChange={(e) => setOp(e.target.value as RowFilterOp)} className="h-8">
            {ROW_FILTER_OPS.map((o) => (
              <option key={o} value={o}>
                {OP_LABELS[o]}
              </option>
            ))}
          </Select>
          {op !== "null" && op !== "notnull" && <Input aria-label="Filter value" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-40 font-mono md:text-[13px]" />}
          <Button type="submit" size="sm">
            Apply
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      {!adding && (
        <Button variant="ghost" size="sm" className={cn(filters.length === 0 && "text-muted-foreground")} onClick={() => setAdding(true)}>
          {filters.length ? <Plus /> : <Filter />}
          Filter
        </Button>
      )}
      {filters.length > 0 && (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onChange([])}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

// --- Pager (DB05) ---------------------------------------------------------------

function Pager({ data, offset, limit, refreshing, onPage }: { data: TableRows; offset: number; limit: number; refreshing: boolean; onPage: (offset: number, limit: number) => void }) {
  const end = offset + data.rows.length;
  const total = `${data.totalExact ? "" : "about "}${formatCount(data.total)}`;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground tabular-nums" aria-live="polite">
        {data.rows.length === 0 ? `${total} rows` : `${formatCount(offset + 1)}–${formatCount(end)} of ${total}${data.totalExact ? "" : " (estimated)"}`}
        {refreshing && <span className="ml-2 inline-block size-1.5 rounded-full bg-info align-middle motion-safe:animate-progress" aria-label="Loading" />}
      </p>
      <span className="flex items-center gap-2">
        <Select aria-label="Rows per page" value={String(limit)} onChange={(e) => onPage(0, Number(e.target.value))} className="h-8 w-28">
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </Select>
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit), limit)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={data.rows.length < limit} onClick={() => onPage(offset + limit, limit)}>
          <ChevronRight />
        </Button>
      </span>
    </div>
  );
}

// --- Insert row inline (DB07) ---------------------------------------------------

function InsertRow({ columns, onCommit, onCancel, extra }: { columns: Column[]; onCommit: (values: RowValues) => Promise<void>; onCancel: () => void; extra: number }) {
  const [values, setValues] = useState<RowValues>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function commit() {
    setPending(true);
    setError(null);
    try {
      await onCommit(values);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <tr className="bg-selected">
      {Array.from({ length: extra }, (_, i) => (
        <td key={i} className="border-b px-1 align-top">
          {i === 0 && (
            <Button variant="ghost" size="icon-xs" aria-label="Cancel new row" onClick={onCancel}>
              <X />
            </Button>
          )}
        </td>
      ))}
      {columns.map((c, i) => (
        <td key={c.name} className="relative border-b p-0 align-top">
          <input
            aria-label={`New row: ${c.name}`}
            autoFocus={i === 0}
            disabled={pending}
            placeholder={c.default ? `default` : c.nullable ? "NULL" : ""}
            title={c.default ? `Default: ${c.default}` : undefined}
            value={values[c.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") onCancel();
            }}
            className={cn("h-9 w-full min-w-28 bg-transparent px-2 font-mono text-base outline-none placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-primary focus:ring-inset md:text-[13px]", isNumeric(c.type) && "text-right")}
          />
          {i === 0 && error && (
            <p role="alert" className="absolute top-full left-0 z-30 mt-1 w-max max-w-sm rounded-md border border-destructive/40 bg-background p-2 text-xs whitespace-normal text-destructive shadow-md">
              {error}
            </p>
          )}
        </td>
      ))}
    </tr>
  );
}

// --- Copy helpers (DB08) --------------------------------------------------------

function asCsv(columns: Column[], rows: RowValues[]) {
  const esc = (v: string | null) => (v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.map((c) => esc(c.name)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c.name] ?? null)).join(","))].join("\n");
}
function asInserts(table: TableSummary, columns: Column[], rows: RowValues[]) {
  const cols = columns.map((c) => qident(c.name)).join(", ");
  return rows.map((r) => `insert into ${qualified(table)} (${cols}) values (${columns.map((c) => sqlLiteral(r[c.name] ?? null)).join(", ")});`).join("\n");
}

// --- Tab ----------------------------------------------------------------------

export function TablesTab({ project, route }: { project: Project; route: DbRoute }) {
  const name = project.name;
  const table = route.table;
  const tables = useLoad(`tables:${name}`, () => api.listTables(name));
  const list = tables.state.status === "ready" ? tables.state.data : null;
  const selected = list?.find((t) => tableId(t) === table) ?? null;
  const offset = route.offset ?? 0;
  const limit = route.limit ?? 50;
  const filters = route.filters ?? [];
  const sort = route.sort ? { column: route.sort.replace(/\.desc$/, ""), desc: route.sort.endsWith(".desc") } : null;
  const go = (patch: Partial<DbRoute>, replace = true) => navigate({ ...route, ...patch }, { replace });

  const rowsKey = selected ? `rows:${name}:${table}:${offset}:${limit}:${route.sort ?? ""}:${filters.join("&")}` : "rows:none";
  const rows = useLoad(rowsKey, () => (selected ? api.tableRows(name, selected.schema, selected.name, limit, offset, { sort: route.sort, filters }) : Promise.resolve(null)), { keepPrevious: true });
  const data = rows.state.status === "ready" ? rows.state.data : null;
  const refreshRows = () => invalidate(`rows:${name}:${table}:`);

  const [inspect, setInspect] = useState<{ row: RowValues | null } | null>(null);
  const [inserting, setInserting] = useState(false);
  const [deleting, setDeleting] = useState<RowValues[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<string[]>([]);
  const [timeMode, setTimeMode] = useState<TimeMode>("stored");
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [newTable, setNewTable] = useState(false);
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem(LIST_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleList = () =>
    setListOpen((o) => {
      try {
        localStorage.setItem(LIST_KEY, o ? "0" : "1");
      } catch {
        // per-visit only
      }
      return !o;
    });

  // A table change starts over: no stale selection or hidden columns.
  useEffect(() => {
    setPicked(new Set());
    setHidden([]);
    setInserting(false);
  }, [table]);

  // Open the first table when none is picked, so the tab never starts blank.
  useEffect(() => {
    if (table === null && list && list.length > 0) navigate({ page: "database", name, tab: "tables", table: tableId(list[0]!) }, { replace: true });
  }, [table, list, name]);

  const pk = data?.columns.filter((c) => c.primaryKey) ?? [];
  const keyOf = (r: RowValues) => (pk.length ? pk.map((c) => r[c.name] ?? "").join("\u0000") : JSON.stringify(r));
  const grid = useMemo(() => (data ? data.rows.map((r) => data.columns.map((c) => (r[c.name] ?? null) as CellValue)) : []), [data]);
  const pickedRows = data ? data.rows.filter((r) => picked.has(keyOf(r))) : [];

  async function saveCell(index: number, column: { name: string }, value: string) {
    if (!data || !selected) return;
    const row = data.rows[index]!;
    const key = Object.fromEntries(pk.map((c) => [c.name, row[c.name] ?? null]));
    await api.updateRow(name, selected.schema, selected.name, { key, values: { [column.name]: value } });
    const k = keyOf({ ...row, [column.name]: value });
    setArrived(new Set([k]));
    refreshRows();
  }

  async function insert(values: RowValues) {
    if (!selected) return;
    const touched = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== undefined));
    await api.insertRow(name, selected.schema, selected.name, { values: touched });
    toast.success(`Inserted a row into ${tableLabel(selected)}`);
    setInserting(false);
    refreshRows();
  }

  async function removeRows(target: RowValues[]) {
    if (!selected) return;
    let done = 0;
    try {
      for (const r of target) {
        await api.deleteRow(name, selected.schema, selected.name, { key: Object.fromEntries(pk.map((c) => [c.name, r[c.name] ?? null])) });
        done++;
      }
    } finally {
      if (done > 0) toast.success(`Deleted ${plural(done, "row", "rows")} from ${tableLabel(selected)}`);
      setPicked(new Set());
      setInspect(null);
      // Step back when the page we were on is now empty.
      if (data && done >= data.rows.length && offset > 0) go({ offset: Math.max(0, offset - limit) });
      refreshRows();
    }
  }

  async function copyRows(kind: "json" | "csv" | "insert") {
    if (!data || !selected) return;
    const target = pickedRows.length ? pickedRows : data.rows;
    const text = kind === "json" ? JSON.stringify(target, null, 2) : kind === "csv" ? asCsv(data.columns, target) : asInserts(selected, data.columns, target);
    try {
      await copyText(text);
      toast.success(`Copied ${plural(target.length, "row", "rows")} as ${kind === "insert" ? "INSERT statements" : kind.toUpperCase()}`);
    } catch {
      toast.error("Couldn't copy. Try fewer rows.");
    }
  }

  const queryInSql = () => {
    if (!selected) return;
    prefillSql(name, `select * from ${qualified(selected)} limit 50;`);
    navigate({ page: "database", name, tab: "sql", table: null });
  };

  useCommands(
    selected && data
      ? [
          ...(data.editable ? [{ id: "insert-row", label: "Insert row", icon: Plus, run: () => setInserting(true) }] : []),
          ...(data.editable ? [{ id: "insert-form", label: "Insert row with form", run: () => setInspect({ row: null }) }] : []),
          { id: "query-sql", label: `Query ${tableLabel(selected)} in SQL`, icon: SquareTerminal, run: queryInSql },
          { id: "copy-csv", label: "Copy rows as CSV", icon: Copy, run: () => void copyRows("csv") },
          { id: "structure", label: `Show structure of ${tableLabel(selected)}`, run: () => go({ view: "structure" }, false) },
        ]
      : [],
  );

  const insertButton = data?.editable && route.view !== "structure" && (
    <div className="flex">
      <Button className="rounded-r-none" onClick={() => setInserting(true)} data-shortcut="create">
        <Plus />
        Insert row
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="rounded-l-none border-l border-primary-foreground/20 px-2" aria-label="More ways to insert">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setInspect({ row: null })}>Insert with form…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  let body;
  if (tables.state.status === "loading") body = <LinesSkeleton label="Loading tables" lines={4} />;
  else if (tables.state.status === "error") body = <ErrorPanel title="Can't list tables" message={tables.state.message} onRetry={tables.refresh} />;
  else if (list!.length === 0) {
    const example = "create table todos (\n  id bigint generated always as identity primary key,\n  title text not null,\n  done boolean not null default false,\n  created_at timestamptz not null default now()\n);";
    body = (
      <EmptyState
        title="No tables yet"
        action={
          <>
            <Button onClick={() => setNewTable(true)}>
              <Plus />
              New table
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                prefillSql(name, example);
                navigate({ page: "database", name, tab: "sql", table: null });
              }}
            >
              <SquareTerminal />
              Open example in SQL editor
            </Button>
          </>
        }
      >
        Tables hold your app's data. Create one with the builder, or start from this example in the SQL editor (it isn't run until you press Run):
        <CodeBlock className="mt-3" lang="sql" code={example} />
      </EmptyState>
    );
  } else {
    let view;
    if (!selected)
      view = table ? (
        <ErrorPanel
          title={`No table named ${table}`}
          message="It may have been renamed or dropped."
          onRetry={() => void tables.refresh()}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate({ page: "database", name, tab: "tables", table: tableId(list![0]!) })}>
              Open {tableLabel(list![0]!)}
            </Button>
          }
        />
      ) : null;
    else {
      const readOnlyReason = data && !data.editable ? (selected.kind === "table" || selected.kind === "partitioned table" ? "Read-only: rows can be edited only in tables with a primary key, so each row can be found again." : `Read-only: this is a ${selected.kind}, which has no rows of its own to edit.`) : null;
      view = (
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" aria-label={listOpen ? "Hide table list" : "Show table list"} title={listOpen ? "Hide table list" : "Show table list"} onClick={toggleList}>
              {listOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
            <h2 className="mr-1 font-mono text-[15px] font-medium">
              {selected.schema}.<span className="text-foreground">{selected.name}</span>
            </h2>
            {data && <span className="text-muted-foreground tabular-nums">{plural(data.total, "row", "rows")}{data.totalExact ? "" : " (est.)"}</span>}
            <SegmentedControl size="xs" label="View" value={route.view ?? "data"} options={[{ value: "data", label: "Data" }, { value: "structure", label: "Structure" }]} onChange={(v) => go({ view: v }, false)} />
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <LiveIndicator load={rows} />
              {route.view !== "structure" && data && (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Columns3 />
                        Columns
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                      <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                      {data.columns.map((c) => (
                        <DropdownMenuCheckboxItem key={c.name} checked={!hidden.includes(c.name)} onCheckedChange={(on) => setHidden((h) => (on ? h.filter((x) => x !== c.name) : [...h, c.name]))} onSelect={(e) => e.preventDefault()}>
                          <span className="font-mono text-[13px]">{c.name}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem checked={timeMode === "relative"} onCheckedChange={(on) => setTimeMode(on ? "relative" : "stored")} onSelect={(e) => e.preventDefault()}>
                        Times as "3 hours ago"
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Copy />
                        {pickedRows.length ? `Copy ${pickedRows.length}` : "Copy"}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void copyRows("csv")}>As CSV</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void copyRows("json")}>As JSON</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void copyRows("insert")}>As INSERT statements</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button variant="ghost" size="sm" onClick={queryInSql}>
                    <SquareTerminal />
                    Query in SQL
                  </Button>
                </>
              )}
            </div>
          </div>
          {route.view === "structure" ? (
            <Structure project={name} table={selected} data={data} />
          ) : (
            <>
              {data && <FilterBar key={tableId(selected)} columns={data.columns} filters={filters} onChange={(f) => go({ filters: f, offset: 0 })} />}
              {readOnlyReason && <p className="text-muted-foreground">{readOnlyReason}</p>}
              {pickedRows.length > 0 && data?.editable && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-surface px-3 py-1.5" role="region" aria-label="Selected rows">
                  <span>{plural(pickedRows.length, "row", "rows")} selected</span>
                  <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
                    Clear
                  </Button>
                  <Button variant="danger-outline" size="sm" className="ml-auto" onClick={() => setDeleting(pickedRows)}>
                    <Trash2 />
                    Delete {pickedRows.length}…
                  </Button>
                </div>
              )}
              {rows.state.status === "loading" && <TableSkeleton label="Loading rows" columns={5} rows={6} />}
              {rows.state.status === "error" && <ErrorPanel title="Can't load rows" message={rows.state.message} onRetry={rows.refresh} />}
              {data && (data.rows.length === 0 && !inserting ? (
                <EmptyState
                  title={filters.length ? "No rows match these filters" : "No rows"}
                  action={
                    filters.length ? (
                      <Button variant="outline" size="sm" onClick={() => go({ filters: [], offset: 0 })}>
                        Clear filters
                      </Button>
                    ) : data.editable ? (
                      <Button variant="outline" size="sm" onClick={() => setInserting(true)}>
                        <Plus />
                        Insert row
                      </Button>
                    ) : undefined
                  }
                >
                  {filters.length ? "Try a different filter." : data.editable ? "Add one here, or from your app." : "This table is empty."}
                </EmptyState>
              ) : (
                <>
                  <DataGrid
                    label={`Rows of ${tableLabel(selected)}`}
                    columns={data.columns}
                    rows={grid}
                    rowKey={(_, i) => keyOf(data.rows[i]!)}
                    hidden={hidden}
                    timeMode={timeMode}
                    sort={sort}
                    onSort={(col) => go({ sort: sort?.column === col ? (sort.desc ? null : `${col}.desc`) : col, offset: 0 })}
                    onSave={data.editable ? saveCell : undefined}
                    onInspect={(i) => setInspect({ row: data.rows[i]! })}
                    selected={data.editable ? picked : undefined}
                    onSelect={data.editable ? (key, on) => setPicked((p) => { const n = new Set(p); if (on) n.add(key); else n.delete(key); return n; }) : undefined}
                    arrived={arrived}
                    top={inserting && data.editable ? <InsertRow columns={data.columns.filter((c) => !hidden.includes(c.name))} extra={2} onCommit={insert} onCancel={() => setInserting(false)} /> : undefined}
                  />
                  <Pager data={data} offset={offset} limit={limit} refreshing={rows.refreshing} onPage={(o, n) => go({ offset: o, limit: n }, false)} />
                  {data.editable && (
                    <p className="text-xs text-muted-foreground">
                      Click a cell to select it (⌘C copies), double-click or Enter to edit, Space to open the row.
                    </p>
                  )}
                </>
              ))}
            </>
          )}
          {data && inspect && (
            <RowInspector
              key={inspect.row ? keyOf(inspect.row) : "new"}
              project={name}
              table={selected}
              data={data}
              row={inspect.row}
              open
              onOpenChange={(o) => !o && setInspect(null)}
              onSaved={() => {
                if (!inspect.row) toast.success(`Inserted a row into ${tableLabel(selected)}`);
                refreshRows();
              }}
              onDelete={data.editable && inspect.row ? () => setDeleting([inspect.row!]) : undefined}
            />
          )}
          {data && (
            <ConfirmDialog
              open={deleting !== null}
              onOpenChange={(o) => !o && setDeleting(null)}
              title={deleting?.length === 1 ? `Delete a row from ${selected.schema}.${selected.name}` : `Delete ${deleting?.length ?? 0} rows from ${selected.schema}.${selected.name}`}
              description={
                <>
                  {deleting?.length === 1 ? (
                    <>
                      The row with <span className="font-mono text-foreground">{pk.map((c) => `${c.name} = ${deleting[0]![c.name] ?? "NULL"}`).join(", ")}</span> is deleted.
                    </>
                  ) : (
                    <>These rows are deleted one by one; it stops at the first failure.</>
                  )}{" "}
                  Rows in other tables that reference them are deleted too if their foreign key says <span className="font-mono">on delete cascade</span>; otherwise the delete is refused. This can't be undone.
                </>
              }
              confirm={deleting?.length === 1 ? "Delete row" : `Delete ${deleting?.length ?? 0} rows`}
              pendingLabel="Deleting…"
              onConfirm={() => removeRows(deleting ?? [])}
            />
          )}
        </div>
      );
    }
    body = (
      <>
        {/* Phones: a table picker instead of the list. */}
        <div className="mb-3 md:hidden">
          <Select aria-label="Table" value={table ?? ""} onChange={(e) => navigate({ page: "database", name, tab: "tables", table: e.target.value })} wrapperClassName="w-full">
            {list!.map((t) => (
              <option key={tableId(t)} value={tableId(t)}>
                {tableLabel(t)}
              </option>
            ))}
          </Select>
        </div>
        <div className={cn("grid gap-6", listOpen ? "md:grid-cols-[14rem_minmax(0,1fr)]" : "md:grid-cols-[minmax(0,1fr)]")}>
          {listOpen && (
            <div className="hidden md:block">
              <TableList project={name} tables={list!} selected={table} onNew={() => setNewTable(true)} />
            </div>
          )}
          <div className="relative min-w-0">
            {view}
          </div>
        </div>
      </>
    );
  }

  return (
    <DatabaseLayout project={project} tab="tables" action={insertButton || undefined}>
      {body}
      <NewTableDialog project={name} open={newTable} onOpenChange={setNewTable} onCreated={(id) => navigate({ page: "database", name, tab: "tables", table: id })} />
    </DatabaseLayout>
  );
}

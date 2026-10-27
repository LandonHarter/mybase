import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Eye, KeyRound, Pencil, Plus, RotateCw, Search, Table2 } from "lucide-react";
import { toast } from "sonner";
import type { Column, Project, RowValues, TableRows, TableSummary } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DatabaseLayout } from "@/pages/database/layout";

const PAGE_SIZE = 50;

/** How a table is named in the URL and the list: `public` is left implied. */
const tableId = (t: TableSummary) => `${t.schema}.${t.name}`;
const tableLabel = (t: TableSummary) => (t.schema === "public" ? t.name : `${t.schema}.${t.name}`);

/** Types whose values are often long or multi-line get a textarea. */
const isLongType = (type: string) => /^(text|json|jsonb|xml|character varying$)/.test(type) || type.endsWith("[]");

function ErrorBox({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        <RotateCw />
        Retry
      </Button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label={label}>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-5 w-full max-w-md" />
      ))}
    </div>
  );
}

// --- Row dialog ---------------------------------------------------------------

interface Field {
  value: string;
  isNull: boolean;
  /** Insert sends only touched fields, so untouched ones get the column default. */
  touched: boolean;
}

type RowDialogState = { mode: "insert" } | { mode: "edit"; row: RowValues };

function initialFields(columns: Column[], row: RowValues | null): Record<string, Field> {
  return Object.fromEntries(
    columns.map((c) => {
      const value = row ? row[c.name] ?? null : null;
      return [c.name, { value: value ?? "", isNull: row !== null && value === null, touched: false }];
    }),
  );
}

function RowDialog({
  project,
  table,
  data,
  state,
  onOpenChange,
  onSaved,
}: {
  project: string;
  table: TableSummary;
  data: TableRows;
  state: RowDialogState | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const row = state?.mode === "edit" ? state.row : null;
  const [fields, setFields] = useState<Record<string, Field>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!state) return;
    setFields(initialFields(data.columns, row));
    setError(null);
    setConfirmDelete(false);
  }, [state, data.columns, row]);

  const update = (name: string, patch: Partial<Field>) => setFields((f) => ({ ...f, [name]: { ...f[name]!, ...patch, touched: true } }));
  const key = () => Object.fromEntries(data.columns.filter((c) => c.primaryKey).map((c) => [c.name, row![c.name] ?? null]));

  async function act(fn: () => Promise<unknown>, done: string) {
    setPending(true);
    setError(null);
    try {
      await fn();
      onOpenChange(false);
      onSaved();
      toast.success(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const values: RowValues = {};
    for (const c of data.columns) {
      const f = fields[c.name]!;
      const next = f.isNull ? null : f.value;
      if (row ? next !== (row[c.name] ?? null) : f.touched) values[c.name] = next;
    }
    if (row) {
      if (Object.keys(values).length === 0) return onOpenChange(false);
      void act(() => api.updateRow(project, table.schema, table.name, { key: key(), values }), "Row saved");
    } else {
      void act(() => api.insertRow(project, table.schema, table.name, { values }), "Row inserted");
    }
  }

  const remove = () => act(() => api.deleteRow(project, table.schema, table.name, { key: key() }), "Row deleted");

  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>{row ? "Edit row" : "Insert row"}</DialogTitle>
            <DialogDescription>
              {row ? "Change values, then save." : "Fields you leave untouched get the column's default."} Values use Postgres' text format.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {data.columns.map((c, i) => {
              const f = fields[c.name];
              if (!f) return null;
              const id = `field-${i}`;
              const placeholder = f.touched || row ? undefined : c.default ? `Default: ${c.default}` : c.nullable ? "NULL" : undefined;
              const props = {
                id,
                value: f.isNull ? "" : f.value,
                disabled: f.isNull,
                placeholder: f.isNull ? "NULL" : placeholder,
                spellCheck: false,
                className: "font-mono text-xs md:text-xs",
              };
              return (
                <div key={c.name} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Label htmlFor={id} className="gap-1.5">
                      {c.primaryKey && <KeyRound className="size-3.5 text-muted-foreground" aria-label="Primary key" />}
                      {c.name}
                      <span className="font-mono text-xs font-normal text-muted-foreground">{c.type}</span>
                    </Label>
                    {c.nullable && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="accent-foreground"
                          aria-label={`${c.name} is NULL`}
                          checked={f.isNull}
                          onChange={(e) => update(c.name, { isNull: e.target.checked })}
                        />
                        NULL
                      </label>
                    )}
                  </div>
                  {isLongType(c.type) ? (
                    <Textarea {...props} rows={1} className={cn(props.className, "min-h-9")} onChange={(e) => update(c.name, { value: e.target.value })} />
                  ) : (
                    <Input {...props} onChange={(e) => update(c.name, { value: e.target.value })} />
                  )}
                </div>
              );
            })}
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="items-center gap-2 sm:justify-between">
            {row ? (
              confirmDelete ? (
                <span className="flex items-center gap-2">
                  <Button type="button" variant="destructive" disabled={pending} onClick={remove}>
                    Delete row
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button type="button" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </Button>
              )
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : row ? "Save" : "Insert"}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Table view ---------------------------------------------------------------

function RowsGrid({ data, onEdit }: { data: TableRows; onEdit: (row: RowValues) => void }) {
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-5">
        <p className="font-medium">No rows</p>
        <p className="mt-1 text-muted-foreground">{data.editable ? "Use Insert row to add one." : "This table is empty."}</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {data.editable && (
              <TableHead className="w-8">
                <span className="sr-only">Edit</span>
              </TableHead>
            )}
            {data.columns.map((c) => (
              <TableHead key={c.name} className="h-auto py-2 align-bottom">
                <span className="flex items-center gap-1 font-mono text-xs text-foreground">
                  {c.primaryKey && <KeyRound className="size-3 text-muted-foreground" aria-label="Primary key" />}
                  {c.name}
                </span>
                <span className="block font-mono text-[0.7rem] font-normal text-muted-foreground">{c.type}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, i) => (
            <TableRow key={i} className={cn(data.editable && "cursor-pointer")} onClick={data.editable ? () => onEdit(row) : undefined}>
              {data.editable && (
                <TableCell className="py-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit row ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(row);
                    }}
                  >
                    <Pencil />
                  </Button>
                </TableCell>
              )}
              {data.columns.map((c) => {
                const value = row[c.name] ?? null;
                return (
                  <TableCell key={c.name} className="max-w-80 truncate font-mono text-xs" title={value ?? "NULL"}>
                    {value ?? <span className="text-muted-foreground italic">NULL</span>}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Pager({ data, offset, onOffset }: { data: TableRows; offset: number; onOffset: (offset: number) => void }) {
  const end = offset + data.rows.length;
  const total = `${data.totalExact ? "" : "about "}${data.total.toLocaleString()}`;
  return (
    <div className="mt-3 flex items-center justify-between gap-4">
      <p className="text-muted-foreground tabular-nums">
        {data.rows.length === 0 ? `${total} rows` : `${(offset + 1).toLocaleString()}–${end.toLocaleString()} of ${total}`}
      </p>
      <span className="flex gap-1">
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          // Estimated totals can be off, so a short page is the reliable "last page" signal.
          disabled={data.rows.length < PAGE_SIZE}
          onClick={() => onOffset(offset + PAGE_SIZE)}
        >
          <ChevronRight />
        </Button>
      </span>
    </div>
  );
}

// --- Tab ----------------------------------------------------------------------

function TableList({ project, tables, selected }: { project: string; tables: TableSummary[]; selected: string | null }) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle ? tables.filter((t) => tableLabel(t).toLowerCase().includes(needle)) : tables;
  return (
    <div className="grid content-start gap-2">
      {tables.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
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
                "flex h-8 items-center gap-2 rounded-md px-2.5 text-muted-foreground outline-none",
                "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active && "bg-accent font-medium text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{tableLabel(t)}</span>
            </a>
          );
        })}
        {visible.length === 0 && <p className="px-2.5 py-1 text-muted-foreground">No matches</p>}
      </nav>
    </div>
  );
}

export function TablesTab({ project, table }: { project: Project; table: string | null }) {
  const name = project.name;
  const tables = useLoad(`tables:${name}`, () => api.listTables(name));
  const list = tables.state.status === "ready" ? tables.state.data : null;
  const selected = list?.find((t) => tableId(t) === table) ?? null;

  // Pagination resets when the table changes.
  const [page, setPage] = useState({ table, offset: 0 });
  const offset = page.table === table ? page.offset : 0;
  const rows = useLoad(selected ? `rows:${name}:${table}:${offset}` : "rows:none", () =>
    selected ? api.tableRows(name, selected.schema, selected.name, PAGE_SIZE, offset) : Promise.resolve(null),
  );
  const data = rows.state.status === "ready" ? rows.state.data : null;
  const [dialog, setDialog] = useState<RowDialogState | null>(null);

  // Open the first table when none is picked, so the tab never starts blank.
  useEffect(() => {
    if (table === null && list && list.length > 0) navigate({ page: "database", name, tab: "tables", table: tableId(list[0]!) }, { replace: true });
  }, [table, list, name]);

  const insertButton = data?.editable && (
    <Button onClick={() => setDialog({ mode: "insert" })}>
      <Plus />
      Insert row
    </Button>
  );

  let body;
  if (tables.state.status === "loading") body = <Loading label="Loading tables" />;
  else if (tables.state.status === "error") body = <ErrorBox title="Can't list tables" message={tables.state.message} onRetry={tables.refresh} />;
  else if (list!.length === 0) {
    body = (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No tables yet</p>
        <p className="mt-1 text-muted-foreground">Create one with SQL, for example:</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
          create table todos (id serial primary key, title text not null, done boolean default false);
        </pre>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <a href={href({ page: "database", name, tab: "sql", table: null })}>Open SQL editor</a>
        </Button>
      </div>
    );
  } else {
    let view;
    if (!selected) view = table ? <p className="text-muted-foreground">No table named {table}. It may have been dropped.</p> : null;
    else if (rows.state.status === "loading") view = <Loading label="Loading rows" />;
    else if (rows.state.status === "error") view = <ErrorBox title="Can't load rows" message={rows.state.message} onRetry={rows.refresh} />;
    else if (data) {
      view = (
        <>
          {!data.editable && (
            <p className="mb-3 text-muted-foreground">
              {selected.kind === "table" || selected.kind === "partitioned table"
                ? "Read-only: rows can be edited only in tables with a primary key."
                : `Read-only: this is a ${selected.kind}.`}
            </p>
          )}
          <RowsGrid data={data} onEdit={(row) => setDialog({ mode: "edit", row })} />
          <Pager data={data} offset={offset} onOffset={(o) => setPage({ table, offset: o })} />
          {data.editable && (
            <RowDialog
              project={name}
              table={selected}
              data={data}
              state={dialog}
              onOpenChange={(open) => !open && setDialog(null)}
              onSaved={rows.refresh}
            />
          )}
        </>
      );
    }
    body = (
      <div className="grid gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
        <TableList project={name} tables={list!} selected={table} />
        <div className="min-w-0">{view}</div>
      </div>
    );
  }

  return (
    <DatabaseLayout project={project} tab="tables" action={insertButton || undefined}>
      {body}
    </DatabaseLayout>
  );
}

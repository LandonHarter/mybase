import { ArrowDown, ArrowUp, Expand, KeyRound } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { relativeTo } from "@/components/time-ago";
import { copyText } from "@/lib/clipboard";
import { errorMessage } from "@/lib/api";
import { announce } from "@/lib/announce";
import { middle } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A column as the grid needs it: from the table editor (typed) or SQL results (type unknown). */
export interface GridColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  default?: string | null;
}

export type CellValue = string | null;

const NUMERIC = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|oid)\b/;
const TIME = /^(timestamp|date|time)\b/;
export const isNumeric = (type?: string) => !!type && NUMERIC.test(type);
export const isBoolean = (type?: string) => type === "boolean";
export const isJson = (type?: string) => type === "json" || type === "jsonb";
export const isTime = (type?: string) => !!type && TIME.test(type);
export const isUuid = (type?: string, value?: string | null) => type === "uuid" || (!type && !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));

export type TimeMode = "stored" | "relative";

/**
 * How a value reads in the grid (DB03): numbers right-aligned, booleans ✓/–, timestamps as stored
 * (or relative), JSON as a `{…}` chip that expands in place, UUIDs middle-truncated, NULL as a
 * muted badge. The exact value is always one click away (title, inspector, ⌘C).
 */
export function Cell({ value, type, timeMode = "stored", expanded, onToggle }: { value: CellValue; type?: string; timeMode?: TimeMode; expanded?: boolean; onToggle?: () => void }) {
  if (value === null)
    return (
      <span className="rounded-sm bg-muted px-1 text-[11px] font-medium text-muted-foreground" aria-label="NULL">
        NULL
      </span>
    );
  if (isBoolean(type))
    return value === "true" ? (
      <span aria-label="true">✓</span>
    ) : (
      <span className="text-muted-foreground" aria-label="false">
        –
      </span>
    );
  if (isJson(type) || (!type && /^[[{]/.test(value))) {
    if (expanded) return <pre className="code-block max-w-md whitespace-pre-wrap break-all">{pretty(value)}</pre>;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        className="relative z-10 rounded-sm bg-muted px-1 font-mono text-[12px] text-muted-foreground hover:text-foreground"
        title={value}
        aria-label="Expand JSON"
      >
        {value.startsWith("[") ? "[…]" : "{…}"}
        <span className="ml-1">{value.length > 40 ? `${value.length} chars` : value.slice(0, 40)}</span>
      </button>
    );
  }
  if (isUuid(type, value)) return <span className="mono-value" title={value}>{middle(value, 4)}</span>;
  if (isTime(type)) {
    const t = Date.parse(value.replace(" ", "T"));
    if (timeMode === "relative" && !Number.isNaN(t)) return <span title={value}>{relativeTo(t, Date.now())}</span>;
    return <span className="mono-value" title={Number.isNaN(t) ? value : relativeTo(t, Date.now())}>{value}</span>;
  }
  if (isNumeric(type)) return <span className="tabular-nums">{value}</span>;
  if (type && /^(text|character varying|character|citext|name)\b/.test(type)) return <span title={value.length > 60 ? value : undefined}>{value}</span>;
  return <span className="mono-value" title={value.length > 60 ? value : undefined}>{value}</span>;
}

function pretty(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

interface EditState {
  row: number;
  col: number;
  draft: string;
  pending: boolean;
  error: string | null;
}

/**
 * The table editor's grid and the SQL results grid (D13). A single click selects a cell (⌘C copies
 * its raw value); double-click or Enter edits it inline (Enter saves, Esc cancels); Space or the
 * expand icon opens the row in the Inspector. Arrow keys move. Rows are keyed by primary key.
 */
export function DataGrid({
  columns,
  rows,
  rowKey,
  hidden = [],
  onSave,
  onInspect,
  selected,
  onSelect,
  sort,
  onSort,
  timeMode = "stored",
  label,
  top,
  arrived,
  className,
}: {
  columns: GridColumn[];
  rows: CellValue[][];
  rowKey: (row: CellValue[], index: number) => string;
  /** Column names not shown. */
  hidden?: string[];
  /** Inline edits; omit for read-only grids. Throws with the Postgres message on failure. */
  onSave?: (rowIndex: number, column: GridColumn, value: string) => Promise<void>;
  onInspect?: (rowIndex: number) => void;
  /** Bulk selection by row key. */
  selected?: Set<string>;
  onSelect?: (key: string, on: boolean) => void;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  timeMode?: TimeMode;
  label: string;
  /** A row rendered above the data (the blank insert row). */
  top?: ReactNode;
  /** Keys of rows that just arrived (inserted/changed): highlighted once. */
  arrived?: Set<string>;
  className?: string;
}) {
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const visible = columns.map((c, i) => ({ c, i })).filter(({ c }) => !hidden.includes(c.name));
  const pkIndex = columns.findIndex((c) => c.primaryKey);

  // Keep focus on the active cell so the keyboard keeps working after edits.
  useEffect(() => {
    if (!active || edit) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${active.row}:${active.col}"]`)?.focus({ preventScroll: false });
  }, [active, edit]);

  async function save() {
    if (!edit || !onSave) return;
    const column = columns[edit.col]!;
    const current = rows[edit.row]?.[edit.col] ?? null;
    if (edit.draft === (current ?? "")) return setEdit(null);
    setEdit({ ...edit, pending: true, error: null });
    try {
      await onSave(edit.row, column, edit.draft);
      setEdit(null);
      announce(`Saved ${column.name}`);
    } catch (err) {
      setEdit((e) => (e ? { ...e, pending: false, error: errorMessage(err) } : e));
    }
  }

  function startEdit(row: number, col: number) {
    if (!onSave) return;
    setActive({ row, col });
    setEdit({ row, col, draft: rows[row]?.[col] ?? "", pending: false, error: null });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (edit || !active) return;
    const visibleCols = visible.map((v) => v.i);
    const at = visibleCols.indexOf(active.col);
    const move = (row: number, col: number) => {
      e.preventDefault();
      setActive({ row: Math.max(0, Math.min(rows.length - 1, row)), col });
    };
    if (e.key === "ArrowDown") move(active.row + 1, active.col);
    else if (e.key === "ArrowUp") move(active.row - 1, active.col);
    else if (e.key === "ArrowRight") move(active.row, visibleCols[Math.min(visibleCols.length - 1, at + 1)]!);
    else if (e.key === "ArrowLeft") move(active.row, visibleCols[Math.max(0, at - 1)]!);
    else if (e.key === "Enter" && onSave) {
      e.preventDefault();
      startEdit(active.row, active.col);
    } else if (e.key === " " && onInspect) {
      e.preventDefault();
      onInspect(active.row);
    } else if (e.key === "Escape") setActive(null);
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      const value = rows[active.row]?.[active.col] ?? null;
      void copyText(value ?? "NULL").then(
        () => announce(`Copied ${columns[active.col]!.name}`),
        () => undefined,
      );
    }
  }

  return (
    <div ref={gridRef} className={cn("relative max-h-[calc(100dvh-15rem)] min-h-24 overflow-auto rounded-lg border [scrollbar-width:thin]", className)} onKeyDown={onKeyDown}>
      <table className="w-full caption-bottom border-separate border-spacing-0 text-sm" aria-label={label} role="grid">
        <thead className="sticky top-0 z-20 bg-background">
          <tr>
            {onSelect && <th className="w-8 border-b bg-background px-2" aria-label="Select rows" />}
            {onInspect && <th className="w-8 border-b bg-background" aria-label="Open row" />}
            {visible.map(({ c, i }) => {
              const sorted = sort?.column === c.name;
              const sticky = i === pkIndex;
              return (
                <th
                  key={c.name}
                  scope="col"
                  aria-sort={sorted ? (sort!.desc ? "descending" : "ascending") : undefined}
                  className={cn("h-auto border-b bg-background px-2 py-1.5 text-left align-bottom font-normal whitespace-nowrap first:pl-3", sticky && "sticky left-0 z-10", isNumeric(c.type) && "text-right")}
                >
                  {onSort ? (
                    <button type="button" onClick={() => onSort(c.name)} className="group inline-flex items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" title={`Sort by ${c.name}`}>
                      <HeadLabel c={c} />
                      {sorted ? sort!.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : <ArrowDown className="size-3 opacity-0 group-hover:opacity-40" aria-hidden />}
                    </button>
                  ) : (
                    <HeadLabel c={c} />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {top}
          {rows.map((row, r) => {
            const key = rowKey(row, r);
            const isSelected = selected?.has(key) ?? false;
            return (
              <tr key={key} data-state={isSelected ? "selected" : undefined} className={cn("group/row", arrived?.has(key) && "animate-arrive", isSelected && "bg-selected")}>
                {onSelect && (
                  <td className="border-b px-2">
                    <Checkbox checked={isSelected} onCheckedChange={(v) => onSelect(key, v === true)} aria-label={`Select row ${r + 1}`} className={cn(!isSelected && "opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100", selected && selected.size > 0 && "opacity-100")} />
                  </td>
                )}
                {onInspect && (
                  <td className="border-b px-0.5">
                    <button type="button" onClick={() => onInspect(r)} aria-label={`Open row ${r + 1}`} title="Open row (Space)" className="grid size-7 place-items-center rounded-sm text-muted-foreground opacity-50 outline-none hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:opacity-100">
                      <Expand className="size-3.5" />
                    </button>
                  </td>
                )}
                {visible.map(({ c, i }) => {
                  const value = row[i] ?? null;
                  const isActive = active?.row === r && active.col === i;
                  const editing = edit?.row === r && edit.col === i;
                  const cellKey = `${key}:${i}`;
                  return (
                    <td
                      key={c.name}
                      data-cell={`${r}:${i}`}
                      tabIndex={isActive || (!active && r === 0 && i === visible[0]?.i) ? 0 : -1}
                      aria-selected={isActive}
                      onClick={() => setActive({ row: r, col: i })}
                      onDoubleClick={() => startEdit(r, i)}
                      className={cn(
                        "relative h-9 max-w-80 border-b px-2 align-middle whitespace-nowrap outline-none first:pl-3",
                        !editing && "truncate",
                        i === pkIndex && "sticky left-0 z-10 bg-background group-data-[state=selected]/row:bg-selected",
                        isNumeric(c.type) && "text-right",
                        isActive && !editing && "ring-2 ring-primary/60 ring-inset",
                        editing && "p-0",
                      )}
                    >
                      {editing ? (
                        <InlineEditor
                          edit={edit!}
                          column={c}
                          onChange={(draft) => setEdit({ ...edit!, draft, error: null })}
                          onSave={() => void save()}
                          onCancel={() => setEdit(null)}
                        />
                      ) : (
                        <Cell
                          value={value}
                          type={c.type}
                          timeMode={timeMode}
                          expanded={expanded.has(cellKey)}
                          onToggle={() =>
                            setExpanded((s) => {
                              const n = new Set(s);
                              if (n.has(cellKey)) n.delete(cellKey);
                              else n.add(cellKey);
                              return n;
                            })
                          }
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HeadLabel({ c }: { c: GridColumn }) {
  return (
    <span className="grid">
      <span className="flex items-center gap-1 font-mono text-xs text-foreground">
        {c.primaryKey && <KeyRound className="size-3 text-muted-foreground" aria-label="Primary key" />}
        {c.name}
      </span>
      {c.type && <span className="font-mono text-[11px] text-muted-foreground">{c.type}</span>}
    </span>
  );
}

function InlineEditor({ edit, column, onChange, onSave, onCancel }: { edit: EditState; column: GridColumn; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="relative">
      <input
        ref={ref}
        value={edit.draft}
        disabled={edit.pending}
        aria-label={`Edit ${column.name}`}
        aria-invalid={edit.error ? true : undefined}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => !edit.pending && !edit.error && onCancel()}
        className={cn(
          "h-9 w-full min-w-40 bg-background px-2 font-mono text-base outline-none ring-2 ring-primary ring-inset md:text-[13px]",
          edit.error && "ring-destructive",
          isNumeric(column.type) && "text-right",
        )}
      />
      {edit.pending && <span className="absolute top-1/2 right-2 size-1.5 -translate-y-1/2 rounded-full bg-info motion-safe:animate-progress" aria-label="Saving" />}
      {edit.error && (
        <p role="alert" className="absolute top-full left-0 z-30 mt-1 w-max max-w-sm rounded-md border border-destructive/40 bg-background p-2 text-xs whitespace-normal text-destructive shadow-md">
          {edit.error} <span className="text-muted-foreground">Esc to cancel.</span>
        </p>
      )}
    </div>
  );
}

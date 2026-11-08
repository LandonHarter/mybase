import { useState, type FormEvent } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import type { Column, RowValues, TableRows, TableSummary } from "@mybase/shared";
import { Inspector } from "@/components/inspector";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isBoolean, isJson, isNumeric } from "@/pages/database/grid";

/** Each field's explicit choice (DB06): the column default (inserts only), NULL, or a value. */
type Choice = "default" | "null" | "value";
interface Field {
  choice: Choice;
  value: string;
}

const isLong = (type: string) => /^(text|json|jsonb|xml|character varying$)/.test(type) || type.endsWith("[]");

function initial(columns: Column[], row: RowValues | null): Record<string, Field> {
  return Object.fromEntries(
    columns.map((c) => {
      if (!row) return [c.name, { choice: c.default !== null ? "default" : c.nullable ? "null" : "value", value: "" }];
      const v = row[c.name] ?? null;
      return [c.name, { choice: v === null ? "null" : "value", value: v ?? "" }];
    }),
  );
}

/** "Not valid JSON: Unexpected token…" or null. */
function jsonError(value: string) {
  try {
    JSON.parse(value);
    return null;
  } catch (err) {
    return `Not valid JSON: ${(err as Error).message}`;
  }
}

/**
 * The row Inspector (DB06): typed controls with an explicit Default / NULL / Value choice per
 * column, JSON validated and formattable, a text fallback for everything else. Inserts send only
 * fields set to a value or NULL, so the rest get their defaults.
 */
export function RowInspector({
  project,
  table,
  data,
  row,
  open,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  project: string;
  table: TableSummary;
  data: TableRows;
  /** null = insert a new row. */
  row: RowValues | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const [fields, setFields] = useState<Record<string, Field>>(() => initial(data.columns, row));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pk = data.columns.filter((c) => c.primaryKey);
  const id = row ? pk.map((c) => `${c.name}=${row[c.name] ?? "NULL"}`).join(", ") : `New row in ${table.schema}.${table.name}`;
  const set = (name: string, patch: Partial<Field>) => setFields((f) => ({ ...f, [name]: { ...f[name]!, ...patch } }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const values: RowValues = {};
    for (const c of data.columns) {
      const f = fields[c.name]!;
      if (f.choice === "value" && isJson(c.type) && f.value.trim() && jsonError(f.value)) return setError(`${c.name}: ${jsonError(f.value)}`);
      const next = f.choice === "null" ? null : f.choice === "value" ? f.value : undefined;
      if (next === undefined) continue;
      if (row ? next !== (row[c.name] ?? null) : true) values[c.name] = next;
    }
    if (row && Object.keys(values).length === 0) return onOpenChange(false);
    setPending(true);
    setError(null);
    try {
      if (row) {
        const key = Object.fromEntries(pk.map((c) => [c.name, row[c.name] ?? null]));
        await api.updateRow(project, table.schema, table.name, { key, values });
      } else {
        await api.insertRow(project, table.schema, table.name, { values });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Inspector
      open={open}
      onOpenChange={onOpenChange}
      kind={row ? `Row in ${table.schema}.${table.name}` : "Insert row"}
      identifier={id}
      wide
      description={row ? "Values use Postgres' text format. Only changed fields are saved." : "Fields left on Default get the column's default."}
      actions={
        <>
          {row && onDelete && (
            <Button type="button" variant="danger-outline" className="mr-auto" onClick={onDelete}>
              <Trash2 />
              Delete row…
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="row-form" disabled={pending}>
            {pending ? "Saving…" : row ? "Save" : "Insert"}
          </Button>
        </>
      }
    >
      <form id="row-form" onSubmit={submit} className="grid gap-5">
        {data.columns.map((c, i) => {
          const f = fields[c.name]!;
          const fid = `rf-${i}`;
          const options: { value: Choice; label: string }[] = [
            ...(!row && c.default !== null ? [{ value: "default" as const, label: "Default" }] : []),
            ...(c.nullable ? [{ value: "null" as const, label: "NULL" }] : []),
            { value: "value", label: "Value" },
          ];
          const json = isJson(c.type);
          const jErr = json && f.choice === "value" && f.value.trim() ? jsonError(f.value) : null;
          return (
            <div key={c.name} className="grid gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={fid} className="flex items-center gap-1.5 font-medium">
                  {c.primaryKey && <KeyRound className="size-3.5 text-muted-foreground" aria-label="Primary key" />}
                  {c.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground">{c.type}</span>
                </label>
                {options.length > 1 && <SegmentedControl size="xs" label={`${c.name} value`} value={f.choice} options={options} onChange={(choice) => set(c.name, { choice })} />}
              </div>
              {f.choice === "default" && <p className="font-mono text-xs text-muted-foreground">Default: {c.default}</p>}
              {f.choice === "null" && <p className="text-xs text-muted-foreground">NULL</p>}
              {f.choice === "value" &&
                (isBoolean(c.type) ? (
                  <label className="flex items-center gap-2">
                    <Switch id={fid} checked={f.value === "true"} onCheckedChange={(on) => set(c.name, { value: on ? "true" : "false" })} />
                    <span className="font-mono text-[13px]">{f.value === "true" ? "true" : "false"}</span>
                  </label>
                ) : c.type === "date" ? (
                  <Input id={fid} type="date" value={f.value} onChange={(e) => set(c.name, { value: e.target.value })} className="w-48 font-mono md:text-[13px]" />
                ) : isLong(c.type) ? (
                  <>
                    <Textarea
                      id={fid}
                      value={f.value}
                      rows={json ? 6 : 2}
                      spellCheck={false}
                      aria-invalid={jErr ? true : undefined}
                      onChange={(e) => set(c.name, { value: e.target.value })}
                      className={cn("font-mono text-base md:text-[13px]", jErr && "border-destructive")}
                    />
                    {json && (
                      <div className="flex items-center gap-2 text-xs">
                        {jErr ? <span className="text-destructive">{jErr}</span> : <span className="text-muted-foreground">{f.value.trim() ? "Valid JSON" : ""}</span>}
                        <Button type="button" size="xs" variant="ghost" className="ml-auto" disabled={!!jErr || !f.value.trim()} onClick={() => set(c.name, { value: JSON.stringify(JSON.parse(f.value), null, 2) })}>
                          Format
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <Input
                    id={fid}
                    value={f.value}
                    inputMode={isNumeric(c.type) ? "decimal" : undefined}
                    spellCheck={false}
                    onChange={(e) => set(c.name, { value: e.target.value })}
                    className="font-mono text-base md:text-[13px]"
                  />
                ))}
            </div>
          );
        })}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </form>
    </Inspector>
  );
}

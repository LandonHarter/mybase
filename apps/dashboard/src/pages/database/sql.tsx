import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BookmarkPlus, ChevronRight, Copy, Download, History, PanelLeftClose, PanelLeftOpen, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Project, QueryError, QueryResult } from "@mybase/shared";
import { Facts, Inspector } from "@/components/inspector";
import { Badge, Mono } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useCommands } from "@/lib/commands";
import { plural } from "@/lib/format";
import { RUN_SHORTCUT } from "@/lib/keys";
import { useLoad } from "@/lib/load";
import { cn } from "@/lib/utils";
import { DataGrid } from "@/pages/database/grid";
import { DatabaseLayout } from "@/pages/database/layout";

// D21: the draft and history stay in this tab's sessionStorage (SQL can hold secrets or personal
// data), bounded, with a visible Clear, and never go to the server. Saved snippets are explicit.
const draftKey = (p: string) => `mybase.sql.${p}`;
const historyKey = (p: string) => `mybase.sql.history.${p}`;
const snippetsKey = (p: string) => `mybase.sql.snippets.${p}`;
const prefillKey = (p: string) => `mybase.sql.prefill.${p}`;
const HISTORY_MAX = 30;
const SNIPPETS_MAX = 50;

interface HistoryEntry {
  sql: string;
  at: string;
  ok: boolean;
}

function read<T>(store: () => Storage, key: string, fallback: T): T {
  try {
    const v = store().getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(store: () => Storage, key: string, value: unknown) {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: kept for this visit only.
  }
}
const session = () => sessionStorage;
const local = () => localStorage;

/** Puts `sql` in the project's editor without running it ("Query in SQL", "Open example"). */
export function prefillSql(project: string, sql: string) {
  write(session, prefillKey(project), sql);
}

/** "line 3, column 7" for Postgres' 1-based character offset. */
function where(sql: string, position: number) {
  const before = sql.slice(0, position - 1);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

type Outcome = { kind: "results"; results: QueryResult[]; ms: number; sql: string; at: string } | { kind: "error"; error: QueryError; sql: string; ms: number; at: string };

function summary(r: QueryResult) {
  if (r.command === "SELECT" || (r.columns.length > 0 && !r.command)) return `${r.command || "Result"} · ${plural(r.rowCount, "row", "rows")}`;
  return `${r.command} · ${plural(r.rowCount, "row affected", "rows affected")}`;
}

function toCsv(r: QueryResult) {
  const esc = (v: string | null) => (v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [r.columns.map(esc).join(","), ...r.rows.map((row) => row.map(esc).join(","))].join("\n");
}
const toJson = (r: QueryResult) => JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null]))), null, 2);
function toMarkdown(r: QueryResult) {
  const cell = (v: string | null) => (v ?? "NULL").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${r.columns.map(cell).join(" | ")} |`, `| ${r.columns.map(() => "---").join(" | ")} |`, ...r.rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

function ResultView({ result, onInspect }: { result: QueryResult; onInspect: (row: number) => void }) {
  async function copy(kind: "csv" | "json" | "md") {
    try {
      await copyText(kind === "csv" ? toCsv(result) : kind === "json" ? toJson(result) : toMarkdown(result));
      toast.success(`Copied ${plural(result.rows.length, "row", "rows")} as ${kind === "md" ? "Markdown" : kind.toUpperCase()}`);
    } catch {
      toast.error("Couldn't copy. Use Download CSV instead.");
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "query.csv" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground">
          {summary(result)}
          {result.truncated && <> · showing the first {result.rows.length.toLocaleString()}</>}
        </p>
        {result.columns.length > 0 && (
          <div className="ml-auto flex gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Copy />
                  Copy
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copy("csv")}>As CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy("json")}>As JSON</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy("md")}>As Markdown</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" onClick={download}>
              <Download />
              Download CSV
            </Button>
          </div>
        )}
      </div>
      {result.columns.length > 0 && <DataGrid label="Query results" columns={result.columns.map((name) => ({ name }))} rows={result.rows} rowKey={(_, i) => String(i)} onInspect={onInspect} className="max-h-[60dvh]" />}
    </section>
  );
}

/** The schema sidebar: tables and their columns; click inserts the name, Shift-click a SELECT. */
function SchemaList({ project, onInsert }: { project: string; onInsert: (text: string) => void }) {
  const schema = useLoad(`schema:${project}`, () => api.databaseSchema(project), { maxAge: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (schema.state.status === "loading") return <p className="px-2 text-muted-foreground">Loading…</p>;
  if (schema.state.status === "error")
    return (
      <p className="px-2 text-muted-foreground">
        Couldn't load the schema.{" "}
        <button type="button" className="underline" onClick={() => void schema.refresh()}>
          Retry
        </button>
      </p>
    );
  const tables = schema.state.data;
  if (tables.length === 0) return <p className="px-2 text-muted-foreground">No tables yet.</p>;
  return (
    <ul className="grid gap-0.5">
      {tables.map((t) => {
        const id = `${t.schema}.${t.name}`;
        const label = t.schema === "public" ? t.name : id;
        return (
          <li key={id}>
            <div className="flex items-center">
              <button type="button" aria-expanded={open === id} aria-label={`Columns of ${label}`} className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === id ? null : id)}>
                <ChevronRight className={cn("size-3.5", open === id && "rotate-90")} />
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded-sm px-1 text-left font-mono text-[13px] hover:bg-accent"
                title="Click to insert the name; Shift-click for a SELECT"
                onClick={(e) => onInsert(e.shiftKey ? `select * from ${label} limit 50;` : label)}
              >
                {label}
              </button>
            </div>
            {open === id && (
              <ul className="ml-6 grid">
                {t.columns.map((c) => (
                  <li key={c.name}>
                    <button type="button" className="flex w-full items-baseline gap-2 rounded-sm px-1 text-left hover:bg-accent" onClick={() => onInsert(c.name)}>
                      <span className="truncate font-mono text-[12px]">{c.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{c.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SqlTab({ project }: { project: Project }) {
  const name = project.name;
  const [sql, setSql] = useState(() => {
    const prefill = read<string | null>(session, prefillKey(name), null);
    if (prefill !== null) write(session, prefillKey(name), null);
    return prefill ?? read<string>(session, draftKey(name), "");
  });
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tab, setTab] = useState(0);
  const [inspect, setInspect] = useState<{ result: number; row: number } | null>(null);
  const [side, setSide] = useState<"schema" | "history" | "snippets" | null>("schema");
  const [history, setHistory] = useState<HistoryEntry[]>(() => read(session, historyKey(name), []));
  const [snippets, setSnippets] = useState<{ name: string; sql: string }[]>(() => read(local, snippetsKey(name), []));
  const editor = useRef<HTMLTextAreaElement>(null);
  const tables = useLoad(`tables:${name}`, () => api.listTables(name), { maxAge: 60_000 });
  const firstTable = tables.data?.find((t) => t.kind === "table");
  const placeholder = firstTable ? `select * from ${firstTable.schema === "public" ? firstTable.name : `${firstTable.schema}.${firstTable.name}`} limit 10;` : "select now();";

  useEffect(() => write(session, draftKey(name), sql), [name, sql]);

  async function run(selectionOnly = false) {
    const el = editor.current;
    const selected = el && el.selectionStart !== el.selectionEnd ? sql.slice(el.selectionStart, el.selectionEnd) : "";
    // Capture what ran before awaiting: results are labelled with it, even if the draft changes.
    const text = selectionOnly && selected.trim() ? selected : sql;
    if (!text.trim() || running) return;
    setRunning(true);
    const start = performance.now();
    const at = new Date().toISOString();
    let ok = true;
    try {
      const { results } = await api.runQuery(name, text);
      setOutcome({ kind: "results", results, ms: performance.now() - start, sql: text, at });
      setTab(0);
    } catch (err) {
      ok = false;
      const error: QueryError = err instanceof ApiError && err.body ? (err.body as QueryError) : { error: errorMessage(err) };
      setOutcome({ kind: "error", error, sql: text, ms: performance.now() - start, at });
      // DB15: select the error's position in the editor (when it ran the whole draft).
      if (error.position && text === sql && el) {
        const pos = error.position - 1;
        const end = Math.max(pos + 1, sql.slice(pos).search(/[\s,;)]|$/) + pos);
        el.focus();
        el.setSelectionRange(pos, end);
      }
    } finally {
      setRunning(false);
      const next = [{ sql: text, at, ok }, ...history.filter((h) => h.sql !== text)].slice(0, HISTORY_MAX);
      setHistory(next);
      write(session, historyKey(name), next);
    }
  }

  function insertAtCursor(text: string) {
    const el = editor.current;
    if (!el) return setSql((s) => s + text);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = sql.slice(0, start) + text + sql.slice(end);
    setSql(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run(e.shiftKey);
    } else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Tab indents two spaces; Esc releases focus so Tab can leave the editor again.
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      if (e.shiftKey) {
        const lineStart = sql.lastIndexOf("\n", start - 1) + 1;
        if (sql.slice(lineStart, lineStart + 2) === "  ") {
          setSql(sql.slice(0, lineStart) + sql.slice(lineStart + 2));
          requestAnimationFrame(() => el.setSelectionRange(Math.max(lineStart, start - 2), Math.max(lineStart, start - 2)));
        }
      } else insertAtCursor("  ");
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }

  function saveSnippet() {
    const label = window.prompt("Name this snippet", sql.trim().split("\n")[0]!.slice(0, 40));
    if (!label) return;
    const next = [{ name: label, sql }, ...snippets.filter((s) => s.name !== label)].slice(0, SNIPPETS_MAX);
    setSnippets(next);
    write(local, snippetsKey(name), next);
    toast.success(`Saved ${label}`);
  }

  useCommands([
    { id: "run-sql", label: "Run SQL", icon: Play, shortcut: RUN_SHORTCUT, run: () => void run() },
    { id: "save-snippet", label: "Save SQL as a snippet", icon: BookmarkPlus, run: saveSnippet },
  ]);

  const runButton = (
    <Button onClick={() => void run()} disabled={running || !sql.trim()}>
      <Play />
      {running ? "Running…" : "Run"}
      <kbd className="ml-1 font-sans text-xs opacity-70 max-md:hidden">{RUN_SHORTCUT}</kbd>
    </Button>
  );

  const stale = outcome && outcome.sql !== sql;
  const results = outcome?.kind === "results" ? outcome.results : [];
  const shown = results[tab] ?? results[0];
  const inspected = inspect && outcome?.kind === "results" ? outcome.results[inspect.result] : null;

  return (
    <DatabaseLayout project={project} tab="sql" action={runButton}>
      <div className={cn("grid gap-6", side ? "lg:grid-cols-[15rem_minmax(0,1fr)]" : "")}>
        {side && (
          <aside className="grid content-start gap-2 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto" aria-label="SQL helpers">
            <SegmentedControl
              label="SQL helpers"
              size="xs"
              className="w-fit"
              value={side}
              onChange={setSide}
              options={[
                { value: "schema", label: "Schema" },
                { value: "history", label: `History${history.length ? ` ${history.length}` : ""}` },
                { value: "snippets", label: `Saved${snippets.length ? ` ${snippets.length}` : ""}` },
              ]}
            />
            {side === "schema" && <SchemaList project={name} onInsert={insertAtCursor} />}
            {side === "history" && (
              <div className="grid gap-1">
                <p className="text-xs text-muted-foreground">This tab only, last {HISTORY_MAX}. Never sent to the server.</p>
                {history.length === 0 && <p className="text-muted-foreground">Queries you run show up here.</p>}
                {history.map((h) => (
                  <button key={h.at} type="button" className="grid rounded-sm px-1 py-1 text-left hover:bg-accent" onClick={() => setSql(h.sql)} title={h.sql}>
                    <span className={cn("truncate font-mono text-[12px]", !h.ok && "text-destructive")}>{h.sql.trim().split("\n")[0]}</span>
                    <TimeAgo iso={h.at} className="text-xs text-muted-foreground" />
                  </button>
                ))}
                {history.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit text-muted-foreground"
                    onClick={() => {
                      setHistory([]);
                      write(session, historyKey(name), null);
                    }}
                  >
                    <Trash2 />
                    Clear history
                  </Button>
                )}
              </div>
            )}
            {side === "snippets" && (
              <div className="grid gap-1">
                <p className="text-xs text-muted-foreground">Kept in this browser, up to {SNIPPETS_MAX}.</p>
                {snippets.length === 0 && <p className="text-muted-foreground">Save a query to reuse it.</p>}
                {snippets.map((s) => (
                  <div key={s.name} className="group flex items-center">
                    <button type="button" className="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left hover:bg-accent" onClick={() => setSql(s.sql)} title={s.sql}>
                      {s.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove snippet ${s.name}`}
                      onClick={() => {
                        const next = snippets.filter((x) => x.name !== s.name);
                        setSnippets(next);
                        write(local, snippetsKey(name), next);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="icon-sm" aria-label={side ? "Hide schema and history" : "Show schema and history"} onClick={() => setSide(side ? null : "schema")}>
                {side ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
              {!side && (
                <Button variant="ghost" size="sm" onClick={() => setSide("history")}>
                  <History />
                  History
                </Button>
              )}
              {/* DB14: what the editor runs as, instead of a paragraph. */}
              <span className="flex flex-wrap gap-1.5">
                {[
                  { label: `role: ${project.database.user}`, tip: "Runs as the project's own Postgres role: the same permissions your app has." },
                  { label: "1 transaction", tip: "All statements run in one transaction: if one fails, nothing is saved." },
                  { label: "15 s timeout", tip: "Queries stop after 15 seconds." },
                ].map((c) => (
                  <Tooltip key={c.label}>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                        <Badge tone="outline" mono>
                          {c.label}
                        </Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">{c.tip}</TooltipContent>
                  </Tooltip>
                ))}
              </span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={saveSnippet} disabled={!sql.trim()}>
                <BookmarkPlus />
                Save
              </Button>
            </div>
            <Textarea
              ref={editor}
              aria-label="SQL"
              aria-describedby="sql-help"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={placeholder}
              className="min-h-48 resize-y font-mono text-base leading-5 md:text-[13px]"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <p id="sql-help" className="text-xs text-muted-foreground">
              {RUN_SHORTCUT} runs all, Shift+{RUN_SHORTCUT} runs the selection. Tab indents; Esc leaves the editor.
            </p>
          </div>

          {outcome && (
            <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
              <span className={cn("font-medium", outcome.kind === "error" && "text-destructive")}>
                {outcome.kind === "error" ? "Failed" : results.map(summary).join(" · ") || "Done"} · {Math.round(outcome.ms)} ms
              </span>
              <span className="text-muted-foreground">
                · <TimeAgo iso={outcome.at} />
              </span>
              {stale && <Badge tone="warning">Results from a previous query</Badge>}
              <Mono className="max-w-full truncate text-xs text-muted-foreground" title={outcome.sql}>
                {outcome.sql.trim().split("\n")[0]}
              </Mono>
            </div>
          )}

          {outcome?.kind === "error" && (
            <div role="alert" className="rounded-lg border border-destructive/50 p-4">
              <p className="font-medium text-destructive">{outcome.error.error}</p>
              {outcome.error.position && <p className="mt-1 text-muted-foreground">At {where(outcome.sql, outcome.error.position)}</p>}
              {outcome.error.detail && <p className="mt-1 text-muted-foreground">{outcome.error.detail}</p>}
              {outcome.error.hint && <p className="mt-1 text-muted-foreground">Hint: {outcome.error.hint}</p>}
            </div>
          )}

          {outcome?.kind === "results" && results.length > 1 && (
            <div role="tablist" aria-label="Results" className="flex gap-1 overflow-x-auto border-b">
              {results.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === tab}
                  onClick={() => setTab(i)}
                  className={cn("-mb-px border-b-2 border-transparent px-3 py-1.5 whitespace-nowrap text-muted-foreground", i === tab && "border-primary font-medium text-foreground")}
                >
                  {i + 1}. {r.command || "Result"}
                </button>
              ))}
            </div>
          )}
          {shown && <ResultView key={tab} result={shown} onInspect={(row) => setInspect({ result: tab, row })} />}
        </div>
      </div>
      {inspected && inspect && (
        <Inspector open onOpenChange={(o) => !o && setInspect(null)} kind="Result row" identifier={`Row ${inspect.row + 1}`} copyValue={JSON.stringify(Object.fromEntries(inspected.columns.map((c, i) => [c, inspected.rows[inspect.row]?.[i] ?? null])), null, 2)} wide>
          <Facts items={inspected.columns.map((c, i) => [<Mono key={c}>{c}</Mono>, <span key={`${c}v`} className="font-mono text-[13px] whitespace-pre-wrap">{inspected.rows[inspect.row]?.[i] ?? <span className="text-muted-foreground">NULL</span>}</span>])} />
        </Inspector>
      )}
    </DatabaseLayout>
  );
}

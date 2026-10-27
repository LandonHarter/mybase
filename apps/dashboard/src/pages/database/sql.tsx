import { useEffect, useState, type KeyboardEvent } from "react";
import { Play } from "lucide-react";
import type { Project, QueryError, QueryResult } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { RUN_SHORTCUT } from "@/lib/keys";
import { errorMessage } from "@/lib/load";
import { DatabaseLayout } from "@/pages/database/layout";

// The draft survives reloads and tab switches, per project. Storage can be unavailable (private mode).
const draftKey = (project: string) => `mybase.sql.${project}`;
function loadDraft(project: string) {
  try {
    return localStorage.getItem(draftKey(project)) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(project: string, sql: string) {
  try {
    localStorage.setItem(draftKey(project), sql);
  } catch {
    // Not critical: the draft just won't survive a reload.
  }
}

/** "line 3, column 7" for Postgres' 1-based character offset. */
function where(sql: string, position: number) {
  const before = sql.slice(0, position - 1);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

type Outcome = { kind: "results"; results: QueryResult[]; ms: number } | { kind: "error"; error: QueryError; sql: string };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function ResultTable({ result }: { result: QueryResult }) {
  const summary = result.command
    ? `${result.command} · ${plural(result.rowCount, "row", "rows")}`
    : result.columns.length === 0
      ? "No rows"
      : plural(result.rowCount, "row", "rows");
  return (
    <section className="grid gap-2">
      <p className="text-muted-foreground">
        {summary}
        {result.truncated && ` (showing the first ${result.rows.length.toLocaleString()})`}
      </p>
      {result.columns.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {result.columns.map((c, i) => (
                  <TableHead key={i} className="font-mono text-xs text-muted-foreground">
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row, i) => (
                <TableRow key={i}>
                  {row.map((value, j) => (
                    <TableCell key={j} className="max-w-80 truncate font-mono text-xs" title={value ?? "NULL"}>
                      {value ?? <span className="text-muted-foreground italic">NULL</span>}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function SqlTab({ project }: { project: Project }) {
  const [sql, setSql] = useState(() => loadDraft(project.name));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => saveDraft(project.name, sql), [project.name, sql]);

  async function run() {
    if (!sql.trim() || running) return;
    setRunning(true);
    const start = performance.now();
    try {
      const { results } = await api.runQuery(project.name, sql);
      setOutcome({ kind: "results", results, ms: performance.now() - start });
    } catch (err) {
      const error: QueryError = err instanceof ApiError && err.body ? (err.body as QueryError) : { error: errorMessage(err) };
      setOutcome({ kind: "error", error, sql });
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  }

  const runButton = (
    <Button onClick={run} disabled={running || !sql.trim()}>
      <Play />
      {running ? "Running…" : "Run"}
      <kbd className="ml-1 font-sans text-xs opacity-70 max-md:hidden">{RUN_SHORTCUT}</kbd>
    </Button>
  );

  return (
    <DatabaseLayout project={project} tab="sql" action={runButton}>
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Textarea
            aria-label="SQL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="select * from my_table limit 10;"
            className="min-h-48 font-mono text-xs md:text-xs"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <p className="text-muted-foreground">
            Runs as the project's own role, in one transaction: if a statement fails, nothing is saved. Stops after 15 seconds.
          </p>
        </div>

        {outcome?.kind === "error" && (
          <div role="alert" className="rounded-lg border border-destructive/50 p-4">
            <p className="font-medium text-destructive">{outcome.error.error}</p>
            {outcome.error.position && <p className="mt-1 text-muted-foreground">At {where(outcome.sql, outcome.error.position)}</p>}
            {outcome.error.detail && <p className="mt-1 text-muted-foreground">{outcome.error.detail}</p>}
            {outcome.error.hint && <p className="mt-1 text-muted-foreground">Hint: {outcome.error.hint}</p>}
          </div>
        )}

        {outcome?.kind === "results" && (
          <div className="grid gap-6" aria-live="polite">
            <p className="sr-only">Query finished in {Math.round(outcome.ms)} ms</p>
            {outcome.results.map((result, i) => (
              <ResultTable key={i} result={result} />
            ))}
          </div>
        )}
      </div>
    </DatabaseLayout>
  );
}

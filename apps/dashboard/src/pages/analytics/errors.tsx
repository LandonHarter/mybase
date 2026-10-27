import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AnalyticsErrorGroup, AnalyticsRange } from "@mybase/shared";
import { countryLabel, formatCount, LoadError, LoadingLines, RANGE_LABELS } from "@/components/analytics-parts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { useLoad } from "@/lib/load";

/** The newest occurrence of an error group: where it happened and its stack. */
function Latest({ project, group }: { project: string; group: AnalyticsErrorGroup }) {
  const { state, refresh } = useLoad(`analytics-error:${project}:${group.fingerprint}`, () =>
    api.analyticsEvents(project, { type: "error", fingerprint: group.fingerprint, limit: 1 }),
  );
  if (state.status === "loading") return <LoadingLines label="Loading the latest occurrence" lines={2} />;
  if (state.status === "error") return <LoadError what="this error" message={state.message} onRetry={refresh} />;
  const e = state.data[0];
  if (!e) return <p className="text-muted-foreground">This error is older than the retention period.</p>;
  const where = [e.path, e.browser, e.os, e.country && countryLabel(e.country)].filter(Boolean).join(" · ");
  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground">
        Latest{" "}
        <time dateTime={e.ts} title={formatDate(e.ts)}>
          {timeAgo(e.ts)}
        </time>
        {where && ` · ${where}`}
      </p>
      {e.props && <p className="font-mono text-xs text-muted-foreground">{JSON.stringify(e.props)}</p>}
      <pre className="max-h-80 overflow-auto rounded-md border bg-accent/40 p-3 font-mono text-xs whitespace-pre">{e.stack ?? "No stack trace was sent."}</pre>
    </div>
  );
}

export function AnalyticsErrors({ project, range }: { project: string; range: AnalyticsRange }) {
  const { state, refresh } = useLoad(`analytics:${project}:${range}`, () => api.analyticsOverview(project, range));
  const [open, setOpen] = useState<string | null>(null);

  if (state.status === "loading") return <LoadingLines label="Loading errors" />;
  if (state.status === "error") return <LoadError what="errors" message={state.message} onRetry={refresh} />;
  if (state.data.errors.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No errors in the last {RANGE_LABELS[range]}</p>
        <p className="mt-1 text-muted-foreground">
          The browser client records uncaught errors and unhandled promise rejections. Report others with{" "}
          <code className="font-mono text-[0.85em] text-foreground">captureError(err)</code>.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-muted-foreground">The 10 most frequent errors, grouped by message and top stack frame. Open one to see its latest stack trace.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Error</TableHead>
            <TableHead className="text-right">Count</TableHead>
            <TableHead className="text-right">Visitors</TableHead>
            <TableHead>Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.errors.map((g) => {
            const expanded = open === g.fingerprint;
            return [
              <TableRow key={g.fingerprint}>
                <TableCell className="max-w-lg">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : g.fingerprint)}
                    className="flex w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:underline"
                  >
                    {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                    <span className="truncate font-mono text-xs" title={g.message}>
                      {g.message}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-right">{formatCount(g.count)}</TableCell>
                <TableCell className="text-right">{formatCount(g.visitors)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <time dateTime={g.lastSeen} title={formatDate(g.lastSeen)}>
                    {timeAgo(g.lastSeen)}
                  </time>
                </TableCell>
              </TableRow>,
              expanded && (
                <TableRow key={`${g.fingerprint}:detail`} className="hover:bg-transparent">
                  <TableCell colSpan={4} className="whitespace-normal">
                    <Latest project={project} group={g} />
                  </TableCell>
                </TableRow>
              ),
            ];
          })}
        </TableBody>
      </Table>
    </>
  );
}

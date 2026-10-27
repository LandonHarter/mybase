import { useState } from "react";
import { RotateCw } from "lucide-react";
import type { AnalyticsEventRecord } from "@mybase/shared";
import { countryLabel, LoadError, LoadingLines } from "@/components/analytics-parts";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { cn } from "@/lib/utils";

type Filter = AnalyticsEventRecord["type"] | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pageview", label: "Page views" },
  { id: "event", label: "Custom events" },
  { id: "error", label: "Errors" },
];

const TYPE_LABELS: Record<AnalyticsEventRecord["type"], string> = { pageview: "Page view", event: "Event", error: "Error" };

/** Browser · OS · device · country, skipping what's unknown. */
const describeClient = (e: AnalyticsEventRecord) => [e.browser, e.os, e.device, e.country && countryLabel(e.country)].filter(Boolean).join(" · ");

function What({ event }: { event: AnalyticsEventRecord }) {
  if (event.type === "pageview") return <span className="font-mono text-xs">{event.path}</span>;
  return (
    <>
      <span className={cn("block max-w-md truncate", event.type === "error" && "font-mono text-xs")} title={event.name ?? undefined}>
        {event.name}
      </span>
      {event.path && <span className="block font-mono text-xs text-muted-foreground">{event.path}</span>}
    </>
  );
}

export function AnalyticsEvents({ project }: { project: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const { state, refresh } = useLoad(`analytics-events:${project}:${filter}`, () =>
    api.analyticsEvents(project, { type: filter === "all" ? undefined : filter, limit: 100 }),
  );

  return (
    <section aria-label="Recent events">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Event type" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button key={f.id} variant={f.id === filter ? "secondary" : "ghost"} size="sm" aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
              {f.label}
            </Button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RotateCw />
          Refresh
        </Button>
      </div>
      {state.status === "loading" && <LoadingLines label="Loading events" />}
      {state.status === "error" && <LoadError what="events" message={state.message} onRetry={refresh} />}
      {state.status === "ready" && state.data.length === 0 && (
        <div className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">No events</p>
          <p className="mt-1 text-muted-foreground">The newest 100 events of this kind show here as they arrive.</p>
        </div>
      )}
      {state.status === "ready" && state.data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Visitor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap">
                  <time dateTime={e.ts} title={formatDate(e.ts)}>
                    {timeAgo(e.ts)}
                  </time>
                </TableCell>
                <TableCell>{TYPE_LABELS[e.type]}</TableCell>
                <TableCell className="max-w-md">
                  <What event={e} />
                  {e.props && (
                    <span className="block max-w-md truncate font-mono text-xs text-muted-foreground" title={JSON.stringify(e.props)}>
                      {Object.entries(e.props)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(" ")}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="block">{describeClient(e) || "Unknown"}</span>
                  {e.referrer && <span className="block text-muted-foreground">from {e.referrer}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

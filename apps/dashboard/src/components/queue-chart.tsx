import { useState } from "react";
import type { QueueStatsPoint } from "@mybase/shared";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SERIES = [
  { value: "sent", label: "Sent", color: "bg-chart-1" },
  { value: "received", label: "Received", color: "bg-chart-2" },
  { value: "deleted", label: "Deleted", color: "bg-chart-3" },
  { value: "dead", label: "Dead-lettered", color: "bg-destructive" },
] as const;
const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZoneName: "short",
  });

/** Independent series: sending and dead-lettering are operations, never parts of one total. */
export function QueueChart({ series }: { series: QueueStatsPoint[] }) {
  const [metric, setMetric] = useState<(typeof SERIES)[number]["value"]>("sent");
  const [selected, setSelected] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const picked = SERIES.find((s) => s.value === metric)!;
  const max = Math.max(1, ...series.map((p) => p[metric]));
  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-center gap-3">
        <SegmentedControl label="Queue operations" value={metric} options={SERIES.map(({ value, label }) => ({ value, label }))} onChange={setMetric} />
        <Button variant="ghost" size="sm" onClick={() => setTable(!table)} aria-expanded={table}>
          {table ? "Hide data table" : "View data table"}
        </Button>
      </figcaption>
      <p className="mb-2 text-xs text-muted-foreground">
        Operations per hour · {Intl.DateTimeFormat().resolvedOptions().timeZone} · peak {max}
      </p>
      <div className="flex h-32 items-end gap-px border-b">
        {series.map((point, i) => (
          <button
            key={point.t}
            type="button"
            className="flex h-full min-w-0 flex-1 items-end rounded-t focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${time(point.t)}: ${point[metric]} ${picked.label.toLowerCase()}`}
            onFocus={() => setSelected(i)}
            onMouseEnter={() => setSelected(i)}
            onClick={() => setSelected(i)}
          >
            <span
              className={cn("w-full rounded-t", picked.color)}
              style={{
                height: point[metric] ? `${Math.max(2, (point[metric] / max) * 100)}%` : "1px",
              }}
            />
          </button>
        ))}
      </div>
      <p className="my-2 min-h-5 text-xs text-muted-foreground">
        {selected !== null && series[selected]
          ? `${time(series[selected]!.t)} · ${series[selected]![metric]} ${picked.label.toLowerCase()}`
          : "Focus or select an hour to inspect it."}
      </p>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{series[0] && time(series[0].t)}</span>
        <span>{series.at(-1) && time(series.at(-1)!.t)}</span>
      </div>
      {table && (
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <caption>Queue operations per hour</caption>
            <thead>
              <tr>
                <th>Hour</th>
                {SERIES.map((s) => (
                  <th key={s.value} className="text-right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.t}>
                  <td>{time(p.t)}</td>
                  {SERIES.map((s) => (
                    <td className="text-right" key={s.value}>
                      {p[s.value]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

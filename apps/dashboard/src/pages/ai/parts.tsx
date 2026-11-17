import { useState, type ReactNode } from "react";
import { niceMax } from "@/lib/chart";
import { compact, formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

/** USD with enough digits for fractions of a cent. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(5)}`;
  if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export const tokens = (n: number) => compact(n);

/** One number on `--surface` (stat tiles may sit there). */
export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-surface p-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="metric">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export interface BarPoint {
  at: string;
  value: number;
  /** Tooltip body. */
  detail: ReactNode;
}

const bucketLabel = (iso: string, bucket: "hour" | "day", long = false) => {
  const d = new Date(iso);
  if (bucket === "hour") return d.toLocaleTimeString(undefined, long ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
  return d.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
};

/** Columns per bucket, one series, with a hover tooltip and a table for screen readers. */
export function BarChart({ points, bucket, label, format = formatCount }: { points: BarPoint[]; bucket: "hour" | "day"; label: string; format?: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...points.map((p) => p.value))) || 1;
  const every = Math.max(1, Math.ceil(points.length / 6));
  const point = hover === null ? null : points[hover];
  return (
    <figure className="m-0">
      <figcaption className="sr-only">{label}</figcaption>
      <div className="relative grid grid-cols-[auto_1fr] gap-x-3">
        <div className="flex h-40 flex-col justify-between text-right text-xs text-muted-foreground" aria-hidden="true">
          <span className="-translate-y-1/2">{format(max)}</span>
          <span className="-translate-y-1/2">{format(max / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative h-40" onMouseLeave={() => setHover(null)}>
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
            <div className="border-t border-dashed" />
            <div className="border-t border-dashed" />
            <div className="border-t" />
          </div>
          <div className="absolute inset-0 flex items-end gap-0.5" aria-hidden="true">
            {points.map((p, i) => (
              <div key={p.at} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <div
                  className={cn("w-full rounded-t-[4px] transition-colors", hover === i ? "bg-foreground" : "bg-chart-1")}
                  style={{ height: p.value === 0 ? 0 : `max(2px, ${(p.value / max) * 100}%)` }}
                />
              </div>
            ))}
          </div>
          {point && hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md"
              style={{ left: `${((hover + 0.5) / points.length) * 100}%`, transform: `translate(${hover > points.length / 2 ? "-100%" : "0"}, -100%)` }}
            >
              <p className="font-medium whitespace-nowrap">{bucketLabel(point.at, bucket, true)}</p>
              <div className="whitespace-nowrap text-muted-foreground">{point.detail}</div>
            </div>
          )}
        </div>
        <div />
        <div className="mt-2 flex gap-0.5 text-xs text-muted-foreground" aria-hidden="true">
          {points.map((p, i) => (
            <span key={p.at} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
              {i % every === 0 ? bucketLabel(p.at, bucket) : ""}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <thead>
          <tr>
            <th>{bucket === "hour" ? "Hour" : "Day"}</th>
            <th>{label}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.at}>
              <td>{bucketLabel(p.at, bucket, true)}</td>
              <td>{format(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Every bucket from `from` to `to`, so gaps show as zero columns. */
export function fillBuckets<T extends { at: string }>(rows: T[], from: string, to: string, bucket: "hour" | "day", empty: (at: string) => T): T[] {
  const step = bucket === "hour" ? 3_600_000 : 86_400_000;
  const start = new Date(from);
  if (bucket === "hour") start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const byAt = new Map(rows.map((r) => [new Date(r.at).getTime(), r]));
  const out: T[] = [];
  for (let t = start.getTime(); t <= new Date(to).getTime(); t += step) out.push(byAt.get(t) ?? empty(new Date(t).toISOString()));
  return out;
}

import { useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import type { AnalyticsCount, AnalyticsOverview, AnalyticsRange } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const numbers = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const regions = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();

export const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

export const formatCount = (n: number) => numbers.format(n);

/** `US` → `🇺🇸 United States`. */
export function countryLabel(code: string): string {
  const flag = /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
  let name = code;
  try {
    name = regions?.of(code) ?? code;
  } catch {
    // not a region code
  }
  return flag ? `${flag} ${name}` : name;
}

/** A failed load, with what to do about it. */
export function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
      <p className="font-medium">Can't load {what}</p>
      <p className="mt-1 text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        <RotateCw />
        Retry
      </Button>
    </div>
  );
}

export function LoadingLines({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full max-w-md" />
      ))}
    </div>
  );
}

/** Change against the previous period, as "+12%" text. Nothing when there's no baseline. */
function Change({ now, before }: { now: number; before: number }) {
  if (before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className="text-muted-foreground" title={`${formatCount(before)} in the previous period`}>
      {pct > 0 ? "+" : ""}
      {pct}% vs previous
    </span>
  );
}

export function StatTile({ label, value, previous, href }: { label: string; value: number; previous: number; href?: string }) {
  const body = (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight">{formatCount(value)}</span>
      <Change now={value} before={previous} />
    </>
  );
  const className = "flex flex-col gap-1 rounded-lg border p-4";
  if (href) {
    return (
      <a href={href} className={cn(className, "outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50")}>
        {body}
      </a>
    );
  }
  return <div className={className}>{body}</div>;
}

/** Bucket labels: `t` is local time without an offset, so `new Date` reads it as local. */
function bucketLabel(t: string, bucket: AnalyticsOverview["bucket"], long = false): string {
  const date = new Date(t);
  if (bucket === "hour") {
    const hour = date.toLocaleTimeString(undefined, { hour: "numeric" });
    return long ? `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${hour}` : hour;
  }
  return date.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

/** A "nice" axis maximum: 1, 2, or 5 times a power of ten, at least the data max. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * Page views per bucket, as columns. One series, so no legend; visitors are in the tooltip
 * and in the table version for screen readers.
 */
export function ViewsChart({ series, bucket }: { series: AnalyticsOverview["series"]; bucket: AnalyticsOverview["bucket"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.map((p) => p.pageviews)));
  const point = hover === null ? null : series[hover];
  // Label a few buckets along the bottom, never so many they collide.
  const every = Math.max(1, Math.ceil(series.length / 6));

  return (
    <figure className="m-0">
      <figcaption className="sr-only">Page views per {bucket}</figcaption>
      <div className="relative grid grid-cols-[auto_1fr] gap-x-3">
        <div className="flex h-44 flex-col justify-between text-right text-xs text-muted-foreground" aria-hidden="true">
          <span className="-translate-y-1/2">{compact.format(max)}</span>
          <span className="-translate-y-1/2">{compact.format(max / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative h-44" onMouseLeave={() => setHover(null)}>
          {/* Recessive grid: top, middle, baseline. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
            <div className="border-t border-dashed" />
            <div className="border-t border-dashed" />
            <div className="border-t" />
          </div>
          <div className="absolute inset-0 flex items-end gap-0.5" aria-hidden="true">
            {series.map((p, i) => (
              // The hit target is the full column height, wider than the mark.
              <div key={p.t} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <div
                  className={cn("w-full rounded-t-[4px] transition-colors", hover === i ? "bg-foreground" : "bg-muted-foreground/45")}
                  style={{ height: p.pageviews === 0 ? 0 : `max(2px, ${(p.pageviews / max) * 100}%)` }}
                />
              </div>
            ))}
          </div>
          {point && hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md"
              style={{
                left: `${((hover + 0.5) / series.length) * 100}%`,
                transform: `translate(${hover > series.length / 2 ? "-100%" : "0"}, -100%)`,
              }}
            >
              <p className="font-medium whitespace-nowrap">{bucketLabel(point.t, bucket, true)}</p>
              <p className="whitespace-nowrap text-muted-foreground">
                <span className="text-foreground">{formatCount(point.pageviews)}</span> views · <span className="text-foreground">{formatCount(point.visitors)}</span>{" "}
                visitors
              </p>
            </div>
          )}
        </div>
        <div />
        <div className="mt-2 flex gap-0.5 text-xs text-muted-foreground" aria-hidden="true">
          {series.map((p, i) => (
            <span key={p.t} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
              {i % every === 0 ? bucketLabel(p.t, bucket) : ""}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <thead>
          <tr>
            <th>{bucket === "hour" ? "Hour" : "Day"}</th>
            <th>Page views</th>
            <th>Visitors</th>
          </tr>
        </thead>
        <tbody>
          {series.map((p) => (
            <tr key={p.t}>
              <td>{bucketLabel(p.t, bucket, true)}</td>
              <td>{p.pageviews}</td>
              <td>{p.visitors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A top-N list as rows with a proportional bar behind each label. */
export function TopList({
  title,
  rows,
  label = (v) => v,
  empty,
  unit = "Views",
}: {
  title: string;
  rows: AnalyticsCount[];
  label?: (value: string) => ReactNode;
  empty: string;
  unit?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 border-b pb-2 text-muted-foreground">
        <h3 className="font-medium text-foreground">{title}</h3>
        <span>{unit}</span>
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-1">
          {rows.map((r) => (
            <li key={r.value} className="relative flex items-center justify-between gap-3 px-2 py-1" title={`${formatCount(r.visitors)} visitors`}>
              <span className="absolute inset-y-0 left-0 rounded-sm bg-accent" style={{ width: `${(r.count / max) * 100}%` }} aria-hidden="true" />
              <span className="relative min-w-0 truncate">{label(r.value)}</span>
              <span className="relative tabular-nums">{formatCount(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

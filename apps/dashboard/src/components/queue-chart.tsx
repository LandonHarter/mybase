import { useState } from "react";
import type { QueueStatsPoint } from "@mybase/shared";
import { formatCount } from "@/components/analytics-parts";
import { cn } from "@/lib/utils";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function niceMax(max: number): number {
  if (max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

const hourLabel = (t: string, long: boolean, days: boolean) => {
  const date = new Date(t);
  const hour = date.toLocaleTimeString(undefined, { hour: "numeric" });
  if (long) return `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${hour}`;
  return days ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : hour;
};

const ALLOWED = "bg-muted-foreground/45";
const BLOCKED = "bg-destructive";

/**
 * Messages sent per hour, with dead-lettered ones stacked on top in the destructive color (a
 * state, not a series hue). Received and deleted counts are in the tooltip and the table.
 */
export function QueueChart({ series: points }: { series: QueueStatsPoint[] }) {
  const series = points.map((p) => ({ ...p, allowed: p.sent, blocked: p.dead }));
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.map((p) => p.allowed + p.blocked)));
  const point = hover === null ? null : series[hover];
  const days = series.length > 48;
  const every = Math.max(1, Math.ceil(series.length / 6));

  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex gap-4 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm", ALLOWED)} aria-hidden="true" />
          Sent
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm", BLOCKED)} aria-hidden="true" />
          Dead-lettered
        </span>
      </figcaption>
      <div className="relative grid grid-cols-[auto_1fr] gap-x-3">
        <div className="flex h-40 flex-col justify-between text-right text-xs text-muted-foreground" aria-hidden="true">
          <span className="-translate-y-1/2">{compact.format(max)}</span>
          <span className="-translate-y-1/2">{compact.format(max / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative h-40" onMouseLeave={() => setHover(null)}>
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
            <div className="border-t border-dashed" />
            <div className="border-t border-dashed" />
            <div className="border-t" />
          </div>
          <div className="absolute inset-0 flex items-end gap-px" aria-hidden="true">
            {series.map((p, i) => (
              <div key={p.t} className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                {p.blocked > 0 && (
                  <div
                    className={cn("w-full rounded-t-[4px]", BLOCKED, hover !== null && hover !== i && "opacity-60")}
                    style={{ height: `max(2px, ${(p.blocked / max) * 100}%)` }}
                  />
                )}
                {p.allowed > 0 && (
                  <div
                    className={cn("w-full", p.blocked > 0 ? "mt-[2px]" : "rounded-t-[4px]", hover === i ? "bg-foreground" : ALLOWED)}
                    style={{ height: `max(2px, ${(p.allowed / max) * 100}%)` }}
                  />
                )}
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
              <p className="font-medium whitespace-nowrap">{hourLabel(point.t, true, days)}</p>
              <p className="whitespace-nowrap text-muted-foreground">
                <span className="text-foreground">{formatCount(point.sent)}</span> sent · <span className="text-foreground">{formatCount(point.received)}</span> received ·{" "}
                <span className="text-foreground">{formatCount(point.deleted)}</span> deleted
                {point.dead > 0 && (
                  <>
                    {" "}
                    · <span className="text-foreground">{formatCount(point.dead)}</span> dead-lettered
                  </>
                )}
              </p>
            </div>
          )}
        </div>
        <div />
        <div className="mt-2 flex gap-px text-xs text-muted-foreground" aria-hidden="true">
          {series.map((p, i) => (
            <span key={p.t} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
              {i % every === 0 ? hourLabel(p.t, false, days) : ""}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>Queue messages per hour</caption>
        <thead>
          <tr>
            <th>Hour</th>
            <th>Sent</th>
            <th>Received</th>
            <th>Deleted</th>
            <th>Dead-lettered</th>
          </tr>
        </thead>
        <tbody>
          {series.map((p) => (
            <tr key={p.t}>
              <td>{hourLabel(p.t, true, days)}</td>
              <td>{p.sent}</td>
              <td>{p.received}</td>
              <td>{p.deleted}</td>
              <td>{p.dead}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

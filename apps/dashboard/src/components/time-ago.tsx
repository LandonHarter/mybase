import { formatDate, formatDuration } from "@/lib/format";
import { useNow } from "@/lib/time";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 hours ago" / "in 5 minutes" against `now`; under a minute in the past is "just now". */
export function relativeTo(iso: string | number, now: number, seconds = false): string {
  const diff = ((typeof iso === "number" ? iso : new Date(iso).getTime()) - now) / 1000;
  for (const [unit, size] of STEPS) if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  if (seconds && Math.abs(diff) >= 1) return relative.format(Math.round(diff), "second");
  return diff > 0 ? "in a moment" : "just now";
}

/**
 * A live relative time in `<time dateTime title>`: one shared 30 s clock, or 1 s while the moment
 * is under an hour away (`live`). Use for every timestamp so lists don't freeze between clicks.
 */
export function TimeAgo({ iso, className, live = false, prefix }: { iso: string; className?: string; live?: boolean; prefix?: string }) {
  const at = new Date(iso).getTime();
  const near = live && Math.abs(at - Date.now()) < 3_600_000;
  const now = useNow(near ? "precise" : "slow");
  return (
    <time dateTime={iso} title={formatDate(iso)} className={className}>
      {prefix}
      {relativeTo(at, now, near)}
    </time>
  );
}

/** "in 4m 12s" / "12s ago" ticking every second: cron next run, TTLs, visibility timeouts. */
export function Countdown({ iso, className, expired = "now" }: { iso: string; className?: string; expired?: string }) {
  const now = useNow("precise");
  const ms = new Date(iso).getTime() - now;
  return (
    <time dateTime={iso} title={formatDate(iso)} className={className}>
      {ms <= 0 ? expired : `in ${formatDuration(ms)}`}
    </time>
  );
}

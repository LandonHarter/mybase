const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 hours ago" style label; pair with formatDate for the exact time. */
export function timeAgo(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export const formatDate = (iso: string) => absolute.format(new Date(iso));

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** "1.4 MB" style size, in powers of 1000 like most file managers. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/** 45000 → "45s", 5400000 → "1h 30m": a short span (two units at most), for TTLs and windows. */
export function formatDuration(ms: number): string {
  let rest = Math.round(ms / 1000);
  if (rest < 60) return `${rest}s`;
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n}${unit}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

const numbers = new Intl.NumberFormat();
const compactNumbers = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** 12345 → "12,345". */
export const formatCount = (n: number) => numbers.format(n);

/** 12345 → "12.3K", for tight spaces (rows, chips). Pair with the exact count in a title. */
export const compact = (n: number) => compactNumbers.format(n);

/** plural(3, "queue", "queues") → "3 queues". */
export const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "3f2a…9c1e": long identifiers (UUIDs, digests) in tables. Keep the full value in a title/inspector. */
export function middle(value: string, keep = 4): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

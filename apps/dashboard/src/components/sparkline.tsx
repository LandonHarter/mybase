import { cn } from "@/lib/utils";

/**
 * A 60×16 trend line for panels, rows and headers (AN01): `--chart-1`, no axes. Pair it with the
 * number it summarizes; it has an aria-label with the range and the latest value.
 */
export function Sparkline({ values, label, className, width = 60, height = 16 }: { values: number[]; label: string; className?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 2)).toFixed(1)}`).join(" ");
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn("shrink-0 overflow-visible text-chart-1", className)}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

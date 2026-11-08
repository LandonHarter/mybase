import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface RoutedTab {
  id: string;
  label: ReactNode;
  href: string;
  /** "Messages 312": a count after the label. */
  count?: ReactNode;
}

/**
 * Tabs that are links (every view has a URL): the active one has an accent underline and
 * `aria-current="page"`. The one tab bar in the app (database, analytics, secrets, security, hosting).
 * `[` and `]` move between them (lib/keys.ts).
 */
export function RoutedTabs({ label, tabs, current, className }: { label: string; tabs: RoutedTab[]; current: string; className?: string }) {
  return (
    <nav aria-label={label} data-routed-tabs="" className={cn("mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]", className)}>
      {tabs.map((t) => {
        const active = t.id === current;
        return (
          <a
            key={t.id}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150",
              "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active && "border-primary font-medium text-foreground",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{t.count}</span>}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * A small exclusive choice (time range, mode): `role="radiogroup"` with roving tabindex and arrow
 * keys. Selected segment = `bg-background shadow-xs` on a `bg-muted` track.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  size = "sm",
}: {
  label: string;
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "xs";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : step ? (index + step + options.length) % options.length : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(options[to]!.value);
    refs.current[to]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cn("inline-flex shrink-0 items-center rounded-md bg-muted p-0.5", className)}>
      {options.map((o, i) => {
        const selected = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[calc(var(--radius)-3px)] px-2.5 font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              size === "sm" ? "h-7 text-sm" : "h-6 text-xs",
              "pointer-coarse:h-11",
              selected && "bg-background text-foreground shadow-xs",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

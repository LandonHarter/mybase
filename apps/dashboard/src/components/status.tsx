import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { relativeTo } from "@/components/time-ago";
import { formatDate } from "@/lib/format";
import { markActive, type Load } from "@/lib/load";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Health of something, never alone (D9): a coloured dot always comes with its label.
 * `ok` = live/active/healthy, `progress` = queued/starting/running (pulses), `warning` = needs
 * attention (DNS, warnings), `error` = failed, `neutral` = stopped/off/unknown.
 * "Enabled" is not "healthy": use `neutral` for configuration states.
 */
export type Health = "ok" | "progress" | "warning" | "error" | "neutral";

const DOT: Record<Health, string> = {
  ok: "bg-success",
  progress: "bg-info motion-safe:animate-progress",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/50",
};
const TEXT: Record<Health, string> = {
  ok: "text-foreground",
  progress: "text-foreground",
  warning: "text-warning",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};

export function StatusDot({ health, label, className, detail }: { health: Health; label: ReactNode; className?: string; detail?: ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap", TEXT[health], className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", DOT[health])} aria-hidden />
      <span className="truncate">{label}</span>
      {detail && <span className="truncate text-muted-foreground">{detail}</span>}
    </span>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "outline";

const BADGE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/12 text-destructive",
  info: "bg-info/12 text-info",
  outline: "border text-muted-foreground",
};
const BADGE_DOT: Record<BadgeTone, string> = {
  neutral: "bg-muted-foreground/60",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  outline: "bg-muted-foreground/60",
};

/** A small label: type, source, state. `text-xs font-medium`. The one tag style in the app. */
export function Badge({ tone = "neutral", dot = false, mono = false, className, children, title }: { tone?: BadgeTone; dot?: boolean; mono?: boolean; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap", BADGE[tone], mono && "font-mono font-normal", className)}>
      {dot && <span className={cn("size-1.5 rounded-full", BADGE_DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}

/**
 * Freshness for a section (DESIGN.md "Live data"): "Updated 12s ago · ↻". While polling it adds a
 * small success dot and "Auto-refresh · 15s"; paused polling says so with Resume; a failed refresh
 * keeps the old data and says "Couldn't refresh · Retry". The `r` shortcut calls the same refresh.
 */
export function LiveIndicator({ load, className }: { load: Pick<Load<unknown>, "updatedAt" | "refreshing" | "refreshError" | "polling" | "paused" | "refresh">; className?: string }) {
  const tick = useNow("slow");
  const { updatedAt, refreshing, refreshError, polling, paused, refresh } = load;
  // The shared clock can lag a just-finished fetch; never say "in a moment" about the past.
  const now = Math.max(tick, updatedAt ?? 0);
  const age = updatedAt ? relativeTo(updatedAt, now) : null;
  let label: ReactNode;
  if (refreshError) {
    label = (
      <span className="text-destructive" title={refreshError}>
        Couldn't refresh{age ? ` · last updated ${age}` : ""}
      </span>
    );
  } else if (paused) {
    label = <span>{paused === "hidden" ? "Paused while hidden" : "Paused"}{age ? ` · updated ${age}` : ""}</span>;
  } else if (refreshing && !updatedAt) {
    label = <span>Loading…</span>;
  } else {
    label = (
      <span title={updatedAt ? formatDate(new Date(updatedAt).toISOString()) : undefined}>
        {polling && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" aria-hidden />}
        {refreshing ? "Refreshing…" : age ? `Updated ${age === "just now" ? "just now" : age}` : ""}
        {polling && !refreshing ? ` · auto-refresh ${Math.round(polling / 1000)}s` : ""}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      {label}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={refreshError ? "Retry" : paused ? "Resume" : "Refresh"}
        title={refreshError ? "Retry" : paused ? "Resume" : "Refresh (r)"}
        data-refresh=""
        disabled={refreshing}
        onClick={() => {
          markActive();
          void refresh();
        }}
      >
        <RotateCw className={cn(refreshing && "motion-safe:animate-progress")} />
      </Button>
    </span>
  );
}

/** A heading row with a title, optional live indicator, and actions on the right. */
export function SectionHeader({ id, title, count, live, actions, className }: { id?: string; title: ReactNode; count?: ReactNode; live?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
        {live}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A section of a page: `<section aria-labelledby>` with a SectionHeader. */
export function Section({ id, title, count, live, actions, className, children }: { id: string; title: ReactNode; count?: ReactNode; live?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cn("mb-8", className)}>
      <SectionHeader id={id} title={title} count={count} live={live} actions={actions} />
      {children}
    </section>
  );
}

/** A literal value (key, host, id) in mono 13 px. */
export const Mono = ({ children, className, title }: { children: ReactNode; className?: string; title?: string }) => (
  <span title={title} className={cn("mono-value [overflow-wrap:anywhere]", className)}>
    {children}
  </span>
);

/** Inline code in body copy (`mybase deploy`). */
export const InlineCode = ({ children, className }: { children: ReactNode; className?: string }) => (
  <code className={cn("rounded-sm bg-muted px-1 py-px font-mono text-[0.9em] [overflow-wrap:anywhere]", className)}>{children}</code>
);

/** "—" for an empty cell, announced as "None". */
export const Empty = () => (
  <span className="text-muted-foreground" aria-label="None">
    —
  </span>
);

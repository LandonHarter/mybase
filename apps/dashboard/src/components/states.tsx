import { CircleAlert, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiOrigin } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A failed load (DESIGN.md "Errors"): a solid panel with an icon, the cause, and Retry. Dashed
 * borders are only for empty states and drop targets.
 */
export function ErrorPanel({ title, message, onRetry, action, className }: { title: string; message: ReactNode; onRetry?: () => void; action?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("flex max-w-prose gap-3 rounded-lg border bg-surface p-4", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-1 break-words text-muted-foreground">{message}</p>
        {(onRetry || action) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCw />
                Retry
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

const DEV = process.env.NODE_ENV !== "production";

/**
 * The API is unreachable. Retries on its own with backoff ("Retrying in 4s"), names the real
 * origin, and gives the command for this kind of install.
 */
export function OfflinePanel({ onRetry, className, title = "Can't reach the mybase API" }: { onRetry: () => void | Promise<unknown>; className?: string; title?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const delay = Math.min(30, 2 ** (attempt + 1));
    setLeft(delay);
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const t = setTimeout(() => {
      void onRetry();
      setAttempt((a) => a + 1);
    }, delay * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(t);
    };
  }, [attempt, onRetry]);
  return (
    <div role="alert" className={cn("flex max-w-prose gap-3 rounded-lg border bg-surface p-4", className)}>
      <WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-muted-foreground">
          Nothing answered at <span className="mono-value text-foreground">{apiOrigin()}</span>.{" "}
          {DEV ? (
            <>
              Start it with <code className="font-mono text-[0.9em] text-foreground">bun run dev</code>, then retry.
            </>
          ) : (
            <>
              On the server, run <code className="font-mono text-[0.9em] text-foreground">mybase server status</code>, then retry.
            </>
          )}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void onRetry();
              setAttempt(0);
            }}
          >
            <RotateCw />
            Retry now
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="off">
            Retrying in {left}s
          </span>
        </div>
      </div>
    </div>
  );
}

/** Renders `children` only after `ms`, so fast loads never flash a skeleton. */
export function Delayed({ ms = 200, children }: { ms?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown ? children : null;
}

/** Lines of text loading (a paragraph, a short list). */
export function LinesSkeleton({ label, lines = 3, className }: { label: string; lines?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3", className)} aria-busy="true" aria-label={label}>
      <Delayed>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" style={{ maxWidth: `${28 - (i % 3) * 5}rem` }} />
        ))}
      </Delayed>
    </div>
  );
}

/** A table loading: a header and rows in the table's shape. */
export function TableSkeleton({ label, rows = 5, columns = 4, className }: { label: string; rows?: number; columns?: number; className?: string }) {
  return (
    <div className={cn("grid", className)} aria-busy="true" aria-label={label}>
      <Delayed>
        <div className="flex h-9 items-center gap-6 border-b px-3">
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className={cn("h-3", i === 0 ? "w-32" : "w-16")} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex h-10 items-center gap-6 border-b px-3">
            {Array.from({ length: columns }, (_, i) => (
              <Skeleton key={i} className={cn("h-4", i === 0 ? "w-40" : "w-20")} />
            ))}
          </div>
        ))}
      </Delayed>
    </div>
  );
}

/** Overview panels loading. */
export function CardGridSkeleton({ label, cards = 4, className }: { label: string; cards?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)} aria-busy="true" aria-label={label}>
      <Delayed>
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="grid gap-3 rounded-lg border bg-surface p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </Delayed>
    </div>
  );
}

/** A row of stat tiles loading. */
export function StatRowSkeleton({ label, tiles = 3, className }: { label: string; tiles?: number; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-8", className)} aria-busy="true" aria-label={label}>
      <Delayed>
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className="grid gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </Delayed>
    </div>
  );
}

/** "Nothing here yet": a dashed panel with what it is and the action that fills it. */
export function EmptyState({ title, children, action, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-prose rounded-lg border border-dashed p-5", className)}>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-muted-foreground">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

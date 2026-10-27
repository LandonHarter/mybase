// Pieces shared by the cron list and job pages.
import type { CronJob } from "@mybase/shared";
import { formatDate, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "Next in 5 minutes", "Paused", or "Not scheduled". */
export function NextRun({ job }: { job: CronJob }) {
  if (!job.enabled) return <span className="text-muted-foreground">Paused</span>;
  if (!job.nextRunAt) return <span className="text-muted-foreground">Not scheduled</span>;
  return (
    <time dateTime={job.nextRunAt} title={formatDate(job.nextRunAt)}>
      {timeAgo(job.nextRunAt)}
    </time>
  );
}

/** "OK 200 · 3 minutes ago" or a failed one, in the destructive color. */
export function RunResult({ status, httpStatus, at }: { status: "success" | "failed"; httpStatus: number | null; at?: string }) {
  return (
    <span className={cn(status === "failed" && "text-destructive")}>
      {status === "success" ? "OK" : "Failed"}
      {httpStatus !== null && ` ${httpStatus}`}
      {at && (
        <span className="text-muted-foreground">
          {" · "}
          <time dateTime={at} title={formatDate(at)}>
            {timeAgo(at)}
          </time>
        </span>
      )}
    </span>
  );
}

export const CodeTag = () => (
  <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground" title="Defined in mybase.config.ts; change it there and run mybase cron sync">
    Code
  </span>
);

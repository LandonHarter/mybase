// Pieces shared by the cron list and job pages.
import { Cron } from "croner";
import type { CronJob, CronRunRecord } from "@mybase/shared";
import { Badge, StatusDot } from "@/components/status";
import { Countdown, TimeAgo } from "@/components/time-ago";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "Next in 4m 12s" (live under an hour), "in 3 hours", "Paused", or "Not scheduled". */
export function NextRun({ job }: { job: Pick<CronJob, "enabled" | "nextRunAt"> }) {
  if (!job.enabled) return <span className="text-muted-foreground">Paused</span>;
  if (!job.nextRunAt) return <span className="text-muted-foreground">Not scheduled</span>;
  return Date.parse(job.nextRunAt) - Date.now() < 3_600_000 ? <Countdown iso={job.nextRunAt} /> : <TimeAgo iso={job.nextRunAt} />;
}

/** "OK 200 · 3 minutes ago" or a failed one. */
export function RunResult({ status, httpStatus, at }: { status: "success" | "failed"; httpStatus: number | null; at?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot health={status === "success" ? "ok" : "error"} label={`${status === "success" ? "OK" : "Failed"}${httpStatus !== null ? ` ${httpStatus}` : ""}`} />
      {at && (
        <span className="text-muted-foreground">
          {" · "}
          <TimeAgo iso={at} />
        </span>
      )}
    </span>
  );
}

export const CodeTag = () => (
  <Badge tone="outline" title="Defined in mybase.config.ts; change it there and run mybase cron sync">
    Code
  </Badge>
);

export const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The last runs as ✓/✗ squares, oldest left (CR01). Each has a tooltip with time, status and duration. */
export function RunStrip({ runs, max = 10 }: { runs: CronRunRecord[] | undefined; max?: number }) {
  if (!runs) return <span className="inline-block h-3 w-24 rounded-sm bg-muted" aria-label="Loading runs" />;
  if (runs.length === 0) return <span className="text-muted-foreground">No runs yet</span>;
  const shown = runs.slice(0, max).reverse();
  const failed = shown.filter((r) => r.status === "failed").length;
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Last ${shown.length} runs: ${shown.length - failed} OK, ${failed} failed`}>
      {shown.map((r) => (
        <Tooltip key={r.id}>
          <TooltipTrigger asChild>
            <span className={cn("block size-3 rounded-[2px]", r.status === "success" ? "bg-success/70" : "bg-destructive")} />
          </TooltipTrigger>
          <TooltipContent>
            {r.status === "success" ? "OK" : "Failed"}
            {r.httpStatus !== null && ` ${r.httpStatus}`} · {duration(r.durationMs)} · {formatDate(r.startedAt)}
            {r.trigger === "manual" && " · Run now"}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

/** Common schedules, as chips in the form (CR03). */
export const PRESETS: { label: string; schedule: string }[] = [
  { label: "Every 15 minutes", schedule: "*/15 * * * *" },
  { label: "Hourly", schedule: "0 * * * *" },
  { label: "Daily 03:00", schedule: "0 3 * * *" },
  { label: "Weekdays 09:00", schedule: "0 9 * * 1-5" },
  { label: "Weekly, Mon 09:00", schedule: "0 9 * * 1" },
  { label: "Monthly, 1st 00:00", schedule: "0 0 1 * *" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: string) => n.padStart(2, "0");

/**
 * English for the common shapes only (D23): "Every 15 minutes", "Every day at 03:00",
 * "Every Monday at 09:00". Anything else returns null and the UI shows the next runs instead.
 */
export function describeSchedule(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const num = /^\d+$/;
  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return "Every minute";
  const step = /^\*\/(\d+)$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${step[1]} minutes`;
  if (num.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return min === "0" ? "Every hour, on the hour" : `Every hour at :${pad(min)}`;
  const hstep = /^\*\/(\d+)$/.exec(hour);
  if (num.test(min) && hstep && dom === "*" && mon === "*" && dow === "*") return `Every ${hstep[1]} hours at :${pad(min)}`;
  if (!num.test(min) || !num.test(hour) || mon !== "*") return null;
  const at = `${pad(hour)}:${pad(min)}`;
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${at}`;
  if (dom === "*" && /^[0-6]$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${at}`;
  if (num.test(dom) && dow === "*") return `On day ${dom} of every month at ${at}`;
  return null;
}

/** Validates with croner (the API's own scheduler) and lists the next runs, or returns the error. */
export function nextRuns(expr: string, timezone: string, count = 5): { runs: Date[] } | { error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { error: "Use 5 fields: minute, hour, day of month, month, day of week." };
  try {
    const job = new Cron(expr.trim(), { timezone: timezone || "UTC", paused: true });
    const runs = job.nextRuns(count);
    job.stop();
    return { runs };
  } catch (err) {
    return { error: (err as Error).message.replace(/^CronPattern: /, "") };
  }
}

const inZone = (d: Date, tz: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toISOString();
  }
};

/** The live preview under the schedule field: a sentence, then the next 5 runs in the job's zone and yours. */
export function SchedulePreview({ schedule, timezone }: { schedule: string; timezone: string }) {
  if (!schedule.trim()) return <p className="text-muted-foreground">Minute, hour, day of month, month, day of week.</p>;
  const result = nextRuns(schedule, timezone);
  if ("error" in result)
    return (
      <p className="text-destructive" role="alert">
        {result.error}
      </p>
    );
  const sentence = describeSchedule(schedule);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="grid gap-1" aria-live="polite">
      {sentence && <p className="font-medium">{sentence}{timezone && timezone !== "UTC" ? `, ${timezone}` : timezone === "UTC" ? ", UTC" : ""}</p>}
      <ol className="grid gap-0.5 text-muted-foreground">
        {result.runs.map((d) => (
          <li key={d.toISOString()} className="tabular-nums">
            {inZone(d, timezone || "UTC")}
            {local !== (timezone || "UTC") && <span className="text-xs"> · {inZone(d, local)} your time</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

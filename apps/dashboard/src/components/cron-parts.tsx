// Pieces shared by the cron list and job pages.
import { useState, type ReactNode } from "react";
import type { CronJob } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A confirm step for anything that can't be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  pendingLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirm: string;
  pendingLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  async function run() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={run}>
            {pending ? pendingLabel : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

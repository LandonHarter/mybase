import { Fragment, useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { CronJob, Project } from "@mybase/shared";
import { CodeTag, ConfirmDialog, NextRun, RunResult } from "@/components/cron-parts";
import { CronJobForm, fieldsOf, specOf, type JobFields } from "@/components/cron-job-form";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { href, navigate } from "@/lib/router";

function History({ project, job, version }: { project: string; job: string; version: number }) {
  const { state, refresh } = useLoad(`cron-runs:${project}:${job}`, () => api.cronRuns(project, job));
  const [open, setOpen] = useState<string | null>(null);

  // `version` bumps after Run now; the run lands a moment later, so check back a few times.
  useEffect(() => {
    if (version === 0) return;
    const timers = [800, 2500, 12_000].map((ms) => setTimeout(refresh, ms));
    return () => timers.forEach(clearTimeout);
  }, [version, refresh]);

  if (state.status === "loading") return <Skeleton className="h-5 w-full max-w-md" />;
  if (state.status === "error") {
    return (
      <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Can't load run history</p>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }
  if (state.data.length === 0) {
    return <p className="max-w-prose rounded-lg border border-dashed p-5 text-muted-foreground">No runs yet. Runs show here after the next scheduled time, or after Run now.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Started</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Trigger</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.data.map((run) => {
          const expanded = open === run.id;
          const details = run.error || run.response;
          return (
            <Fragment key={run.id}>
              <TableRow>
                <TableCell>
                  {details && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-expanded={expanded}
                      aria-label={expanded ? "Hide details" : "Show details"}
                      onClick={() => setOpen(expanded ? null : run.id)}
                    >
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  )}
                </TableCell>
                <TableCell>
                  <time dateTime={run.startedAt} title={formatDate(run.startedAt)}>
                    {timeAgo(run.startedAt)}
                  </time>
                </TableCell>
                <TableCell>
                  <RunResult status={run.status} httpStatus={run.httpStatus} />
                </TableCell>
                <TableCell>{run.attempts}</TableCell>
                <TableCell>{run.durationMs < 1000 ? `${run.durationMs} ms` : `${(run.durationMs / 1000).toFixed(1)} s`}</TableCell>
                <TableCell className="text-muted-foreground">{run.trigger === "manual" ? "Run now" : "Schedule"}</TableCell>
              </TableRow>
              {expanded && (
                <TableRow>
                  <TableCell />
                  <TableCell colSpan={5} className="grid gap-2 whitespace-normal">
                    {run.error && <p className="text-destructive">{run.error}</p>}
                    {run.response && (
                      <pre className="max-h-48 overflow-auto rounded-md border bg-accent/40 p-3 font-mono text-xs whitespace-pre-wrap">{run.response}</pre>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Settings({ project, job, onSaved }: { project: string; job: CronJob; onSaved: (job: CronJob) => void }) {
  const [fields, setFields] = useState<JobFields>(() => fieldsOf(job));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const readOnly = job.source === "code";
  const dirty = JSON.stringify(fields) !== JSON.stringify(fieldsOf(job));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = specOf(fields);
    if ("error" in parsed) return setError(parsed.error);
    setPending(true);
    setError(null);
    try {
      const saved = await api.updateCronJob(project, job.name, parsed.spec);
      toast.success(`Saved ${saved.name}`);
      setFields(fieldsOf(saved));
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Row
      title="Settings"
      hint={
        readOnly ? (
          <>
            Defined in <code className="font-mono text-[0.85em] text-foreground">mybase.config.ts</code>. Change it there and run{" "}
            <code className="font-mono text-[0.85em] text-foreground">mybase cron sync</code>.
          </>
        ) : (
          "Changes apply from the next scheduled time."
        )
      }
    >
      <form onSubmit={onSubmit} className="grid max-w-xl gap-4">
        <CronJobForm fields={fields} onChange={setFields} readOnly={readOnly} />
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!readOnly && (
          <div>
            <Button type="submit" variant="outline" disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </form>
    </Row>
  );
}

export function CronJobView({ project, name }: { project: Project; name: string }) {
  const { state, refresh } = useLoad(`cron-job:${project.name}:${name}`, () => api.cronJob(project.name, name));
  const [runs, setRuns] = useState(0);
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const cronHref = href({ page: "cron", name: project.name, job: null, create: false });
  const breadcrumb = { label: `${project.name} / Cron`, href: cronHref };

  if (state.status !== "ready") {
    return (
      <>
        <PageHeader title={name} breadcrumb={breadcrumb} />
        {state.status === "loading" ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading job">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full max-w-md" />
            ))}
          </div>
        ) : (
          <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
            <p className="font-medium">Can't load {name}</p>
            <p className="mt-1 text-muted-foreground">{state.message}</p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <a href={cronHref}>All cron jobs</a>
            </Button>
          </div>
        )}
      </>
    );
  }
  const job = state.data;

  async function runNow() {
    setRunning(true);
    try {
      await api.runCronJob(project.name, job.name);
      toast.success(`Started ${job.name}`);
      setRuns((n) => n + 1);
      setTimeout(refresh, 2500);
    } catch (err) {
      toast.error(`Couldn't start ${job.name}: ${errorMessage(err)}`);
    } finally {
      setRunning(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    try {
      await api.updateCronJob(project.name, job.name, { enabled });
      await refresh();
      toast.success(enabled ? `Resumed ${job.name}` : `Paused ${job.name}`);
    } catch (err) {
      toast.error(`Couldn't ${enabled ? "resume" : "pause"} ${job.name}: ${errorMessage(err)}`);
    }
  }

  async function remove() {
    try {
      await api.deleteCronJob(project.name, job.name);
      toast.success(`Deleted ${job.name}`);
      navigate({ page: "cron", name: project.name, job: null, create: false });
    } catch (err) {
      toast.error(`Couldn't delete ${job.name}: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title={job.name}
        breadcrumb={breadcrumb}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[0.9em]">{job.schedule}</span>
            <span>{job.timezone}</span>
            <span aria-hidden="true">·</span>
            <span>
              Next: <NextRun job={job} />
            </span>
            {job.source === "code" && <CodeTag />}
          </span>
        }
        action={
          <Button onClick={runNow} disabled={running}>
            <Play />
            {running ? "Starting…" : "Run now"}
          </Button>
        }
      />

      <section aria-labelledby="history" className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="history" className="text-base font-semibold">
            Run history
          </h2>
          <Button variant="outline" size="sm" onClick={() => setEnabled(!job.enabled)}>
            {job.enabled ? <Pause /> : <Play />}
            {job.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
        <History project={project.name} job={job.name} version={runs} />
      </section>

      <section aria-labelledby="settings" className="mb-10">
        <h2 id="settings" className="mb-3 text-base font-semibold">
          Job
        </h2>
        <Settings
          key={job.updatedAt}
          project={project.name}
          job={job}
          onSaved={(saved) => {
            if (saved.name !== job.name) navigate({ page: "cron", name: project.name, job: saved.name, create: false }, { replace: true });
            else void refresh();
          }}
        />
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Delete job
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">
            {job.source === "code" ? "It comes back on the next sync unless you remove it from mybase.config.ts too." : "Deletes the job and its run history."}
          </p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete job
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${job.name}`}
        description="Stops the schedule and deletes its run history. This can't be undone."
        confirm="Delete job"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </>
  );
}

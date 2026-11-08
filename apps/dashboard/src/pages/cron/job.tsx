import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { CronJob, Project } from "@mybase/shared";
import { CodeTag, describeSchedule, duration, NextRun, RunResult } from "@/components/cron-parts";
import { CodeBlock } from "@/components/code-block";
import { Facts } from "@/components/inspector";
import { DangerZone, ServiceViews } from "@/components/service-layout";
import { LiveIndicator, Mono, StatusDot } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CronJobForm, fieldsOf, specOf, type JobFields } from "@/components/cron-job-form";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { EmptyState, ErrorPanel, LinesSkeleton, TableSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, invalidate, POLL, useLoad } from "@/lib/load";
import { href, navigate, useServiceView } from "@/lib/router";

function History({ project, job, pendingRun, onArrived }: { project: string; job: string; pendingRun: string | null; onArrived: () => void }) {
  // CR02: 2 s while a Run now is in flight (until its run id shows up), else the list rate.
  const runs = useLoad(`cron-runs:${project}:${job}`, () => api.cronRuns(project, job), { interval: pendingRun ? POLL.progress : POLL.list });
  const { state, refresh } = runs;
  const [open, setOpen] = useState<string | null>(null);
  const arrived = pendingRun && state.status === "ready" && state.data.some((r) => r.id === pendingRun);
  useEffect(() => {
    if (arrived) {
      setOpen(pendingRun);
      onArrived();
    }
  }, [arrived, pendingRun, onArrived]);

  if (state.status === "loading") return <TableSkeleton label="Loading runs" rows={3} columns={5} />;
  if (state.status === "error") return <ErrorPanel title="Can't load run history" message={state.message} onRetry={refresh} />;
  if (state.data.length === 0 && !pendingRun) {
    return <EmptyState title="No runs yet">Runs show here after the next scheduled time, or after Run now.</EmptyState>;
  }

  return (
    <>
      <div className="mb-2 flex justify-end">
        <LiveIndicator load={runs} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Started</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Attempts</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Trigger</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pendingRun && !arrived && (
            <TableRow>
              <TableCell />
              <TableCell>just now</TableCell>
              <TableCell>
                <StatusDot health="progress" label="Running…" />
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell className="text-muted-foreground">Run now</TableCell>
            </TableRow>
          )}
          {state.data.map((run) => {
            const expanded = open === run.id;
            return (
              <Fragment key={run.id}>
                <TableRow className={cn(run.id === pendingRun && "animate-arrive")}>
                  <TableCell>
                    <Button variant="ghost" size="icon-xs" aria-expanded={expanded} aria-label={expanded ? "Hide request and response" : "Show request and response"} onClick={() => setOpen(expanded ? null : run.id)}>
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <TimeAgo iso={run.startedAt} />
                  </TableCell>
                  <TableCell>
                    <RunResult status={run.status} httpStatus={run.httpStatus} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{run.attempts}</TableCell>
                  <TableCell className="text-right tabular-nums">{duration(run.durationMs)}</TableCell>
                  <TableCell className="text-muted-foreground">{run.trigger === "manual" ? "Run now" : "Schedule"}</TableCell>
                </TableRow>
                {expanded && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={5} className="whitespace-normal">
                      <Facts
                        className="py-2"
                        items={[
                          ["Run id", <Mono key="id">{run.id}</Mono>],
                          ["Scheduled for", <span key="s">{formatDate(run.scheduledAt)}</span>],
                          ["Finished", <span key="f">{formatDate(run.finishedAt)}</span>],
                          ["Error", run.error ? <span key="e" className="text-destructive">{run.error}</span> : "—"],
                          ["Response", run.response ? <pre key="r" className="code-block max-h-48 overflow-auto rounded-md border bg-surface p-2 whitespace-pre-wrap">{run.response}</pre> : run.httpStatus === null ? "No response (network error or timeout)" : "Empty body"],
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </>
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

/** The job as it would read in mybase.config.ts (baseUrl + path, as `defineConfig` takes it). */
function configFragment(job: CronJob) {
  let base = job.url;
  let path = "/api/cron";
  try {
    const u = new URL(job.url);
    base = u.origin;
    path = u.pathname + u.search;
  } catch {
    // keep the raw URL
  }
  const fields = [`schedule: "${job.schedule}"`, ...(job.timezone !== "UTC" ? [`timezone: "${job.timezone}"`] : []), ...(path !== "/api/cron" ? [`path: "${path}"`] : [])];
  return `cron: {\n  baseUrl: "${base}",\n  jobs: {\n    ${JSON.stringify(job.name)}: { ${fields.join(", ")} },\n  },\n},`;
}

export function CronJobView({ project, name }: { project: Project; name: string }) {
  const job$ = useLoad(`cron-job:${project.name}:${name}`, () => api.cronJob(project.name, name));
  const { state, refresh } = job$;
  const view = useServiceView();
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const cronHref = href({ page: "cron", name: project.name, job: null, create: false });
  const breadcrumb = [{ label: project.name, href: href({ page: "project", name: project.name }) }, { label: "Cron", href: cronHref }];
  const arrived = useCallback(() => {
    setPendingRun(null);
    void refresh();
  }, [refresh]);
  // Give up waiting after 2 minutes (the call's own timeout and retries are shorter).
  useEffect(() => {
    if (!pendingRun) return;
    const t = setTimeout(() => setPendingRun(null), 120_000);
    return () => clearTimeout(t);
  }, [pendingRun]);

  if (state.status !== "ready") {
    return (
      <>
        <PageHeader mono title={name} breadcrumb={breadcrumb} />
        {state.status === "loading" ? (
          <LinesSkeleton label="Loading job" />
        ) : (
          <ErrorPanel
            title={`Can't load ${name}`}
            message={state.message}
            onRetry={() => void refresh()}
            action={
              <Button asChild variant="ghost" size="sm">
                <a href={cronHref}>All cron jobs</a>
              </Button>
            }
          />
        )}
      </>
    );
  }
  const job = state.data;
  const on = enabled ?? job.enabled;

  async function runNow() {
    setRunning(true);
    try {
      const { runId } = await api.runCronJob(project.name, job.name);
      setPendingRun(runId);
    } catch (err) {
      toast.error(`Couldn't start ${job.name}: ${errorMessage(err)}`, { duration: Infinity });
    } finally {
      setRunning(false);
    }
  }

  // CR07 + L04: the switch is state; optimistic, rolled back on failure.
  async function setEnabled(next: boolean) {
    setEnabledState(next);
    try {
      await api.updateCronJob(project.name, job.name, { enabled: next });
      await refresh();
      invalidate(`cron-jobs:${project.name}`);
    } catch (err) {
      toast.error(`Couldn't ${next ? "resume" : "pause"} ${job.name}: ${errorMessage(err)}`, { duration: Infinity });
    } finally {
      setEnabledState(null);
    }
  }

  async function remove() {
    await api.deleteCronJob(project.name, job.name);
    toast.success(`Deleted ${job.name}`);
    invalidate(`cron-jobs:${project.name}`);
    navigate({ page: "cron", name: project.name, job: null, create: false });
  }

  const sentence = describeSchedule(job.schedule);
  const route = { page: "cron" as const, name: project.name, job: job.name, create: false };
  return (
    <>
      <PageHeader
        mono
        title={job.name}
        breadcrumb={breadcrumb}
        aside={
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={on} onCheckedChange={(v) => void setEnabled(v)} aria-label={on ? `Pause ${job.name}` : `Resume ${job.name}`} />
            {on ? "Enabled" : "Paused"}
          </label>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[0.9em]">{job.schedule}</span>
            {sentence && <span>{sentence}</span>}
            <span>{job.timezone}</span>
            <span aria-hidden="true">·</span>
            <span>
              Next: <NextRun job={{ ...job, enabled: on }} />
            </span>
            {job.source === "code" && <CodeTag />}
          </span>
        }
        action={
          <Button onClick={runNow} disabled={running || pendingRun !== null}>
            <Play />
            {running ? "Starting…" : pendingRun ? "Running…" : "Run now"}
          </Button>
        }
      />
      <ServiceViews route={route} view={view} label="Job" main="Runs" />

      {job.source === "code" && (
        <div className="mb-6 grid max-w-3xl gap-2 rounded-lg border bg-surface p-4">
          <p className="font-medium">Managed in mybase.config.ts</p>
          <p className="text-muted-foreground">
            Run now and Pause work here. Everything else comes from your config: change it there and sync. Deleting it here brings it back on the next sync unless you remove it from the config too.
          </p>
          <CodeBlock
            lang="ts"
            title="mybase.config.ts"
            code={configFragment(job)}
          />
          <CodeBlock lang="bash" code={`mybase cron sync --project ${project.name}`} />
        </div>
      )}

      {view !== "settings" && (
        <section aria-labelledby="history" className="mb-8">
          <h2 id="history" className="mb-2 text-base font-semibold">
            Run history
          </h2>
          <History project={project.name} job={job.name} pendingRun={pendingRun} onArrived={arrived} />
        </section>
      )}

      {view === "settings" && (
        <>
          <section aria-labelledby="settings" className="mb-8">
            <Settings
              key={job.updatedAt}
              project={project.name}
              job={job}
              onSaved={(saved) => {
                invalidate(`cron-jobs:${project.name}`);
                if (saved.name !== job.name) navigate({ page: "cron", name: project.name, job: saved.name, create: false }, { replace: true });
                else void refresh();
              }}
            />
          </section>
          <DangerZone title="Delete job" action={<Button variant="danger-outline" onClick={() => setDeleteOpen(true)}><Trash2 />Delete job…</Button>}>
            {job.source === "code" ? "It comes back on the next sync unless you remove it from mybase.config.ts too." : "Stops the schedule and deletes its run history."}
          </DangerZone>
        </>
      )}

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

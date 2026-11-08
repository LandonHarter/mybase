import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Pause, Play, Plus, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import type { CronJob, CronTask, Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { CodeTag, describeSchedule, duration, NextRun, RunStrip } from "@/components/cron-parts";
import { Facts } from "@/components/inspector";
import { Badge, InlineCode, LiveIndicator, Mono, SectionHeader, StatusDot, type Health } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { SegmentedControl } from "@/components/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCopy } from "@/lib/clipboard";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CronJobForm, emptyFields, specOf, type JobFields } from "@/components/cron-job-form";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { ServiceOff } from "@/components/service-off";
import { ConnectSheet, DangerZone, ServiceViews } from "@/components/service-layout";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { SERVICE_PAGES } from "@/components/service-card";
import { Row } from "@/components/row";
import { EmptyState, ErrorPanel, TableSkeleton } from "@/components/states";
import { CodeBlock } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, invalidate, POLL, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate, useServiceView } from "@/lib/router";
import { CronJobView } from "@/pages/cron/job";

function CreateJobDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [fields, setFields] = useState<JobFields>(emptyFields);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setFields(emptyFields());
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = specOf(fields);
    if ("error" in parsed) return setError(parsed.error);
    setPending(true);
    setError(null);
    try {
      const job = await api.createCronJob(project, parsed.spec);
      toast.success(`Created ${job.name}`);
      close(false);
      navigate({ page: "cron", name: project, job: job.name, create: false }, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="text-left">
          <DialogTitle>New cron job</DialogTitle>
          <DialogDescription>mybase POSTs to the URL on this schedule, signed with the project's secret.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-5">
          <CronJobForm fields={fields} onChange={setFields} autoFocus />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const HANDLER_SNIPPET = `import { cronHandler } from "@mybase-dev/sdk/cron";

export const POST = cronHandler({
  secret: process.env.MYBASE_CRON_SECRET!,
  jobs: {
    cleanup: async (run) => {
      // run.payload, run.runId, run.attempt
    },
  },
});`;

function SigningSecret({ project }: { project: string }) {
  const { state, refresh } = useLoad(`cron-secret:${project}`, () => api.cronSecret(project));
  const [rotateOpen, setRotateOpen] = useState(false);

  async function rotate() {
    await api.rotateCronSecret(project);
    await refresh();
    toast.success("Rotated the signing secret");
  }

  return (
    <section aria-labelledby="secret" className="mb-8">
      <h2 id="secret" className="mb-2 text-base font-semibold">
        Verify calls in your app
      </h2>
      <Row title="Signing secret" hint="Every call carries an X-Mybase-Signature made with it. Keep it server-side.">
        {state.status === "loading" && <Skeleton className="h-9 w-full max-w-md" />}
        {state.status === "error" && <p className="text-destructive">{state.message}</p>}
        {state.status === "ready" && (
          <div className="grid gap-3">
            <CopyField id="cron-secret" label="MYBASE_CRON_SECRET" value={state.data.secret} secret />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground">
                Last rotated{" "}
                <time dateTime={state.data.rotatedAt} title={formatDate(state.data.rotatedAt)}>
                  {timeAgo(state.data.rotatedAt)}
                </time>
              </p>
              <Button variant="outline" size="sm" onClick={() => setRotateOpen(true)}>
                <RotateCw />
                Rotate secret
              </Button>
            </div>
          </div>
        )}
      </Row>
      <Row
        title="Handler"
        hint={
          <>
            Install <code className="font-mono text-[0.85em] text-foreground">@mybase-dev/sdk</code>. The handler checks the signature and runs the job by name.
          </>
        }
      >
        <CodeBlock code={HANDLER_SNIPPET} lang="ts" />
      </Row>
      <ConfirmDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Rotate signing secret"
        description="The current secret stops working right away, so calls fail until your app has the new one. To switch without failures, give the handler both secrets (new first) while you deploy."
        confirm="Rotate"
        pendingLabel="Rotating…"
        onConfirm={rotate}
      />
    </section>
  );
}

function JobRow({ project, job, onChanged }: { project: string; job: CronJob; onChanged: () => void }) {
  const runs = useLoad(`cron-runs:${project}:${job.name}`, () => api.cronRuns(project, job.name), { interval: POLL.list, maxAge: 15_000 });
  const [starting, setStarting] = useState(false);
  const [enabled, setEnabled] = useState(job.enabled);
  useEffect(() => setEnabled(job.enabled), [job.enabled]);

  async function run() {
    setStarting(true);
    try {
      await api.runCronJob(project, job.name);
      toast.success(`Started ${job.name}`, { action: { label: "View", onClick: () => navigate({ page: "cron", name: project, job: job.name, create: false }) } });
      setTimeout(() => void runs.refresh(), 2000);
    } catch (err) {
      toast.error(`Couldn't start ${job.name}: ${errorMessage(err)}`, { duration: Infinity });
    } finally {
      setStarting(false);
    }
  }

  // L04: optimistic, rolled back on failure.
  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    try {
      await api.updateCronJob(project, job.name, { enabled: next });
      onChanged();
    } catch (err) {
      setEnabled(!next);
      toast.error(`Couldn't ${next ? "resume" : "pause"} ${job.name}: ${errorMessage(err)}`, { duration: Infinity });
    }
  }

  const sentence = describeSchedule(job.schedule);
  return (
    <TableRow className="group/row relative" data-row="">
      <TableCell>
        <span className="flex items-center gap-2">
          <a href={href({ page: "cron", name: project, job: job.name, create: false })} className="font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline">
            {job.name}
          </a>
          {job.source === "code" && <CodeTag />}
          {!enabled && <Badge tone="outline">Paused</Badge>}
        </span>
        <span className="block max-w-xs truncate font-mono text-xs text-muted-foreground" title={job.url}>
          {job.url}
        </span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-[13px]">{job.schedule}</span>
        <span className="block text-xs text-muted-foreground">
          {sentence ?? "Custom"}
          {job.timezone !== "UTC" && ` · ${job.timezone}`}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <NextRun job={{ ...job, enabled }} />
      </TableCell>
      <TableCell>
        <RunStrip runs={runs.data} />
      </TableCell>
      <TableCell className="py-1">
        <span className="relative z-10 flex justify-end gap-0.5">
          <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" aria-label={`${enabled ? "Pause" : "Resume"} ${job.name}`} title={enabled ? "Pause" : "Resume"} onClick={() => void toggle()}>
            {enabled ? <Pause /> : <Play className="opacity-60" />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Run ${job.name} now`} title="Run now" disabled={starting} onClick={() => void run()}>
            {starting ? <span className="size-1.5 rounded-full bg-info motion-safe:animate-progress" /> : <Play />}
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

type JobFilter = "all" | "failing" | "paused";

function Jobs({ project, onCreate }: { project: string; onCreate: () => void }) {
  const jobs = useLoad(`cron-jobs:${project}`, () => api.listCronJobs(project), { interval: POLL.list });
  const { state, refresh } = jobs;
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<JobFilter>("all");

  if (state.status === "loading") return <TableSkeleton label="Loading jobs" rows={3} columns={5} />;
  if (state.status === "error") return <ErrorPanel title="Can't list cron jobs" message={state.message} onRetry={refresh} />;
  if (state.data.length === 0) {
    return (
      <EmptyState
        title="No cron jobs yet"
        action={
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus />
            New job
          </Button>
        }
      >
        A cron job calls a URL in your app on a schedule, signed so your app can check it came from here. Create one, or declare them in <InlineCode>mybase.config.ts</InlineCode> and run{" "}
        <InlineCode>mybase cron sync --project {project}</InlineCode>.
      </EmptyState>
    );
  }
  const needle = query.trim().toLowerCase();
  const shown = state.data.filter((j) => (!needle || j.name.includes(needle) || j.url.toLowerCase().includes(needle)) && (show === "all" || (show === "paused" ? !j.enabled : j.lastRun?.status === "failed")));
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {state.data.length > 5 && <Input type="search" data-filter="" aria-label="Filter jobs" placeholder="Filter jobs" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-52" />}
        <SegmentedControl size="xs" label="Show" value={show} onChange={setShow} options={[{ value: "all", label: "All" }, { value: "failing", label: "Failing" }, { value: "paused", label: "Paused" }]} />
        <LiveIndicator className="ml-auto" load={jobs} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead>Last 10 runs</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((job) => (
            <JobRow key={job.name} project={project} job={job} onChanged={() => invalidate(`cron-jobs:${project}`)} />
          ))}
          {shown.length === 0 && <TableEmpty colSpan={5}>No jobs match.</TableEmpty>}
        </TableBody>
      </Table>
    </>
  );
}

const TASK_SNIPPET = `import { createCronClient } from "@mybase-dev/sdk/cron";

const cron = createCronClient({
  apiUrl: process.env.MYBASE_URL!,
  project: "<project>",
  secret: process.env.MYBASE_CRON_SECRET!,
  baseUrl: "https://your-app.example.com",
});

// Calls the "send-reminder" handler once, in a day.
await cron.schedule("send-reminder", { in: "24h", payload: { orderId }, key: \`reminder-\${orderId}\` });`;

const TASK_HEALTH: Record<CronTask["status"], Health> = { pending: "neutral", running: "progress", success: "ok", failed: "error", cancelled: "neutral" };
const TASK_LABELS: Record<CronTask["status"], string> = { pending: "Pending", running: "Running", success: "OK", failed: "Failed", cancelled: "Cancelled" };

function TaskStatus({ task }: { task: CronTask }) {
  return <StatusDot health={TASK_HEALTH[task.status]} label={`${TASK_LABELS[task.status]}${task.httpStatus !== null && (task.status === "success" || task.status === "failed") ? ` ${task.httpStatus}` : ""}`} />;
}

/** "Schedule a one-off task" (CR06): calls a URL once, at a time you pick. */
function ScheduleTaskDialog({ project, open, onOpenChange, onDone }: { project: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [job, setJob] = useState("");
  const [url, setUrl] = useState("");
  const [when, setWhen] = useState(() => new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  const [payload, setPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const at = new Date(when);
  async function submit(e: FormEvent) {
    e.preventDefault();
    let body: unknown = undefined;
    if (payload.trim()) {
      try {
        body = JSON.parse(payload);
      } catch {
        return setError("Payload must be valid JSON, or empty.");
      }
    }
    if (Number.isNaN(at.getTime())) return setError("Pick a date and time.");
    setPending(true);
    setError(null);
    try {
      await api.createCronTask(project, { job: job.trim(), url: url.trim(), runAt: at.toISOString(), payload: body });
      toast.success(`Scheduled ${job.trim()}`);
      onDone();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader className="text-left">
            <DialogTitle>Schedule a one-off task</DialogTitle>
            <DialogDescription>mybase makes one signed POST to this URL at the time below (and retries on failure), from this server.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="task-job">Handler name</Label>
            <Input id="task-job" value={job} onChange={(e) => setJob(e.target.value)} required autoFocus placeholder="send-reminder" className="font-mono md:text-[13px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-url">URL</Label>
            <Input id="task-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://app.example.com/api/cron" className="font-mono md:text-[13px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-when">Run at (your time)</Label>
            <Input id="task-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required className="w-60" />
            {!Number.isNaN(at.getTime()) && (
              <p className="text-muted-foreground">
                {at.toLocaleString()} · <TimeAgo iso={at.toISOString()} /> · {at.toISOString().replace("T", " ").slice(0, 16)} UTC
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-payload">Payload (optional JSON)</Label>
            <Textarea id="task-payload" value={payload} onChange={(e) => setPayload(e.target.value)} rows={3} spellCheck={false} className="font-mono text-base md:text-[13px]" />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Scheduling…" : "Schedule task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type TaskFilter = "all" | CronTask["status"];

function Tasks({ project }: { project: string }) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const tasks = useLoad(`cron-tasks:${project}:${filter}`, () => api.listCronTasks(project, filter === "all" ? undefined : filter), {
    keepPrevious: true,
    interval: (d) => (d?.some((t) => t.status === "running") ? POLL.progress : POLL.list),
  });
  const { state, refresh } = tasks;
  const [cancelling, setCancelling] = useState<CronTask | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);

  async function cancel() {
    if (!cancelling) return;
    try {
      await api.cancelCronTask(project, cancelling.id);
      toast.success(`Cancelled the ${cancelling.job} task`);
    } finally {
      // It may have started or finished meanwhile; show what it is now.
      invalidate(`cron-tasks:${project}:`);
    }
  }

  let body;
  if (state.status === "loading") body = <TableSkeleton label="Loading tasks" rows={2} columns={4} />;
  else if (state.status === "error") body = <ErrorPanel title="Can't list tasks" message={state.message} onRetry={refresh} />;
  else if (state.data.length === 0 && filter === "all") {
    body = (
      <EmptyState title="No tasks">
        A task calls one of your handlers once, at a set time. Schedule them from your app with <InlineCode>createCronClient</InlineCode>, or from here:
        <CodeBlock className="mt-3" code={TASK_SNIPPET.replace("<project>", project)} lang="ts" />
      </EmptyState>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Job</TableHead>
            <TableHead>Scheduled for</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((task) => {
            const expanded = open === task.id;
            return (
              <Fragment key={task.id}>
                <TableRow data-row="">
                  <TableCell>
                    <Button variant="ghost" size="icon-xs" aria-expanded={expanded} aria-label={expanded ? `Hide ${task.job} task details` : `Show ${task.job} task details`} onClick={() => setOpen(expanded ? null : task.id)}>
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{task.job}</span>
                    <span className="block max-w-xs truncate font-mono text-xs text-muted-foreground" title={task.key ? `key ${task.key} · ${task.url}` : task.url}>
                      {task.key ?? task.url}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <TimeAgo iso={task.runAt} live />
                  </TableCell>
                  <TableCell>
                    <TaskStatus task={task} />
                  </TableCell>
                  <TableCell>
                    {task.status === "pending" && (
                      <Button variant="ghost" size="sm" onClick={() => setCancelling(task)} aria-label={`Cancel the ${task.job} task`}>
                        <X />
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={4} className="whitespace-normal">
                      <Facts
                        className="py-2"
                        items={[
                          ["Task id", <CopyInline key="id" value={task.id} />],
                          ["URL", <Mono key="u">{task.url}</Mono>],
                          ["Attempts", `${task.attempts} of ${task.retries + 1}`],
                          ["Duration", task.durationMs !== null ? duration(task.durationMs) : "—"],
                          ["Created", <TimeAgo key="c" iso={task.createdAt} />],
                          ...(task.payload !== null && task.payload !== undefined ? [["Payload", <pre key="p" className="code-block whitespace-pre-wrap">{JSON.stringify(task.payload, null, 2)}</pre>] as [string, ReactNode]] : []),
                          ...(task.error ? [["Error", <span key="e" className="text-destructive">{task.error}</span>] as [string, ReactNode]] : []),
                          ...(task.response ? [["Response", <pre key="r" className="code-block max-h-48 overflow-auto whitespace-pre-wrap">{task.response}</pre>] as [string, ReactNode]] : []),
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
          {state.data.length === 0 && <TableEmpty colSpan={5}>No {filter} tasks.</TableEmpty>}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-labelledby="tasks" className="mb-8">
      <SectionHeader
        id="tasks"
        title="One-off tasks"
        live={<LiveIndicator load={tasks} />}
        actions={
          <>
            <SegmentedControl size="xs" label="Task status" value={filter} onChange={setFilter} options={(["all", "pending", "running", "success", "failed", "cancelled"] as const).map((v) => ({ value: v, label: v === "all" ? "All" : TASK_LABELS[v] }))} />
            <Button variant="outline" size="sm" onClick={() => setScheduling(true)}>
              <Plus />
              Schedule task
            </Button>
          </>
        }
      />
      {body}
      <ScheduleTaskDialog project={project} open={scheduling} onOpenChange={setScheduling} onDone={() => invalidate(`cron-tasks:${project}:`)} />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel task"
        description={cancelling ? `The ${cancelling.job} call due ${timeAgo(cancelling.runAt)} won't be made.` : ""}
        confirm="Cancel task"
        pendingLabel="Cancelling…"
        onConfirm={cancel}
      />
    </section>
  );
}

function CopyInline({ value }: { value: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <button type="button" className="inline-flex items-center gap-1 font-mono text-[13px] hover:underline" onClick={() => copy(value, "task id")}>
      {value}
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5 text-muted-foreground" />}
    </button>
  );
}

function Cron({ project, create }: { project: Project; create: boolean }) {
  const view = useServiceView();
  const [disableOpen, setDisableOpen] = useState(false);
  const setCreate = (open: boolean) => navigate({ page: "cron", name: project.name, job: null, create: open }, { replace: !open });

  async function disable() {
    await api.disableService(project.name, "cron");
    await refreshProjects();
    toast.success(`Turned off cron for ${project.name}`);
    navigate({ page: "project", name: project.name });
  }

  return (
    <>
      <PageHeader
        title="Cron"
        breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }}
        description="Calls your app's endpoints on a schedule, or once at a set time."
        action={
          <>

<Button onClick={() => setCreate(true)}>
            <Plus />
            New job
          </Button>
          </>
        }
      />
      <ServiceViews route={{ page: "cron", name: project.name, job: null, create: false }} view={view} label="Cron" main="Jobs" />
      {view !== "settings" && (
      <section aria-labelledby="jobs" className="mb-8">
        <h2 id="jobs" className="mb-2 text-base font-semibold">
          Jobs
        </h2>
        <Jobs project={project.name} onCreate={() => setCreate(true)} />
      </section>
      )}
      {view !== "settings" && <Tasks project={project.name} />}
      {view === "settings" && <SigningSecret project={project.name} />}
      {view === "settings" && (
        <DangerZone title="Delete cron data and turn off" action={<Button variant="danger-outline" onClick={() => setDisableOpen(true)}>Turn off cron…</Button>}>
          Deletes every cron job, pending task, and run history. Jobs defined in code come back the next time you sync.
        </DangerZone>
      )}
      <CreateJobDialog project={project.name} open={create} onOpenChange={setCreate} />
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title={`Turn off cron for ${project.name}`}
        description={SERVICE_PAGES.cron.turnOff}
        confirm="Turn off cron"
        pendingLabel="Turning off…"
        onConfirm={disable}
      />
    </>
  );
}

export function CronPage({ name, job, create }: { name: string; job: string | null; create: boolean }) {
  return (
    <ProjectGate name={name} title="Cron" backToProject>
      {(project) => {
        if (!project.services.includes("cron")) return <ServiceOff project={project} id="cron" />;
        return job ? <CronJobView key={job} project={project} name={job} /> : <Cron project={project} create={create} />;
      }}
    </ProjectGate>
  );
}

import { useState, type FormEvent } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import type { CronTask, Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { CodeTag, NextRun, RunResult } from "@/components/cron-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CronJobForm, emptyFields, specOf, type JobFields } from "@/components/cron-job-form";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { ServiceOff } from "@/components/service-off";
import { ConnectSheet, DangerZone, ServiceViews } from "@/components/service-layout";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { SERVICE_PAGES } from "@/components/service-card";
import { Row } from "@/components/row";
import { ErrorPanel } from "@/components/states";
import { CodeBlock } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
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

function Jobs({ project, onCreate }: { project: string; onCreate: () => void }) {
  const { state, refresh } = useLoad(`cron-jobs:${project}`, () => api.listCronJobs(project));

  if (state.status === "loading") {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading jobs">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <ErrorPanel title="Can't list cron jobs" message={state.message} onRetry={refresh} />
    );
  }
  if (state.data.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No cron jobs yet</p>
        <p className="mt-1 text-muted-foreground">
          A cron job calls a URL in your app on a schedule. Create one here, or declare them in{" "}
          <code className="font-mono text-[0.85em] text-foreground">mybase.config.ts</code> and run{" "}
          <code className="font-mono text-[0.85em] text-foreground">mybase cron sync</code>.
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onCreate}>
          <Plus />
          New job
        </Button>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Next run</TableHead>
          <TableHead>Last run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.data.map((job) => (
          <TableRow key={job.name}>
            <TableCell>
              <span className="flex items-center gap-2">
                <a
                  href={href({ page: "cron", name: project, job: job.name, create: false })}
                  className="font-medium outline-none hover:underline focus-visible:underline"
                >
                  {job.name}
                </a>
                {job.source === "code" && <CodeTag />}
              </span>
              <span className="block max-w-xs truncate font-mono text-xs text-muted-foreground" title={job.url}>
                {job.url}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">{job.schedule}</span>
              {job.timezone !== "UTC" && <span className="block text-muted-foreground">{job.timezone}</span>}
            </TableCell>
            <TableCell>
              <NextRun job={job} />
            </TableCell>
            <TableCell>
              {job.lastRun ? (
                <RunResult status={job.lastRun.status} httpStatus={job.lastRun.httpStatus} at={job.lastRun.finishedAt} />
              ) : (
                <span className="text-muted-foreground">Never</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

function TaskStatus({ task }: { task: CronTask }) {
  if (task.status === "success" || task.status === "failed") {
    return <RunResult status={task.status} httpStatus={task.httpStatus} at={task.finishedAt ?? undefined} />;
  }
  if (task.status === "cancelled") return <span className="text-muted-foreground">Cancelled</span>;
  if (task.status === "running") return <span>Running</span>;
  return <span className="text-muted-foreground">Pending</span>;
}

function Tasks({ project }: { project: string }) {
  const { state, refresh } = useLoad(`cron-tasks:${project}`, () => api.listCronTasks(project));
  const [cancelling, setCancelling] = useState<CronTask | null>(null);

  async function cancel() {
    if (!cancelling) return;
    try {
      await api.cancelCronTask(project, cancelling.id);
      toast.success(`Cancelled the ${cancelling.job} task`);
    } finally {
      // It may have started or finished meanwhile; show what it is now.
      void refresh();
    }
  }

  let body;
  if (state.status === "loading") {
    body = (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading tasks">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" />
        ))}
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <ErrorPanel title="Can't list tasks" message={state.message} onRetry={refresh} />
    );
  } else if (state.data.length === 0) {
    body = (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No tasks</p>
        <p className="mt-1 text-muted-foreground">
          A task calls one of your handlers once, at a set time. Schedule them from your app with{" "}
          <code className="font-mono text-[0.85em] text-foreground">createCronClient</code>:
        </p>
        <CodeBlock className="mt-3" code={TASK_SNIPPET.replace("<project>", project)} lang="ts" />
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((task) => (
            <TableRow key={task.id}>
              <TableCell>
                <span className="font-medium">{task.job}</span>
                <span className="block max-w-xs truncate font-mono text-xs text-muted-foreground" title={task.key ? `key ${task.key} · ${task.url}` : task.url}>
                  {task.key ?? task.url}
                </span>
              </TableCell>
              <TableCell>
                <time dateTime={task.runAt} title={formatDate(task.runAt)}>
                  {timeAgo(task.runAt)}
                </time>
              </TableCell>
              <TableCell>
                <span className="block max-w-xs truncate" title={task.error ?? undefined}>
                  <TaskStatus task={task} />
                </span>
              </TableCell>
              <TableCell>
                {task.status === "pending" && (
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(task)}>
                    <X />
                    Cancel
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-labelledby="tasks" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="tasks" className="text-base font-semibold">
          One-off tasks
        </h2>
        {state.status === "ready" && state.data.length > 0 && (
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RotateCw />
            Refresh
          </Button>
        )}
      </div>
      {body}
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

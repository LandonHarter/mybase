import { useState, type FormEvent } from "react";
import { Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import type { CronJob, Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { CodeTag, NextRun, RunResult } from "@/components/cron-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CronJobForm, emptyFields, specOf, type JobFields } from "@/components/cron-job-form";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { SERVICE_PAGES } from "@/components/service-card";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
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

const HANDLER_SNIPPET = `import { cronHandler } from "@mybase/sdk/cron";

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
    try {
      await api.rotateCronSecret(project);
      await refresh();
      toast.success("Rotated the signing secret");
    } catch (err) {
      toast.error(`Couldn't rotate the secret: ${errorMessage(err)}`);
    }
  }

  return (
    <section aria-labelledby="secret" className="mb-10">
      <h2 id="secret" className="mb-3 text-base font-semibold">
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
            Install <code className="font-mono text-[0.85em] text-foreground">@mybase/sdk</code>. The handler checks the signature and runs the job by name.
          </>
        }
      >
        <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{HANDLER_SNIPPET}</pre>
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
      <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Can't list cron jobs</p>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
          <RotateCw />
          Retry
        </Button>
      </div>
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

function Cron({ project, create }: { project: Project; create: boolean }) {
  const [disableOpen, setDisableOpen] = useState(false);
  const setCreate = (open: boolean) => navigate({ page: "cron", name: project.name, job: null, create: open }, { replace: !open });

  async function disable() {
    try {
      await api.disableService(project.name, "cron");
      await refreshProjects();
      toast.success(`Turned off cron for ${project.name}`);
      navigate({ page: "project", name: project.name });
    } catch (err) {
      toast.error(`Couldn't turn off cron: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Cron"
        breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }}
        description="Calls your app's endpoints on a schedule."
        action={
          <Button onClick={() => setCreate(true)}>
            <Plus />
            New job
          </Button>
        }
      />
      <section aria-labelledby="jobs" className="mb-10">
        <h2 id="jobs" className="mb-3 text-base font-semibold">
          Jobs
        </h2>
        <Jobs project={project.name} onCreate={() => setCreate(true)} />
      </section>
      <SigningSecret project={project.name} />
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off cron
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every job and its run history. Turning it back on makes a new secret.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDisableOpen(true)}>
            Turn off cron
          </Button>
        </div>
      </section>
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

function CronOff({ project }: { project: Project }) {
  const [pending, setPending] = useState(false);
  async function enable() {
    setPending(true);
    try {
      await api.enableService(project.name, "cron");
      await refreshProjects();
      toast.success("Turned on cron");
    } catch (err) {
      toast.error(`Couldn't turn on cron: ${errorMessage(err)}`);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader title="Cron" breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Cron is off for this project</p>
        <p className="mt-1 text-muted-foreground">Turn it on to have mybase call your app's endpoints on a schedule, signed with a secret only this project has.</p>
        <Button variant="outline" size="sm" className="mt-4" disabled={pending} onClick={enable}>
          <Plus />
          {pending ? "Turning on…" : "Turn on cron"}
        </Button>
      </div>
    </>
  );
}

export function CronPage({ name, job, create }: { name: string; job: string | null; create: boolean }) {
  return (
    <ProjectGate name={name} title="Cron" backToProject>
      {(project) => {
        if (!project.services.includes("cron")) return <CronOff project={project} />;
        return job ? <CronJobView key={job} project={project} name={job} /> : <Cron project={project} create={create} />;
      }}
    </ProjectGate>
  );
}

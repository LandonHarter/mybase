import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { SERVICES, type CronOverview, type DatabaseDetails, type Project, type ServiceId } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { SERVICE_PAGES, ServiceCard } from "@/components/service-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatBytes, formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad, type LoadState } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function databaseStatus(state: LoadState<DatabaseDetails>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error") return "Can't load stats";
  const { sizeBytes, tables } = state.data;
  return `${formatBytes(sizeBytes)} · ${plural(tables, "table", "tables")}`;
}

function cronStatus(state: LoadState<CronOverview | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load jobs";
  const { jobs, nextRunAt } = state.data;
  if (jobs === 0) return "No jobs yet";
  return (
    <>
      {plural(jobs, "job", "jobs")}
      {nextRunAt && (
        <>
          {" · next "}
          <time dateTime={nextRunAt} title={formatDate(nextRunAt)}>
            {timeAgo(nextRunAt)}
          </time>
        </>
      )}
    </>
  );
}

/** Optional services the project hasn't turned on, each with an Enable button. */
function AddService({ project }: { project: Project }) {
  const [pending, setPending] = useState<ServiceId | null>(null);
  const available = SERVICES.filter((s) => !s.core && !project.services.includes(s.id));
  if (available.length === 0) return null;

  async function enable(id: ServiceId, name: string) {
    setPending(id);
    try {
      await api.enableService(project.name, id);
      await refreshProjects();
      toast.success(`Turned on ${name}`);
      navigate(SERVICE_PAGES[id].route(project.name));
    } catch (err) {
      toast.error(`Couldn't turn on ${name}: ${errorMessage(err)}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="add-service" className="mb-10">
      <h2 id="add-service" className="mb-3 text-base font-semibold">
        Add a service
      </h2>
      {available.map((s) => {
        const Icon = SERVICE_PAGES[s.id].icon;
        return (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-4 border-t py-4">
            <span className="flex items-center gap-2.5">
              <Icon className="size-4 text-muted-foreground" />
              <span className="font-medium">{s.name}</span>
              <span className="text-muted-foreground">{s.description}</span>
            </span>
            <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => enable(s.id, s.name)}>
              <Plus />
              {pending === s.id ? "Turning on…" : `Turn on ${s.name.toLowerCase()}`}
            </Button>
          </div>
        );
      })}
    </section>
  );
}

function Overview({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const database = useLoad(`db:${project.name}`, () => api.database(project.name));
  const hasCron = project.services.includes("cron");
  const cron = useLoad(`cron:${project.name}:${hasCron}`, () => (hasCron ? api.cronOverview(project.name) : Promise.resolve(null)));

  const status: Record<ServiceId, ReactNode> = {
    database: databaseStatus(database.state),
    storage: project.storage ? (
      <span className="font-mono text-xs">{project.storage.bucket}</span>
    ) : (
      "No bucket (created before storage existed)"
    ),
    cron: cronStatus(cron.state),
  };
  // Core services, then the optional ones this project has turned on.
  const services = SERVICES.filter((s) => s.core || project.services.includes(s.id));

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            Created{" "}
            <time dateTime={project.createdAt} title={formatDate(project.createdAt)}>
              {timeAgo(project.createdAt)}
            </time>
          </>
        }
      />

      <section aria-labelledby="services" className="mb-10">
        <h2 id="services" className="mb-3 text-base font-semibold">
          Services
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((s) => (
            <ServiceCard key={s.id} id={s.id} project={project.name} name={s.name} description={s.description} status={status[s.id]} />
          ))}
        </div>
      </section>

      <AddService project={project} />

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Delete project
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Permanently deletes the database, the storage bucket, and every file in it.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={onDelete}>
            Delete project
          </Button>
        </div>
      </section>
    </>
  );
}

export function ProjectPage({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <ProjectGate name={name} title={name}>
      {(project) => <Overview project={project} onDelete={onDelete} />}
    </ProjectGate>
  );
}

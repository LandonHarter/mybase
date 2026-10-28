import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  SERVICES,
  type AnalyticsOverview,
  type CacheOverview,
  type CronOverview,
  type DatabaseDetails,
  type Project,
  type Queue,
  type SecretsOverview,
  type UsersOverview,
  type RateLimitStats,
  type RealtimeStats,
  type ServiceId,
  type VectorIndex,
} from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { SERVICE_PAGES, ServiceCard } from "@/components/service-card";
import { CredentialsDialog, type Credentials } from "@/components/service-credentials";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatBytes, formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad, type LoadState } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";

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
  const { jobs, nextRunAt, pendingTasks } = state.data;
  if (jobs === 0 && pendingTasks === 0) return "No jobs yet";
  if (jobs === 0) return plural(pendingTasks, "pending task", "pending tasks");
  return (
    <>
      {plural(jobs, "job", "jobs")}
      {pendingTasks > 0 && ` · ${plural(pendingTasks, "pending task", "pending tasks")}`}
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

function analyticsStatus(state: LoadState<AnalyticsOverview | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load analytics";
  const { pageviews, visitors } = state.data.totals;
  if (pageviews === 0 && state.data.totals.events === 0 && state.data.totals.errors === 0) return "No visits in the last 24 hours";
  return `${plural(pageviews, "view", "views")} · ${plural(visitors, "visitor", "visitors")} in 24h`;
}

function cacheStatus(state: LoadState<CacheOverview | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load the cache";
  return plural(state.data.keys, "key", "keys");
}

function rateLimitStatus(state: LoadState<RateLimitStats | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load rate limits";
  const allowed = state.data.rules.reduce((n, r) => n + r.allowed, 0);
  const blocked = state.data.rules.reduce((n, r) => n + r.blocked, 0);
  if (allowed + blocked === 0) return "No checks in the last 24 hours";
  return `${plural(blocked, "request", "requests")} blocked of ${(allowed + blocked).toLocaleString()} in 24h`;
}

function queueStatus(state: LoadState<Queue[] | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load queues";
  if (state.data.length === 0) return "No queues yet";
  const waiting = state.data.reduce((n, q) => n + q.counts.visible + q.counts.delayed, 0);
  return `${plural(state.data.length, "queue", "queues")} · ${plural(waiting, "message", "messages")} waiting`;
}

function vectorStatus(state: LoadState<VectorIndex[] | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load indexes";
  if (state.data.length === 0) return "No indexes yet";
  const docs = state.data.reduce((n, i) => n + i.documents, 0);
  return `${plural(state.data.length, "index", "indexes")} · ${plural(docs, "document", "documents")}`;
}

function usersStatus(state: LoadState<UsersOverview | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load users";
  if (!state.data.ready) return "Waiting for Better Auth's tables";
  return `${plural(state.data.users, "user", "users")} · ${plural(state.data.activeSessions, "session", "sessions")}`;
}

function realtimeStatus(state: LoadState<RealtimeStats | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load realtime";
  return `${plural(state.data.connections, "connection", "connections")} · ${plural(state.data.channels, "channel", "channels")}`;
}

function secretsStatus(state: LoadState<SecretsOverview | null>) {
  if (state.status === "loading") return <Skeleton className="h-5 w-32" />;
  if (state.status === "error" || !state.data) return "Can't load secrets";
  const keys = state.data.envs.reduce((n, e) => n + e.keys, 0);
  return `${plural(state.data.envs.length, "environment", "environments")} · ${plural(keys, "key", "keys")}`;
}

/**
 * Turns an optional service on or off from its card's switch, after a confirm step.
 * Services with secrets (cache, rate limits) hand them over in `onCredentials`.
 */
function ToggleServiceDialog({
  project,
  target,
  onClose,
  onCredentials,
}: {
  project: Project;
  target: { id: ServiceId; on: boolean } | null;
  onClose: () => void;
  onCredentials: (credentials: Credentials) => void;
}) {
  // Keep the last target while the dialog animates out.
  const [last, setLast] = useState(target);
  const linkedEnvs = useLinkedEnvs(project);
  const [link, setLink] = useState(true);
  if (target && target !== last) {
    setLast(target);
    setLink(true);
  }
  const shown = target ?? last;
  if (!shown) return null;
  const service = SERVICES.find((s) => s.id === shown.id)!;
  const { turnOn, turnOff } = SERVICE_PAGES[shown.id];
  const verb = shown.on ? "on" : "off";

  async function run() {
    try {
      const result = await (shown!.on ? api.enableService(project.name, service.id, link && linkedEnvs.length > 0) : api.disableService(project.name, service.id));
      await refreshProjects();
      if (result) onCredentials(result);
      toast.success(`Turned ${verb} ${service.name.toLowerCase()} for ${project.name}`);
    } catch (err) {
      toast.error(`Couldn't turn ${verb} ${service.name.toLowerCase()}: ${errorMessage(err)}`);
    }
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Turn ${verb} ${service.name.toLowerCase()} for ${project.name}`}
      description={shown.on ? turnOn : turnOff}
      confirm={`Turn ${verb} ${service.name.toLowerCase()}`}
      pendingLabel={`Turning ${verb}…`}
      onConfirm={run}
      destructive={!shown.on}
    >
      {shown.on && <LinkKeysOption id={shown.id} envs={linkedEnvs} checked={link} onCheckedChange={setLink} />}
    </ConfirmDialog>
  );
}

function Overview({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const database = useLoad(`db:${project.name}`, () => api.database(project.name));
  const hasCron = project.services.includes("cron");
  const cron = useLoad(`cron:${project.name}:${hasCron}`, () => (hasCron ? api.cronOverview(project.name) : Promise.resolve(null)));

  const hasAnalytics = project.services.includes("analytics");
  const analytics = useLoad(`analytics:${project.name}:${hasAnalytics}`, () =>
    hasAnalytics ? api.analyticsOverview(project.name, "24h") : Promise.resolve(null),
  );

  const hasCache = project.services.includes("cache");
  const cache = useLoad(`cache:${project.name}:${hasCache}`, () => (hasCache ? api.cacheOverview(project.name) : Promise.resolve(null)));
  const hasRateLimit = project.services.includes("ratelimit");
  const rateLimit = useLoad(`ratelimit:${project.name}:${hasRateLimit}`, () => (hasRateLimit ? api.rateLimitStats(project.name, "24h") : Promise.resolve(null)));
  const hasSecrets = project.services.includes("secrets");
  const secrets = useLoad(`secrets:${project.name}:${hasSecrets}`, () => (hasSecrets ? api.secrets(project.name) : Promise.resolve(null)));
  const hasQueue = project.services.includes("queue");
  const queues = useLoad(`queue:${project.name}:${hasQueue}`, () => (hasQueue ? api.queues(project.name) : Promise.resolve(null)));

  const hasUsers = project.services.includes("users");
  const appUsers = useLoad(`users:${project.name}:${hasUsers}`, () => (hasUsers ? api.usersOverview(project.name) : Promise.resolve(null)));

  const hasRealtime = project.services.includes("realtime");
  const realtime = useLoad(`realtime:${project.name}:${hasRealtime}`, () => (hasRealtime ? api.realtimeStats(project.name) : Promise.resolve(null)));

  const hasVector = project.services.includes("vector");
  const vectorIndexes = useLoad(`vector:${project.name}:${hasVector}`, () => (hasVector ? api.vectorIndexes(project.name) : Promise.resolve(null)));

  const status: Record<ServiceId, ReactNode> = {
    database: databaseStatus(database.state),
    storage: project.storage ? (
      <span className="font-mono text-xs">{project.storage.bucket}</span>
    ) : (
      "No bucket (created before storage existed)"
    ),
    cron: cronStatus(cron.state),
    analytics: analyticsStatus(analytics.state),
    cache: cacheStatus(cache.state),
    ratelimit: rateLimitStatus(rateLimit.state),
    queue: queueStatus(queues.state),
    search: "Search and page reads through the SDK",
    secrets: secretsStatus(secrets.state),
    vector: vectorStatus(vectorIndexes.state),
    users: usersStatus(appUsers.state),
    captcha: "Bot checks for your forms",
    realtime: realtimeStatus(realtime.state),
  };
  const [toggle, setToggle] = useState<{ id: ServiceId; on: boolean } | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

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
          {SERVICES.map((s) => (
            <ServiceCard
              key={s.id}
              id={s.id}
              project={project.name}
              name={s.name}
              description={s.description}
              status={status[s.id]}
              on={s.core || project.services.includes(s.id)}
              onToggle={s.core ? undefined : (on) => setToggle({ id: s.id, on })}
            />
          ))}
        </div>
      </section>
      <ToggleServiceDialog project={project} target={toggle} onClose={() => setToggle(null)} onCredentials={setCredentials} />
      <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />

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

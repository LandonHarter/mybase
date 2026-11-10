import { useState, type ReactNode } from "react";
import { CircleAlert, Copy, Check, KeyRound, MoreHorizontal, Plus, Settings, SquareTerminal, Trash2, Upload } from "lucide-react";
import { SERVICES, type ApiToken, type AuditEventRecord, type Project, type ProjectContext, type ServiceId } from "@mybase/shared";
import { KeyDialog } from "@/components/api-tokens";
import { CodeBlock } from "@/components/code-block";
import { CopyField } from "@/components/copy-field";
import { EditProjectDialog } from "@/components/edit-project-dialog";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_GROUPS, SERVICE_PAGES } from "@/components/service-card";
import { ConnectMethod, ConnectSheet, Panel } from "@/components/service-layout";
import { useEnableService } from "@/components/service-off";
import { Sparkline } from "@/components/sparkline";
import { CardGridSkeleton, ErrorPanel } from "@/components/states";
import { Badge, LiveIndicator, Mono, Section, StatusDot } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useCopy } from "@/lib/clipboard";
import { useCommands } from "@/lib/commands";
import { formatBytes, formatCount, plural } from "@/lib/format";
import { useLoad, type Load } from "@/lib/load";
import { href, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

const projectLabel = (p: Project) => p.displayName || p.name;

/** `postgresql://shop:<password>@pi.local:5432/shop`: the password is shown once at creation, so it's a template. */
export const databaseUrlTemplate = (p: Project) =>
  `postgresql://${p.database.user}:<password>@${p.database.host}:${p.database.port}/${p.database.name}${p.database.ssl ? "?sslmode=require" : ""}`;

/** The project's context: names and counts for every enabled service, in one request (P08). */
export function useProjectContext(name: string) {
  return useLoad(`context:${name}`, () => api.projectContext(name), { maxAge: 15_000 });
}

/** A small value with a copy button, for the quick-connect strip (D28). */
function CopyChip({ label, value, display }: { label: string; value: string; display?: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-surface py-0.5 pr-0.5 pl-2.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Mono className="min-w-0 truncate" title={value}>
        {display ?? value}
      </Mono>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${label}`} onClick={() => copy(value, label)}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </span>
  );
}

/** What a panel shows while its own data loads or fails; essentials (context) come first. */
function Pending({ load, label, children }: { load: Pick<Load<unknown>, "state" | "refresh">; label: string; children: () => ReactNode }) {
  if (load.state.status === "loading") return <Skeleton className="h-5 w-40" aria-label={`Loading ${label}`} />;
  if (load.state.status === "error")
    return (
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>Couldn't load {label}.</span>
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load.refresh()}>
          Retry
        </button>
      </p>
    );
  return <>{children()}</>;
}

const Stat = ({ value, label }: { value: ReactNode; label: string }) => (
  <div className="min-w-0">
    <div className="metric text-xl">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="grid gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
        <div className={cn("h-full rounded-full", pct > 95 ? "bg-destructive" : pct > 80 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** One enabled service as a live panel with real numbers (P02). Never a description posing as status. */
function ServicePanel({ project, id, context }: { project: Project; id: ServiceId; context: Load<ProjectContext> }) {
  const name = project.name;
  const page = SERVICE_PAGES[id];
  const title = SERVICES.find((s) => s.id === id)!.name;
  const c = context.data;
  const to = page.route(name);

  // Numbers context.ts doesn't carry, each its own cached request, only for the panel that needs it.
  const database = useLoad(`db:${name}${id === "database" ? "" : ":off"}`, () => (id === "database" ? api.database(name) : Promise.resolve(null)), { maxAge: 30_000 });
  const tables = useLoad(`tables:${name}${id === "database" ? "" : ":off"}`, () => (id === "database" ? api.listTables(name) : Promise.resolve([])), { maxAge: 30_000 });
  const cache = useLoad(`cache:${name}:${id === "cache"}`, () => (id === "cache" ? api.cacheOverview(name) : Promise.resolve(null)), { maxAge: 30_000 });
  const analytics = useLoad(`analytics:${name}:24h:${id === "analytics"}`, () => (id === "analytics" ? api.analyticsOverview(name, "24h") : Promise.resolve(null)), { maxAge: 60_000 });
  const queueStats = useLoad(`queue-stats:${name}:24h:${id === "queue"}`, () => (id === "queue" ? api.queueStats(name, "24h") : Promise.resolve(null)), { maxAge: 60_000 });
  const realtime = useLoad(`realtime:${name}:${id === "realtime"}`, () => (id === "realtime" ? api.realtimeStats(name) : Promise.resolve(null)), { maxAge: 15_000 });
  const sandbox = useLoad(`sandbox:${name}:${id === "sandbox"}`, () => (id === "sandbox" ? api.sandboxUsage(name) : Promise.resolve(null)), { maxAge: 15_000 });
  const users = useLoad(`users-overview:${name}:${id === "users"}`, () => (id === "users" ? api.usersOverview(name) : Promise.resolve(null)), { maxAge: 30_000 });

  let body: ReactNode = null;
  let action: ReactNode = null;
  switch (id) {
    case "database":
      action = (
        <Button asChild variant="ghost" size="xs">
          <a href={href({ page: "database", name, tab: "sql", table: null })}>
            <SquareTerminal />
            Open SQL
          </a>
        </Button>
      );
      body = (
        <Pending load={database} label="database stats">
          {() => {
            const d = database.data!;
            const largest = [...(tables.data ?? [])]
              .filter((t) => t.estimatedRows !== null)
              .sort((a, b) => (b.estimatedRows ?? 0) - (a.estimatedRows ?? 0))
              .slice(0, 3);
            return (
              <div className="grid gap-3">
                <div className="flex gap-6">
                  <Stat value={formatBytes(d.sizeBytes)} label="size" />
                  <Stat value={formatCount(d.tables)} label={d.tables === 1 ? "table" : "tables"} />
                  <Stat value={`${d.activeConnections}${d.connectionLimit !== null ? `/${d.connectionLimit}` : ""}`} label="connections" />
                </div>
                {largest.length > 0 && (
                  <ul className="grid gap-1">
                    {largest.map((t) => (
                      <li key={`${t.schema}.${t.name}`} className="flex justify-between gap-3">
                        <a className="truncate font-mono text-[13px] hover:underline" href={href({ page: "database", name, tab: "tables", table: `${t.schema}.${t.name}` })}>
                          {t.schema === "public" ? t.name : `${t.schema}.${t.name}`}
                        </a>
                        <span className="text-muted-foreground tabular-nums">~{formatCount(t.estimatedRows ?? 0)} rows</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "storage":
      action = (
        <Button asChild variant="ghost" size="xs">
          <a href={href({ page: "storage", name, prefix: "" })}>
            <Upload />
            Upload
          </a>
        </Button>
      );
      body = project.storage ? (
        <div className="grid gap-1">
          <Mono>{project.storage.bucket}</Mono>
          <span className="text-muted-foreground">
            Files under <Mono>public/</Mono> are readable by anyone with the link.
          </span>
        </div>
      ) : (
        <p className="text-muted-foreground">No bucket: this project was created before storage existed.</p>
      );
      break;
    case "cron":
      body = (
        <Pending load={context} label="jobs">
          {() => {
            const jobs = c?.cron?.jobs ?? [];
            if (jobs.length === 0) return <p className="text-muted-foreground">No jobs yet.</p>;
            const next = jobs
              .map((j) => j.nextRunAt)
              .filter((x): x is string => x !== null)
              .sort()[0];
            return (
              <div className="grid gap-2">
                {next && (
                  <p>
                    Next run <TimeAgo iso={next} live />
                  </p>
                )}
                <ul className="grid gap-1">
                  {jobs.slice(0, 5).map((j) => (
                    <li key={j.name} className="flex items-center justify-between gap-3">
                      <a className="truncate hover:underline" href={href({ page: "cron", name, job: j.name, create: false })}>
                        {j.name}
                      </a>
                      {!j.enabled ? (
                        <StatusDot health="neutral" label="Paused" />
                      ) : j.lastRun ? (
                        <StatusDot health={j.lastRun.status === "success" ? "ok" : "error"} label={j.lastRun.status === "success" ? "OK" : `Failed${j.lastRun.httpStatus ? ` ${j.lastRun.httpStatus}` : ""}`} />
                      ) : (
                        <span className="text-muted-foreground">Not run yet</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "queue":
      body = (
        <Pending load={context} label="queues">
          {() => {
            const queues = c?.queue?.queues ?? [];
            if (queues.length === 0) return <p className="text-muted-foreground">No queues yet.</p>;
            const waiting = queues.reduce((n, q) => n + q.counts.visible + q.counts.delayed, 0);
            const deadNames = new Set(queues.map((q) => q.deadLetter?.queue).filter(Boolean));
            const dead = queues.filter((q) => deadNames.has(q.name)).reduce((n, q) => n + q.counts.visible, 0);
            const series = queueStats.data?.queues ?? [];
            const points = series[0]?.series.map((_, i) => series.reduce((n, q) => n + (q.series[i]?.sent ?? 0), 0)) ?? [];
            return (
              <div className="flex items-end justify-between gap-4">
                <div className="flex gap-6">
                  <Stat value={formatCount(waiting)} label="waiting" />
                  <Stat value={<span className={cn(dead > 0 && "text-destructive")}>{formatCount(dead)}</span>} label="dead letters" />
                  <Stat value={formatCount(queues.length)} label={queues.length === 1 ? "queue" : "queues"} />
                </div>
                <Sparkline values={points} label="Messages sent per hour, last 24 hours" width={72} height={20} />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "cache":
      body = (
        <Pending load={cache} label="the cache">
          {() => {
            const d = cache.data!;
            return (
              <div className="grid gap-3">
                <Stat value={formatCount(d.keys)} label={d.keys === 1 ? "key" : "keys"} />
                <Bar value={d.memory.usedBytes} max={d.memory.maxBytes} label={`Shared memory ${formatBytes(d.memory.usedBytes)} of ${formatBytes(d.memory.maxBytes)}`} />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "hosting":
      body = (
        <Pending load={context} label="sites">
          {() => {
            const sites = c?.hosting?.sites ?? [];
            if (sites.length === 0) return <p className="text-muted-foreground">No sites yet.</p>;
            return (
              <ul className="grid gap-1.5">
                {sites.map((s) => (
                  <li key={s.name} className="flex items-center justify-between gap-3">
                    <a className="min-w-0 truncate font-mono text-[13px] hover:underline" href={href({ page: "hosting", name, site: s.name })}>
                      {(s.url ?? `${s.name}.localhost`).replace(/^https?:\/\//, "")}
                    </a>
                    {s.liveDeploy ? (
                      <StatusDot health={s.status === "failed" ? "warning" : "ok"} label={s.status === "failed" ? "Live · last deploy failed" : "Live"} />
                    ) : s.status === "queued" || s.status === "starting" ? (
                      <StatusDot health="progress" label="Deploying" />
                    ) : (
                      <StatusDot health="neutral" label="Not serving" />
                    )}
                  </li>
                ))}
              </ul>
            );
          }}
        </Pending>
      );
      break;
    case "registry":
      body = (
        <Pending load={context} label="repositories">
          {() => {
            const repos = c?.registry?.repositories ?? [];
            const tags = repos.reduce((n, r) => n + r.tags, 0);
            return repos.length === 0 ? (
              <p className="text-muted-foreground">No images yet.</p>
            ) : (
              <div className="flex gap-6">
                <Stat value={formatCount(repos.length)} label={repos.length === 1 ? "repository" : "repositories"} />
                <Stat value={formatCount(tags)} label={tags === 1 ? "tag" : "tags"} />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "analytics":
      body = (
        <Pending load={analytics} label="analytics">
          {() => {
            const a = analytics.data!;
            return (
              <div className="flex items-end justify-between gap-4">
                <div className="flex gap-6">
                  <Stat value={formatCount(a.totals.pageviews)} label="views, 24h" />
                  <Stat value={formatCount(a.totals.visitors)} label="visitors" />
                  {a.totals.errors > 0 && <Stat value={<span className="text-destructive">{formatCount(a.totals.errors)}</span>} label="errors" />}
                </div>
                <Sparkline values={a.series.map((p) => p.pageviews)} label="Page views per hour, last 24 hours" width={72} height={20} />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "users":
      body = (
        <Pending load={users} label="users">
          {() => {
            const u = users.data!;
            if (!u.ready) return <p className="text-muted-foreground">Setup required: waiting for Better Auth's tables.</p>;
            return (
              <div className="flex gap-6">
                <Stat value={formatCount(u.users)} label={u.users === 1 ? "user" : "users"} />
                <Stat value={formatCount(u.activeSessions)} label="active sessions" />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "realtime":
      body = (
        <Pending load={realtime} label="realtime">
          {() => (
            <div className="flex items-end justify-between gap-4">
              <div className="flex gap-6">
                <Stat value={formatCount(realtime.data!.connections)} label="connected now" />
                <Stat value={formatCount(realtime.data!.channels)} label="channels" />
              </div>
              <Sparkline values={realtime.data!.hours.map((h) => h.messagesIn + h.messagesOut)} label="Messages per hour" width={72} height={20} />
            </div>
          )}
        </Pending>
      );
      break;
    case "secrets":
      body = (
        <Pending load={context} label="environments">
          {() => {
            const envs = c?.secrets?.envs ?? [];
            if (envs.length === 0) return <p className="text-muted-foreground">No environments yet.</p>;
            return (
              <div className="flex flex-wrap gap-1.5">
                {envs.map((e) => (
                  <a key={e.name} href={href({ page: "secrets", name, env: e.name })} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <Badge mono tone="outline" title={`${e.keys.length} keys${e.linked ? ", linked" : ""}`}>
                      {e.parent ? "↳ " : ""}
                      {e.name} · {e.keys.length}
                    </Badge>
                  </a>
                ))}
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "vector":
      body = (
        <Pending load={context} label="indexes">
          {() => {
            const idx = c?.vector?.indexes ?? [];
            const docs = idx.reduce((n, i) => n + i.documents, 0);
            return idx.length === 0 ? (
              <p className="text-muted-foreground">No indexes yet.</p>
            ) : (
              <div className="flex gap-6">
                <Stat value={formatCount(idx.length)} label={idx.length === 1 ? "index" : "indexes"} />
                <Stat value={formatCount(docs)} label="documents" />
              </div>
            );
          }}
        </Pending>
      );
      break;
    case "ratelimit":
      body = <Pending load={context} label="rules">{() => <p>{plural(c?.ratelimit?.rules.length ?? 0, "rule", "rules")}</p>}</Pending>;
      break;
    case "sandbox":
      body = (
        <Pending load={sandbox} label="sandboxes">
          {() => (
            <div className="flex gap-6">
              <Stat value={formatCount(sandbox.data!.active)} label="active" />
              <Stat value={formatCount(sandbox.data!.executionsToday)} label="executions today" />
            </div>
          )}
        </Pending>
      );
      break;
    case "search":
      body = <p className="text-muted-foreground">Enabled · apps search through the SDK; no usage numbers are recorded.</p>;
      break;
    case "captcha":
      body = (
        <p className="text-muted-foreground">
          Enabled · widget at <Mono>/captcha.js</Mono>
        </p>
      );
      break;
    case "email":
      body = (
        <Pending load={context} label="email">
          {() => {
            const e = c?.email;
            if (!e) return <p className="text-muted-foreground">Enabled</p>;
            const verified = e.domains.filter((d) => d.status === "verified").length;
            return e.domains.length === 0 ? (
              <p className="text-muted-foreground">No domains yet: add one to start sending.</p>
            ) : (
              <div className="flex gap-6">
                <Stat value={formatCount(e.last7Days.sent)} label="sent in 7 days" />
                <Stat value={formatCount(e.templates.length)} label={e.templates.length === 1 ? "template" : "templates"} />
                <Stat value={`${verified}/${e.domains.length}`} label="domains verified" />
              </div>
            );
          }}
        </Pending>
      );
      break;
  }

  return (
    <Panel title={title} icon={page.icon} to={to} action={action}>
      {body}
    </Panel>
  );
}

/** Things that need a look, from data the panels already loaded (no extra requests). */
function attention(project: Project, c: ProjectContext | undefined): { text: ReactNode; to: Route }[] {
  if (!c) return [];
  const items: { text: ReactNode; to: Route }[] = [];
  const name = project.name;
  for (const j of c.cron?.jobs ?? [])
    if (j.enabled && j.lastRun?.status === "failed")
      items.push({
        text: (
          <>
            Cron job <Mono>{j.name}</Mono> failed its last run{j.lastRun.httpStatus ? ` (${j.lastRun.httpStatus})` : ""}
          </>
        ),
        to: { page: "cron", name, job: j.name, create: false },
      });
  const deadNames = new Set((c.queue?.queues ?? []).map((q) => q.deadLetter?.queue).filter(Boolean));
  for (const q of c.queue?.queues ?? [])
    if (deadNames.has(q.name) && q.counts.visible > 0)
      items.push({
        text: (
          <>
            {plural(q.counts.visible, "dead letter", "dead letters")} in <Mono>{q.name}</Mono>
          </>
        ),
        to: { page: "queue", name, queue: q.name },
      });
  for (const s of c.hosting?.sites ?? [])
    if (s.status === "failed")
      items.push({
        text: (
          <>
            Site <Mono>{s.name}</Mono>: last deploy failed{s.liveDeploy ? "; the previous version is still serving" : ""}
          </>
        ),
        to: { page: "hosting", name, site: s.name },
      });
  if (c.users && !c.users.ready) items.push({ text: "Users: run your app's Better Auth migrations to create its tables", to: { page: "users", name, user: null, query: "" } });
  return items;
}

/** One line of the always-visible "Add a service" list (D27). */
function AddService({ project, id }: { project: Project; id: ServiceId }) {
  const page = SERVICE_PAGES[id];
  const service = SERVICES.find((s) => s.id === id)!;
  const e = useEnableService(project, id);
  return (
    <li className="flex items-center gap-3 border-b py-2 last:border-0">
      <page.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <a href={href(page.route(project.name))} className="font-medium hover:underline">
          {service.name}
        </a>
        <span className="text-muted-foreground"> · {page.summary}</span>
      </span>
      <Button variant="outline" size="sm" disabled={e.pending || e.blocked} onClick={() => void e.start()} aria-label={`Turn on ${service.name}`}>
        {e.pending ? "Turning on…" : "Turn on"}
      </Button>
      {e.dialogs}
    </li>
  );
}

function ActivityPanel({ project }: { project: string }) {
  const audit = useLoad(`audit:project:${project}`, () => api.audit({ project, limit: 10 }), { maxAge: 30_000 });
  return (
    <Section
      id="activity"
      title="Activity"
      live={<LiveIndicator load={audit} />}
      actions={
        <a href={href({ page: "security", tab: "audit", project })} className="text-muted-foreground hover:text-foreground hover:underline">
          Audit log
        </a>
      }
    >
      <Pending load={audit} label="activity">
        {() => {
          const events = audit.data!.events;
          if (events.length === 0) return <p className="text-muted-foreground">Nothing recorded for this project yet.</p>;
          return (
            <ul className="grid max-w-3xl">
              {events.map((e: AuditEventRecord) => (
                <li key={e.id} className="flex items-baseline gap-3 border-b py-1.5 last:border-0">
                  <span className="min-w-0 flex-1 truncate">
                    <Mono className="text-xs">{e.action}</Mono>
                    {e.target && <span className="text-muted-foreground"> · {e.target}</span>}
                    {e.outcome !== "ok" && (
                      <Badge className="ml-2" tone={e.outcome === "denied" ? "danger" : "warning"}>
                        {e.outcome}
                      </Badge>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {e.actor.name ?? e.actor.kind} · <TimeAgo iso={e.at} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }}
      </Pending>
    </Section>
  );
}

/** The project's Connect sheet (P05): what an app needs, with the real values. */
function ProjectConnect({ project, context, open, onOpenChange }: { project: Project; context: ProjectContext | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [keyOpen, setKeyOpen] = useState(false);
  const s = project.storage;
  const env = [
    `DATABASE_URL=${databaseUrlTemplate(project)}`,
    ...(s ? [`S3_ENDPOINT=${s.endpoint}`, `S3_REGION=${s.region}`, `S3_BUCKET=${s.bucket}`, "S3_ACCESS_KEY_ID=<access key id>", "S3_SECRET_ACCESS_KEY=<secret access key>"] : []),
    ...(context?.cache ? [`REDIS_URL=${context.cache.url.replace("@", ":<password>@")}`] : []),
    ...(context ? [`MYBASE_API_URL=${context.apiUrl}`, "MYBASE_API_KEY=<a key for this project>"] : []),
  ].join("\n");
  return (
    <ConnectSheet
      title={`Connect an app to ${projectLabel(project)}`}
      description="Passwords and secret keys were shown once, at creation. Rotate and store them with the secrets service, or use an API key."
      open={open}
      onOpenChange={onOpenChange}
    >
      <ConnectMethod title="Environment" hint="The usual variables for an app on this project. Fill in the placeholders.">
        <CodeBlock code={env} lang="env" />
      </ConnectMethod>
      <ConnectMethod title="Database">
        <CopyField id="connect-db" label="Connection string (template)" value={databaseUrlTemplate(project)} />
        <CopyField id="connect-ws" label="Over WebSocket (serverless hosts)" value={project.database.wsUrl} />
      </ConnectMethod>
      {s && (
        <ConnectMethod title="Storage (S3)">
          <CopyField id="connect-s3" label="Endpoint" value={s.endpoint} />
          <div className="grid gap-3 sm:grid-cols-2">
            <CopyField id="connect-bucket" label="Bucket" value={s.bucket} />
            <CopyField id="connect-region" label="Region" value={s.region} />
          </div>
        </ConnectMethod>
      )}
      <ConnectMethod title="API key" hint="Apps call mybase's services with a key limited to this project.">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setKeyOpen(true)}>
            <KeyRound />
            Create API key for {projectLabel(project)}
          </Button>
          {project.services.includes("secrets") && (
            <Button asChild variant="ghost">
              <a href={href({ page: "secrets", name: project.name, env: null })}>Link credentials to secrets</a>
            </Button>
          )}
        </div>
      </ConnectMethod>
      <ConnectMethod title="AI agents" hint="Writes AGENTS.md, a skill, and .mcp.json for this project into the current repo.">
        <CodeBlock code={`mybase agent init --project ${project.name}`} lang="bash" />
      </ConnectMethod>
      <KeyDialog open={keyOpen} onOpenChange={setKeyOpen} preset={{ name: `${project.name} app`, permissions: [], projects: [project.name] }} />
    </ConnectSheet>
  );
}

function Overview({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const context = useProjectContext(project.name);
  const [editing, setEditing] = useState(false);
  const [connect, setConnect] = useState(false);
  const { copied, copy } = useCopy(project.name);
  const enabled = SERVICES.filter((s) => s.core || project.services.includes(s.id));
  const off = SERVICES.filter((s) => !s.core && !project.services.includes(s.id));
  const items = attention(project, context.data);
  const site = context.data?.hosting?.sites.find((s) => s.liveDeploy && s.url);
  useCommands([
    { id: "connect", label: "Connect an app", keywords: "database url env credentials", run: () => setConnect(true) },
    { id: "edit", label: "Rename or describe this project", run: () => setEditing(true) },
  ]);

  return (
    <>
      <PageHeader
        size="lg"
        title={projectLabel(project)}
        aside={
          <button
            type="button"
            onClick={() => copy(project.name, "project name")}
            className="inline-flex items-center gap-1 rounded-sm font-mono text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            title="Copy the project name"
          >
            {project.name}
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        }
        description={
          <>
            {project.description && <span className="mb-1 block whitespace-pre-line text-foreground">{project.description}</span>}
            {plural(enabled.length, "service", "services")} · created <TimeAgo iso={project.createdAt} />
          </>
        }
        action={
          <>
            <ProjectConnect project={project} context={context.data} open={connect} onOpenChange={setConnect} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More project actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}>Rename or describe</DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={href({ page: "project-settings", name: project.name })}>
                    <Settings />
                    Project settings
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
                  <Trash2 />
                  Delete project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />

      <div className="-mt-3 mb-8 flex flex-wrap gap-2" aria-label="Quick connect">
        <CopyChip label="DATABASE_URL" value={databaseUrlTemplate(project)} display={`postgresql://${project.database.user}:…@${project.database.host}:${project.database.port}/${project.database.name}`} />
        {project.storage && <CopyChip label="Bucket" value={project.storage.bucket} />}
        {site?.url && <CopyChip label="Site" value={site.url} display={site.url.replace(/^https?:\/\//, "")} />}
      </div>

      {items.length > 0 && (
        <Section id="attention" title="Needs attention">
          <ul className="grid gap-1.5">
            {items.map((it, i) => (
              <li key={i} className="flex items-center gap-2">
                <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
                <a href={href(it.to)} className="hover:underline">
                  {it.text}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section id="enabled" title="Enabled" count={enabled.length} live={<LiveIndicator load={context} />}>
        {context.state.status === "loading" ? (
          <CardGridSkeleton label="Loading services" cards={Math.min(6, enabled.length)} className="lg:grid-cols-3" />
        ) : context.state.status === "error" ? (
          <ErrorPanel title="Can't load this project's services" message={context.state.message} onRetry={() => void context.refresh()} />
        ) : (
          SERVICE_GROUPS.map((g) => {
            const list = enabled.filter((s) => SERVICE_PAGES[s.id].group === g.id);
            if (list.length === 0) return null;
            return (
              <div key={g.id} className="mb-4">
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">{g.label}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((s) => (
                    <ServicePanel key={s.id} project={project} id={s.id} context={context} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </Section>

      <ActivityPanel project={project.name} />

      {off.length > 0 && (
        <Section id="add-service" title="Add a service" count={off.length}>
          <ul className="max-w-3xl">
            {off.map((s) => (
              <AddService key={s.id} project={project} id={s.id} />
            ))}
          </ul>
        </Section>
      )}
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

function ProjectKeys({ project }: { project: string }) {
  const tokens = useLoad("tokens", api.listTokens);
  const [open, setOpen] = useState(false);
  const mine = (tokens.data ?? []).filter((t: ApiToken) => t.projects?.includes(project));
  return (
    <>
      <Pending load={tokens} label="API keys">
        {() =>
          mine.length === 0 ? (
            <p className="text-muted-foreground">No keys limited to this project. Admin keys and keys for all projects also work here.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead className="text-right">Last used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground" title={t.permissions.join(", ")}>
                      {t.permissions.join(", ")}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{t.lastUsedAt ? <TimeAgo iso={t.lastUsedAt} /> : "Never used"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </Pending>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus />
          Create key for this project
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href={href({ page: "settings", newToken: false, section: "api-keys" })}>All API keys</a>
        </Button>
      </div>
      <KeyDialog open={open} onOpenChange={setOpen} onSaved={() => void tokens.refresh()} preset={{ name: `${project} app`, permissions: [], projects: [project] }} />
    </>
  );
}

/** `#/projects/<name>/settings` (P07): details, keys limited to it, agents, delete. */
export function ProjectSettingsPage({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <ProjectGate name={name} title="Project settings" backToProject>
      {(project) => <ProjectSettings project={project} onDelete={onDelete} />}
    </ProjectGate>
  );
}

function ProjectSettings({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <PageHeader title="Project settings" breadcrumb={{ label: projectLabel(project), href: href({ page: "project", name: project.name }) }} />
      <Row id="details" title="Details" hint="The display name and description are shown in the dashboard. The project name is fixed: apps and URLs use it.">
        <div className="grid gap-2">
          <p>
            <span className="font-medium">{project.displayName || "No display name"}</span> · <Mono>{project.name}</Mono>
          </p>
          {project.description && <p className="whitespace-pre-line text-muted-foreground">{project.description}</p>}
          <div>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Rename or describe
            </Button>
          </div>
        </div>
      </Row>
      <Row id="keys" title="API keys" hint="Keys limited to this project. Create one per app, with only the permissions it needs.">
        <ProjectKeys project={project.name} />
      </Row>
      <Row id="agents" title="AI agents" hint="Run in your app's repo: writes AGENTS.md, a skill, and .mcp.json for this project.">
        <CodeBlock code={`mybase agent init --project ${project.name}`} lang="bash" />
      </Row>
      <Row id="delete" title="Delete project" hint="Deletes the database, the bucket, and every enabled service's data. Shows what will be removed first. Can't be undone.">
        <Button variant="danger-outline" onClick={onDelete}>
          <Trash2 />
          Delete project…
        </Button>
      </Row>
      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />
    </>
  );
}

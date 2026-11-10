import { Plus, Search } from "lucide-react";
import { SERVICES, type AuditEventList, type Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { ProjectMark } from "@/components/project-switcher";
import { SERVICE_PAGES } from "@/components/service-card";
import { EmptyState, OfflinePanel, TableSkeleton } from "@/components/states";
import { Empty, LiveIndicator, Mono } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { formatBytes, plural } from "@/lib/format";
import { peek, useLoad } from "@/lib/load";
import { useProjects } from "@/lib/projects";
import { useRecentProjects } from "@/lib/recent";
import { href, navigate, PROJECT_SORTS, type ProjectSort } from "@/lib/router";

const SORT_LABELS: Record<ProjectSort, string> = { recent: "Recently opened", newest: "Newest", name: "Name", size: "Database size" };

/** One project's database size: its own cached request (the Overview shares it). Nothing invented while loading. */
function DatabaseSize({ name }: { name: string }) {
  const db = useLoad(`db:${name}`, () => api.database(name), { maxAge: 60_000 });
  if (db.state.status !== "ready") return <span className="text-muted-foreground">{db.state.status === "loading" ? "" : "—"}</span>;
  return <span className="tabular-nums">{formatBytes(db.state.data.sizeBytes)}</span>;
}

/** Icon pills linking to each service the project has on (P01). */
function ServicePills({ project }: { project: Project }) {
  const on = SERVICES.filter((s) => s.core || project.services.includes(s.id));
  return (
    <span className="relative z-10 grid w-max grid-cols-4 gap-0.5">
      {on.map((s) => {
        const Icon = SERVICE_PAGES[s.id].icon;
        return (
          <a key={s.id} href={href(SERVICE_PAGES[s.id].route(project.name))} title={s.name} aria-label={`${s.name} in ${project.displayName || project.name}`} className="grid size-6 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Icon className="size-3.5" aria-hidden />
          </a>
        );
      })}
    </span>
  );
}

export function ProjectsPage({ query, sort, onCreate }: { query: string; sort: ProjectSort; onCreate: () => void }) {
  const { state, refresh } = useProjects();
  const recent = useRecentProjects(undefined);
  // Last activity per project from one audit read (not one request per row).
  const audit = useLoad("audit:recent", () => api.audit({ limit: 200 }), { maxAge: 60_000 });
  useCommands([{ id: "create-project", label: "Create project", icon: Plus, run: onCreate }]);

  const createButton = (
    <Button onClick={onCreate} data-shortcut="create">
      <Plus />
      Create project
    </Button>
  );

  if (state.status === "offline") {
    return (
      <>
        <PageHeader title="Projects" size="lg" />
        <OfflinePanel onRetry={refresh} />
      </>
    );
  }
  if (state.status === "loading") {
    return (
      <>
        <PageHeader title="Projects" size="lg" action={createButton} />
        <TableSkeleton label="Loading projects" rows={3} columns={5} />
      </>
    );
  }

  const { projects } = state;
  if (projects.length === 0) {
    return (
      <>
        <PageHeader title="Projects" size="lg" />
        <EmptyState title="No projects yet" action={createButton}>
          A project is one app's backend: its own Postgres database and storage bucket, with credentials to use them. Turn on more services (cron, queues, hosting…) per project.
        </EmptyState>
      </>
    );
  }

  const lastActivity = new Map<string, string>();
  for (const e of (audit.data as AuditEventList | undefined)?.events ?? []) if (e.project && !lastActivity.has(e.project)) lastActivity.set(e.project, e.at);

  const needle = query.trim().toLowerCase();
  const matches = (p: Project) =>
    !needle ||
    [p.name, p.displayName ?? "", p.description ?? "", ...SERVICES.filter((s) => s.core || p.services.includes(s.id)).map((s) => s.name)].some((v) => v.toLowerCase().includes(needle));
  const rank = new Map(recent.map((n, i) => [n, i]));
  const size = (p: Project) => peek<{ sizeBytes: number }>(`db:${p.name}`)?.sizeBytes ?? -1;
  const sorted = projects.filter(matches).sort((a, b) => {
    if (sort === "name") return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    if (sort === "newest") return b.createdAt.localeCompare(a.createdAt);
    if (sort === "size") return size(b) - size(a);
    return (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99) || b.createdAt.localeCompare(a.createdAt);
  });
  const host = typeof location === "undefined" ? "this server" : location.hostname;

  return (
    <>
      <PageHeader title="Projects" size="lg" description={`${plural(projects.length, "project", "projects")} on ${host}`} action={createButton} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            data-filter=""
            aria-label="Filter projects"
            placeholder="Filter by name, description, or service"
            className="pl-8"
            value={query}
            onChange={(e) => navigate({ page: "projects", query: e.target.value, sort }, { replace: true })}
          />
        </div>
        <label className="flex items-center gap-2 text-muted-foreground">
          <span className="sr-only sm:not-sr-only">Sort</span>
          <Select value={sort} aria-label="Sort projects" onChange={(e) => navigate({ page: "projects", query, sort: e.target.value as ProjectSort }, { replace: true })} className="h-9 w-44">
            {PROJECT_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>
        <LiveIndicator className="ml-auto" load={{ ...audit, refresh: async () => void (await Promise.all([refresh(), audit.refresh()])) }} />
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-full">Name</TableHead>
            <TableHead>Services</TableHead>
            <TableHead className="text-right">Database</TableHead>
            <TableHead className="text-right">Activity</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => {
            const last = lastActivity.get(p.name);
            return (
              <TableRow key={p.name} className="relative h-auto" data-row="">
                <TableCell className="py-2">
                  <div className="flex items-start gap-2.5">
                    <ProjectMark name={p.name} className="mt-0.5" />
                    <div className="min-w-0">
                      <a href={href({ page: "project", name: p.name })} className="font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline">
                        {p.displayName || p.name}
                      </a>
                      {p.displayName && <Mono className="ml-2 text-xs text-muted-foreground">{p.name}</Mono>}
                      {p.description && <p className="line-clamp-1 max-w-prose text-muted-foreground">{p.description}</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-2">
                  <ServicePills project={p} />
                </TableCell>
                <TableCell className="text-right">
                  <DatabaseSize name={p.name} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{last ? <TimeAgo iso={last} /> : audit.state.status === "ready" ? <Empty /> : null}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <TimeAgo iso={p.createdAt} />
                </TableCell>
              </TableRow>
            );
          })}
          {sorted.length === 0 && (
            <TableEmpty colSpan={5}>
              No projects match "{query.trim()}".{" "}
              <a href="#/projects" className="text-foreground underline underline-offset-4">
                Clear filter
              </a>
            </TableEmpty>
          )}
        </TableBody>
      </Table>
    </>
  );
}

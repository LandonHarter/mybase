import { Plus, RotateCw, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API_URL } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { useProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

export function ProjectsPage({ query, onCreate }: { query: string; onCreate: () => void }) {
  const { state, refresh } = useProjects();

  const createButton = (
    <Button onClick={onCreate}>
      <Plus />
      Create project
    </Button>
  );

  if (state.status === "offline") {
    return (
      <>
        <PageHeader title="Projects" />
        <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">Can't reach the API at {API_URL}</p>
          <p className="mt-1 text-muted-foreground">
            Start it with <code className="font-mono text-[0.85em] text-foreground">bun run dev:api</code>, then retry.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
            <RotateCw />
            Retry
          </Button>
        </div>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <PageHeader title="Projects" action={createButton} />
        <div className="grid gap-3" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-full max-w-md" />
          ))}
        </div>
      </>
    );
  }

  const { projects } = state;

  if (projects.length === 0) {
    return (
      <>
        <PageHeader title="Projects" />
        <div className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 mb-4 text-muted-foreground">
            A project is one app's backend: its own Postgres database and storage bucket, with credentials to use them.
          </p>
          {createButton}
        </div>
      </>
    );
  }

  const needle = query.trim().toLowerCase();
  const visible = needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects;
  const sorted = [...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <PageHeader
        title="Projects"
        description={`${projects.length} ${projects.length === 1 ? "project" : "projects"} on this server`}
        action={createButton}
      />
      <div className="relative mb-4 max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Filter projects"
          placeholder="Filter by name"
          className="pl-8"
          value={query}
          // Filter lives in the URL so it survives reloads and can be linked.
          onChange={(e) => navigate({ page: "projects", query: e.target.value }, { replace: true })}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-full text-muted-foreground">Name</TableHead>
            <TableHead className="text-right text-muted-foreground">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => (
            <TableRow key={p.name}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell className="text-right text-muted-foreground">
                <time dateTime={p.createdAt} title={formatDate(p.createdAt)}>
                  {timeAgo(p.createdAt)}
                </time>
              </TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="py-6 text-muted-foreground">
                No project names contain "{query.trim()}".{" "}
                <a href="#/projects" className="text-foreground underline underline-offset-4">
                  Clear filter
                </a>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}

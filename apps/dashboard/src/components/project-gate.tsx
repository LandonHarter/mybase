import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import type { Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjects } from "@/lib/projects";
import { href } from "@/lib/router";

/**
 * Loads the project list and renders `children` with this project, or the offline,
 * loading, and not-found states. Every page inside a project goes through it.
 */
export function ProjectGate({
  name,
  title,
  backToProject = false,
  children,
}: {
  name: string;
  /** Header title while the project loads or can't be found. */
  title: string;
  /** Show the project as a breadcrumb (for service pages). */
  backToProject?: boolean;
  children: (project: Project) => ReactNode;
}) {
  const { state, refresh } = useProjects();
  const breadcrumb = backToProject ? { label: name, href: href({ page: "project", name }) } : undefined;

  if (state.status === "offline") {
    return (
      <>
        <PageHeader title={title} breadcrumb={breadcrumb} />
        <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">Can't reach the API</p>
          <p className="mt-1 text-muted-foreground">
            Check that it's running (in development, <code className="font-mono text-[0.85em] text-foreground">bun run dev</code>), then retry.
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
        <PageHeader title={title} breadcrumb={breadcrumb} />
        <div className="grid gap-3" aria-busy="true" aria-label="Loading project">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-full max-w-md" />
          ))}
        </div>
      </>
    );
  }

  const project = state.projects.find((p) => p.name === name);
  if (!project) {
    return (
      <>
        <PageHeader title={title} />
        <div className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">No project named {name}</p>
          <p className="mt-1 text-muted-foreground">It may have been deleted.</p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <a href="#/projects">All projects</a>
          </Button>
        </div>
      </>
    );
  }

  return children(project);
}

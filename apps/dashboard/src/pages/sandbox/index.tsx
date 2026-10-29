import { BookOpen, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { SandboxDetail, SandboxList } from "./runs";
import { Setup } from "./setup";
import { docLink, focus, routeFor, type SandboxRoute } from "./shared";

export function SandboxPage({ route }: { route: SandboxRoute }) {
  return (
    <ProjectGate name={route.name} title="Agent sandboxes" backToProject>
      {(project) => {
        if (!project.services.includes("sandbox"))
          return (
            <ServiceOff project={project} id="sandbox">
              Run agent-controlled JavaScript and Chromium in temporary isolated workspaces. First run{" "}
              <code className="font-mono text-xs">mybase server sandbox --project {route.name}</code> on the Docker host to set up the worker.{" "}
              <a href={docLink("sandboxes")} className="underline underline-offset-4">
                Read the setup guide.
              </a>
            </ServiceOff>
          );
        if (route.sandbox && route.tab === "runs") return <SandboxDetail key={route.sandbox} route={route} />;
        return (
          <>
            <PageHeader
              title="Agent sandboxes"
              breadcrumb={{ label: route.name, href: href({ page: "project", name: route.name }) }}
              description="Isolated JavaScript and Chromium workspaces for your agents."
              action={
                route.tab === "runs" ? (
                  <Button onClick={() => navigate({ ...route, action: "create" }, { replace: true })}>
                    <Plus />
                    Create sandbox
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <a href={docLink("sandboxes")}>
                      <BookOpen />
                      Read guide
                    </a>
                  </Button>
                )
              }
            />
            <nav aria-label="Agent sandboxes" className="mb-6 flex gap-5 border-b">
              {(["runs", "setup"] as const).map((tab) => (
                <a
                  key={tab}
                  href={href({ ...routeFor(route.name), tab })}
                  aria-current={route.tab === tab ? "page" : undefined}
                  className={cn(
                    "-mb-px border-b-2 border-transparent px-1 pb-3",
                    focus,
                    route.tab === tab ? "border-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab === "runs" ? "Runs" : "Setup"}
                </a>
              ))}
            </nav>
            {route.tab === "setup" ? <Setup route={route} /> : <SandboxList route={route} />}
          </>
        );
      }}
    </ProjectGate>
  );
}

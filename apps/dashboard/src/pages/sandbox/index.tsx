import { BookOpen, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RoutedTabs } from "@/components/tabs";
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
    <ProjectGate name={route.name} title="Sandboxes" backToProject>
      {(project) => {
        if (!project.services.includes("sandbox"))
          return (
            <ServiceOff project={project} id="sandbox">
              Run untrusted code and a headless browser in temporary, isolated workspaces: user scripts, scraping, screenshots, PDFs, file processing, or tools for AI agents. First run{" "}
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
              title="Sandboxes"
              breadcrumb={{ label: route.name, href: href({ page: "project", name: route.name }) }}
              description="Isolated Node.js and Chromium workspaces for untrusted code, browser automation, and agents."
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
            <RoutedTabs label="Sandboxes" current={route.tab} tabs={(["runs", "setup"] as const).map((tab) => ({ id: tab, label: tab === "runs" ? "Runs" : "Setup", href: href({ ...routeFor(route.name), tab }) }))} />
            {route.tab === "setup" ? <Setup route={route} /> : <SandboxList route={route} />}
          </>
        );
      }}
    </ProjectGate>
  );
}

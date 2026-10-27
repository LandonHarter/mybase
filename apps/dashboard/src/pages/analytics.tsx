import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ANALYTICS_RANGES, type AnalyticsRange, type Project } from "@mybase/shared";
import { RANGE_LABELS } from "@/components/analytics-parts";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { ANALYTICS_TABS, href, navigate, type AnalyticsTab } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AnalyticsErrors } from "@/pages/analytics/errors";
import { AnalyticsEvents } from "@/pages/analytics/events";
import { AnalyticsOverviewTab } from "@/pages/analytics/overview";
import { AnalyticsSetup } from "@/pages/analytics/setup";

const TAB_LABELS: Record<AnalyticsTab, string> = {
  overview: "Overview",
  events: "Events",
  errors: "Errors",
  setup: "Setup",
};

/** A segmented control for the time range. Replaces history so Back leaves the page, not the range. */
function RangePicker({ project, tab, range }: { project: string; tab: AnalyticsTab; range: AnalyticsRange }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-md border p-0.5">
      {ANALYTICS_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={r === range}
          onClick={() => navigate({ page: "analytics", name: project, tab, range: r }, { replace: true })}
          className={cn(
            "h-8 rounded-[5px] px-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            r === range && "bg-accent font-medium text-foreground",
          )}
        >
          <span className="sm:hidden">{r}</span>
          <span className="hidden sm:inline">{RANGE_LABELS[r]}</span>
        </button>
      ))}
    </div>
  );
}

function AnalyticsLayout({ project, tab, range, children }: { project: Project; tab: AnalyticsTab; range: AnalyticsRange; children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Analytics"
        breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }}
        description="Page views, routes, errors, and custom events from your apps."
        action={tab === "events" || tab === "setup" ? undefined : <RangePicker project={project.name} tab={tab} range={range} />}
      />
      <nav aria-label="Analytics" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
        {ANALYTICS_TABS.map((t) => (
          <a
            key={t}
            href={href({ page: "analytics", name: project.name, tab: t, range })}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground outline-none",
              "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
              t === tab && "border-foreground font-medium text-foreground",
            )}
          >
            {TAB_LABELS[t]}
          </a>
        ))}
      </nav>
      {children}
    </>
  );
}

function AnalyticsOff({ project }: { project: Project }) {
  const [pending, setPending] = useState(false);
  async function enable() {
    setPending(true);
    try {
      await api.enableService(project.name, "analytics");
      await refreshProjects();
      toast.success("Turned on analytics");
      navigate({ page: "analytics", name: project.name, tab: "setup", range: "7d" }, { replace: true });
    } catch (err) {
      toast.error(`Couldn't turn on analytics: ${errorMessage(err)}`);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader title="Analytics" breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Analytics is off for this project</p>
        <p className="mt-1 text-muted-foreground">
          Turn it on to count page views and visitors, see which routes and countries they come from, and collect errors and custom events from your apps. No
          cookies, and IP addresses are never stored.
        </p>
        <Button variant="outline" size="sm" className="mt-4" disabled={pending} onClick={enable}>
          <Plus />
          {pending ? "Turning on…" : "Turn on analytics"}
        </Button>
      </div>
    </>
  );
}

export function AnalyticsPage({ name, tab, range }: { name: string; tab: AnalyticsTab; range: AnalyticsRange }) {
  return (
    <ProjectGate name={name} title="Analytics" backToProject>
      {(project) => {
        if (!project.services.includes("analytics")) return <AnalyticsOff project={project} />;
        return (
          <AnalyticsLayout project={project} tab={tab} range={range}>
            {tab === "overview" && <AnalyticsOverviewTab project={project.name} range={range} />}
            {tab === "events" && <AnalyticsEvents project={project.name} />}
            {tab === "errors" && <AnalyticsErrors project={project.name} range={range} />}
            {tab === "setup" && <AnalyticsSetup project={project} />}
          </AnalyticsLayout>
        );
      }}
    </ProjectGate>
  );
}

import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ANALYTICS_RANGES, type AnalyticsRange, type Project } from "@mybase/shared";
import { RANGE_LABELS } from "@/components/analytics-parts";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { PageHeader } from "@/components/page-header";
import { RoutedTabs, SegmentedControl } from "@/components/tabs";
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
    <SegmentedControl
      label="Time range"
      value={range}
      options={ANALYTICS_RANGES.map((r) => ({ value: r, label: <><span className="sm:hidden">{r}</span><span className="hidden sm:inline">{RANGE_LABELS[r]}</span></>, title: RANGE_LABELS[r] }))}
      onChange={(r) => navigate({ page: "analytics", name: project, tab, range: r }, { replace: true })}
    />
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
      <RoutedTabs label="Analytics" current={tab} tabs={ANALYTICS_TABS.map((t) => ({ id: t, label: TAB_LABELS[t], href: href({ page: "analytics", name: project.name, tab: t, range }) }))} />
      {children}
    </>
  );
}

function AnalyticsOff({ project }: { project: Project }) {
  const [pending, setPending] = useState(false);
  const linkedEnvs = useLinkedEnvs(project);
  const [link, setLink] = useState(true);
  async function enable() {
    setPending(true);
    try {
      await api.enableService(project.name, "analytics", link && linkedEnvs.length > 0);
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
        <LinkKeysOption id="analytics" envs={linkedEnvs} checked={link} onCheckedChange={setLink} className="mt-4" />
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

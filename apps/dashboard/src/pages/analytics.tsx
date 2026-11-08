import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ANALYTICS_RANGES, type AnalyticsRange, type Project } from "@mybase/shared";
import { RANGE_LABELS } from "@/components/analytics-parts";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { ServiceOff } from "@/components/service-off";
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

export function AnalyticsPage({ name, tab, range }: { name: string; tab: AnalyticsTab; range: AnalyticsRange }) {
  return (
    <ProjectGate name={name} title="Analytics" backToProject>
      {(project) => {
        if (!project.services.includes("analytics")) return <ServiceOff project={project} id="analytics">No cookies, and IP addresses are never stored.</ServiceOff>;
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

import type { ReactNode } from "react";
import type { Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { RoutedTabs } from "@/components/tabs";
import { DB_TABS, href, type DbTab } from "@/lib/router";
import { cn } from "@/lib/utils";

export const TAB_LABELS: Record<DbTab, string> = {
  tables: "Tables",
  sql: "SQL editor",
  extensions: "Extensions",
  settings: "Settings",
};

/** Header + tab bar shared by every database tab. Each tab passes its own primary action. */
export function DatabaseLayout({ project, tab, action, children }: { project: Project; tab: DbTab; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Database"
        breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }}
        description={
          <>
            Postgres database <span className="font-mono text-[0.9em]">{project.database.name}</span>
          </>
        }
        action={action}
      />
      <RoutedTabs label="Database" current={tab} tabs={DB_TABS.map((t) => ({ id: t, label: TAB_LABELS[t], href: href({ page: "database", name: project.name, tab: t, table: null }) }))} />
      {children}
    </>
  );
}

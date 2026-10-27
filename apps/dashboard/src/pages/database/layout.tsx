import type { ReactNode } from "react";
import type { Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
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
      <nav aria-label="Database" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
        {DB_TABS.map((t) => (
          <a
            key={t}
            href={href({ page: "database", name: project.name, tab: t, table: null })}
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

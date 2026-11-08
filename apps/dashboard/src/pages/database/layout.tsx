import type { ReactNode } from "react";
import type { Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { Mono } from "@/components/status";
import { api } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { DatabaseConnect } from "@/pages/database/connect";
import { RoutedTabs } from "@/components/tabs";
import { DB_TABS, href, type DbTab } from "@/lib/router";

export const TAB_LABELS: Record<DbTab, string> = {
  tables: "Tables",
  sql: "SQL editor",
  extensions: "Extensions",
  settings: "Settings",
};

/** "Postgres · 48 MB · 12 tables · 3/100 connections · reachable on LAN, internet" (A01), from cached reads. */
function DatabaseFacts({ project }: { project: Project }) {
  const db = useLoad(`db:${project.name}`, () => api.database(project.name), { maxAge: 30_000 });
  const access = useLoad(`db-access:${project.name}`, () => api.databaseAccess(project.name), { maxAge: 60_000 });
  const d = db.data;
  const routes = access.data?.routes.filter((r) => r.on && r.route !== "proxy" && r.route !== "localhost").map((r) => ROUTE_NAMES[r.route] ?? r.route) ?? [];
  return (
    <span aria-live="polite">
      Postgres <Mono>{project.database.name}</Mono>
      {d && (
        <>
          {" · "}
          {formatBytes(d.sizeBytes)} · {plural(d.tables, "table", "tables")} · {d.activeConnections}
          {d.connectionLimit !== null ? `/${d.connectionLimit}` : ""} connections
        </>
      )}
      {routes.length > 0 && <> · reachable on {routes.join(", ")}</>}
    </span>
  );
}

const ROUTE_NAMES: Record<string, string> = { internal: "hosting network", lan: "LAN", tailscale: "Tailscale", public: "internet" };

/** Header + tab bar shared by every database tab. Each tab passes its own primary action. */
export function DatabaseLayout({ project, tab, action, children }: { project: Project; tab: DbTab; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Database"
        breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }}
        description={<DatabaseFacts project={project} />}
        action={
          <>
            <DatabaseConnect project={project} />
            {action}
          </>
        }
      />
      <RoutedTabs label="Database" current={tab} tabs={DB_TABS.map((t) => ({ id: t, label: TAB_LABELS[t], href: href({ page: "database", name: project.name, tab: t, table: null }) }))} />
      {children}
    </>
  );
}

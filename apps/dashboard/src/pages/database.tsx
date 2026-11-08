import type { Route } from "@/lib/router";
import { ProjectGate } from "@/components/project-gate";
import { ExtensionsTab } from "@/pages/database/extensions";
import { DatabaseSettingsTab } from "@/pages/database/settings";
import { SqlTab } from "@/pages/database/sql";
import { TablesTab } from "@/pages/database/tables";

export function DatabasePage({ route }: { route: Extract<Route, { page: "database" }> }) {
  const { name, tab } = route;
  return (
    <ProjectGate name={name} title="Database" backToProject>
      {(project) => {
        if (tab === "sql") return <SqlTab project={project} />;
        if (tab === "extensions") return <ExtensionsTab project={project} show={route.show ?? "all"} />;
        if (tab === "settings") return <DatabaseSettingsTab project={project} />;
        return <TablesTab key={name} project={project} route={route} />;
      }}
    </ProjectGate>
  );
}

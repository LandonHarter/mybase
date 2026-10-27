import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CommandMenu } from "@/components/command-menu";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CronPage } from "@/pages/cron";
import { DatabasePage } from "@/pages/database";
import { ProjectPage } from "@/pages/project";
import { ProjectsPage } from "@/pages/projects";
import { SettingsPage } from "@/pages/settings";
import { StoragePage } from "@/pages/storage";
import { isProjectRoute, useRoute, type Route } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

function Page({ route, onCreate, onDelete }: { route: Route; onCreate: () => void; onDelete: () => void }) {
  switch (route.page) {
    case "settings":
      return <SettingsPage />;
    case "project":
      return <ProjectPage key={route.name} name={route.name} onDelete={onDelete} />;
    case "database":
      return <DatabasePage key={route.name} name={route.name} tab={route.tab} table={route.table} />;
    case "storage":
      return <StoragePage key={route.name} name={route.name} prefix={route.prefix} />;
    case "cron":
      return <CronPage key={route.name} name={route.name} job={route.job} create={route.create} />;
    case "projects":
      return <ProjectsPage query={route.query} onCreate={onCreate} />;
  }
}

export function App() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <ThemeProvider>
      <TooltipProvider>
        <AppShell onSearch={() => setSearchOpen(true)} onCreate={() => setCreateOpen(true)}>
          <Page route={route} onCreate={() => setCreateOpen(true)} onDelete={() => setDeleteOpen(true)} />
        </AppShell>
        <CommandMenu
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onCreateProject={() => setCreateOpen(true)}
          project={isProjectRoute(route) ? route.name : undefined}
          onDeleteProject={isProjectRoute(route) ? () => setDeleteOpen(true) : undefined}
        />
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
        {isProjectRoute(route) && <DeleteProjectDialog name={route.name} open={deleteOpen} onOpenChange={setDeleteOpen} />}
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

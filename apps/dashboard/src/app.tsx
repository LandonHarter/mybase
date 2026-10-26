import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CommandMenu } from "@/components/command-menu";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectPage } from "@/pages/project";
import { ProjectsPage } from "@/pages/projects";
import { SettingsPage } from "@/pages/settings";
import { useRoute } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

export function App() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <ThemeProvider>
      <TooltipProvider>
        <AppShell onSearch={() => setSearchOpen(true)}>
          {route.page === "settings" ? (
            <SettingsPage />
          ) : route.page === "project" ? (
            <ProjectPage key={route.name} name={route.name} prefix={route.prefix} onDelete={() => setDeleteOpen(true)} />
          ) : (
            <ProjectsPage query={route.query} onCreate={() => setCreateOpen(true)} />
          )}
        </AppShell>
        <CommandMenu
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onCreateProject={() => setCreateOpen(true)}
          onDeleteProject={route.page === "project" ? () => setDeleteOpen(true) : undefined}
        />
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
        {route.page === "project" && <DeleteProjectDialog name={route.name} open={deleteOpen} onOpenChange={setDeleteOpen} />}
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

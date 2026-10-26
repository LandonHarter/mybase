import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CommandMenu } from "@/components/command-menu";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectsPage } from "@/pages/projects";
import { SettingsPage } from "@/pages/settings";
import { useRoute } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

export function App() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <ThemeProvider>
      <TooltipProvider>
        <AppShell onSearch={() => setSearchOpen(true)}>
          {route.page === "settings" ? (
            <SettingsPage />
          ) : (
            <ProjectsPage query={route.query} onCreate={() => setCreateOpen(true)} />
          )}
        </AppShell>
        <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} onCreateProject={() => setCreateOpen(true)} />
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

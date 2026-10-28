import { useState } from "react";
import { RotateCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AuthLayout } from "@/components/auth-layout";
import { CommandMenu } from "@/components/command-menu";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AnalyticsPage } from "@/pages/analytics";
import { CachePage } from "@/pages/cache";
import { CronPage } from "@/pages/cron";
import { DatabasePage } from "@/pages/database";
import { DocsHomePage, DocsPage } from "@/pages/docs";
import { ProjectPage } from "@/pages/project";
import { ProjectsPage } from "@/pages/projects";
import { QueuePage } from "@/pages/queue";
import { VectorPage } from "@/pages/vector";
import { RateLimitPage } from "@/pages/ratelimit";
import { SearchPage } from "@/pages/search";
import { SecretsPage } from "@/pages/secrets";
import { SecurityPage } from "@/pages/security";
import { SettingsPage } from "@/pages/settings";
import { SetupPage } from "@/pages/setup";
import { SignInPage } from "@/pages/sign-in";
import { StoragePage } from "@/pages/storage";
import { UsersPage } from "@/pages/users";
import { CaptchaPage } from "@/pages/captcha";
import { RealtimePage } from "@/pages/realtime";
import { refreshAuth, useAuth } from "@/lib/auth";
import { isProjectRoute, useRoute, type Route } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

function Page({ route, onCreate, onDelete, onSearch }: { route: Route; onCreate: () => void; onDelete: () => void; onSearch: () => void }) {
  switch (route.page) {
    case "docs-home":
      return <DocsHomePage onSearch={onSearch} />;
    case "docs":
      return <DocsPage key={`${route.service}/${route.slug}`} service={route.service} slug={route.slug} section={route.section} />;
    case "settings":
      return <SettingsPage newToken={route.newToken} />;
    case "security":
      return <SecurityPage tab={route.tab} project={route.project} action={route.action ?? null} outcome={route.outcome ?? null} />;
    case "project":
      return <ProjectPage key={route.name} name={route.name} onDelete={onDelete} />;
    case "database":
      return <DatabasePage key={route.name} name={route.name} tab={route.tab} table={route.table} />;
    case "storage":
      return <StoragePage key={route.name} name={route.name} prefix={route.prefix} />;
    case "cron":
      return <CronPage key={route.name} name={route.name} job={route.job} create={route.create} />;
    case "analytics":
      return <AnalyticsPage key={route.name} name={route.name} tab={route.tab} range={route.range} />;
    case "cache":
      return <CachePage key={route.name} name={route.name} cacheKey={route.key} query={route.query} />;
    case "ratelimit":
      return <RateLimitPage key={route.name} name={route.name} />;
    case "queue":
      return <QueuePage key={route.name} name={route.name} queue={route.queue} />;
    case "search":
      return <SearchPage key={route.name} name={route.name} />;
    case "vector":
      return <VectorPage key={route.name} name={route.name} index={route.index} />;
    case "secrets":
      return <SecretsPage key={route.name} name={route.name} env={route.env} />;
    case "users":
      return <UsersPage key={route.name} name={route.name} user={route.user} query={route.query} />;
    case "captcha":
      return <CaptchaPage key={route.name} name={route.name} />;
    case "realtime":
      return <RealtimePage key={route.name} name={route.name} />;
    case "projects":
      return <ProjectsPage query={route.query} onCreate={onCreate} />;
  }
}

function Dashboard() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <AppShell onSearch={() => setSearchOpen(true)} onCreate={() => setCreateOpen(true)}>
        <Page route={route} onCreate={() => setCreateOpen(true)} onDelete={() => setDeleteOpen(true)} onSearch={() => setSearchOpen(true)} />
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
    </>
  );
}

/** Nothing but the sign-in (or first-run) screen until the API knows who this is. */
function Gate() {
  const auth = useAuth();
  // Usually a few milliseconds; blank beats flashing the sign-in form at a signed-in user.
  if (auth.status === "loading") return null;
  if (auth.status === "offline") {
    return (
      <AuthLayout title="Can't reach the API" description="Check that it's running, then retry.">
        <Button variant="outline" onClick={refreshAuth}>
          <RotateCw />
          Retry
        </Button>
      </AuthLayout>
    );
  }
  if (auth.setupNeeded) return <SetupPage />;
  if (!auth.authenticated) return <SignInPage />;
  return <Dashboard />;
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <Gate />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

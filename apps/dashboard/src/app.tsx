import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthLayout } from "@/components/auth-layout";
import { CommandMenu } from "@/components/command-menu";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { Button } from "@/components/ui/button";
import { ErrorPanel, OfflinePanel } from "@/components/states";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SERVICES } from "@mybase/shared";
import { installShortcuts, SHORTCUTS } from "@/lib/keys";
import { useProjects } from "@/lib/projects";
import { recordPage } from "@/lib/recent";
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
import { HostingPage } from "@/pages/hosting";
import { RegistryPage } from "@/pages/registry";
import { RealtimePage } from "@/pages/realtime";
import { SandboxPage } from "@/pages/sandbox";
import { refreshAuth, useAuth } from "@/lib/auth";
import { currentPath, href, isProjectRoute, useRoute, type Route } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

function Page({ route, onCreate, onDelete, onSearch }: { route: Route; onCreate: () => void; onDelete: () => void; onSearch: () => void }) {
  switch (route.page) {
    case "docs-home":
      return <DocsHomePage onSearch={onSearch} />;
    case "docs":
      return <DocsPage key={`${route.service}/${route.slug}`} service={route.service} slug={route.slug} section={route.section} />;
    case "settings":
      return <SettingsPage newToken={route.newToken} section={route.section ?? null} />;
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
    case "hosting":
      return <HostingPage key={route.name} name={route.name} site={route.site} tab={route.tab ?? "overview"} deploy={route.deploy ?? null} />;
    case "registry":
      return <RegistryPage key={route.name} name={route.name} repo={route.repo} />;
    case "captcha":
      return <CaptchaPage key={route.name} name={route.name} />;
    case "realtime":
      return <RealtimePage key={route.name} name={route.name} />;
    case "sandbox":
      return <SandboxPage key={route.name} route={route} />;
    case "projects":
      return <ProjectsPage query={route.query} onCreate={onCreate} />;
    case "not-found":
      return <NotFound path={route.path} />;
  }
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="max-w-prose">
      <h1 tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
        Page not found
      </h1>
      <p className="mt-2 text-muted-foreground">
        Nothing lives at <span className="mono-value text-foreground [overflow-wrap:anywhere]">#/{path}</span>. The link may be old, or the item was renamed or deleted.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href="#/projects">All projects</a>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href="#/docs">Documentation</a>
        </Button>
      </div>
    </div>
  );
}

/** Pages that need the full width (DESIGN.md "Layout": workspace). Everything else is max-w-5xl. */
function isWorkspace(route: Route): boolean {
  if (route.page === "database") return route.tab === "tables" || route.tab === "sql";
  if (route.page === "hosting") return route.site !== null && route.tab === "logs";
  if (route.page === "security") return route.tab === "audit";
  if (route.page === "storage") return true;
  if (route.page === "sandbox") return route.tab === "runs" && route.sandbox !== null;
  return false;
}

/** "orders · shop · mybase": the item, the service or page, the project. */
function useTitle(route: Route) {
  const { state } = useProjects();
  useEffect(() => {
    const parts: string[] = [];
    if (isProjectRoute(route)) {
      const r = route as Record<string, unknown>;
      const item = ["job", "key", "queue", "index", "site", "repo", "user", "table", "env"].map((k) => r[k]).find((v) => typeof v === "string" && v);
      if (item) parts.push(String(item));
      const service = SERVICES.find((x) => x.id === route.page);
      if (service) parts.push(service.name);
      const project = state.status === "ready" ? state.projects.find((p) => p.name === route.name) : undefined;
      parts.push(project?.displayName || route.name);
    } else if (route.page === "projects") parts.push("Projects");
    else if (route.page === "settings") parts.push("Settings");
    else if (route.page === "security") parts.push("Security");
    else if (route.page === "docs" || route.page === "docs-home") parts.push("Documentation");
    else parts.push("Not found");
    document.title = [...parts, "mybase"].join(" · ");
    if (route.page !== "not-found") recordPage(window.location.hash, parts.join(" · "));
  }, [route, state]);
}

/**
 * On a new destination: scroll to the top and move focus to the page title, so keyboard and
 * screen-reader users land on the new content. Back/Forward restore the scroll position instead.
 * Filter changes (same path, new query) don't move anything.
 */
function useRouteFocus() {
  const path = useRef(currentPath());
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    history.scrollRestoration = "manual";
    const idOf = () => (history.state as { mybase?: string } | null)?.mybase;
    if (!idOf()) history.replaceState({ ...(history.state ?? {}), mybase: crypto.randomUUID?.() ?? String(Math.random()) }, "");
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const id = idOf();
        if (id) positions.current.set(id, window.scrollY);
      }, 100);
    };
    const onChange = () => {
      const next = currentPath();
      if (next === path.current) return;
      path.current = next;
      const id = idOf();
      const saved = id ? positions.current.get(id) : undefined;
      if (!id) history.replaceState({ ...(history.state ?? {}), mybase: crypto.randomUUID?.() ?? String(Math.random()) }, "");
      requestAnimationFrame(() => {
        window.scrollTo(0, saved ?? 0);
        const heading = document.querySelector<HTMLElement>("main h1");
        if (heading) {
          if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
          heading.classList.add("outline-none");
          heading.focus({ preventScroll: true });
        } else document.getElementById("main-content")?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
}

/** Catches a page that throws while rendering: the shell (and any drafts outside the page) survive. */
class RouteBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; id: string }> {
  state = { error: null as Error | null, id: "" };
  static getDerivedStateFromError(error: Error) {
    return { error, id: Math.random().toString(36).slice(2, 10) };
  }
  componentDidCatch(error: Error) {
    // The browser console is the only log a static page has; the id ties the panel to this line.
    console.error(`[dashboard] page crashed (${this.state.id || "?"})`, error);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, id: "" });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorPanel
        title="This page hit an error"
        message={
          <>
            {this.state.error.message || "Something went wrong while showing it."} <span className="font-mono text-xs">(id {this.state.id})</span>
          </>
        }
        onRetry={() => this.setState({ error: null, id: "" })}
        action={
          <Button asChild variant="ghost" size="sm">
            <a href="#/projects">Back to projects</a>
          </Button>
        }
      />
    );
  }
}

function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>Single keys work when you aren't typing. None of them deletes anything.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="contents">
                <dt>{s.label}</dt>
                <dd className="flex justify-end gap-1">
                  {s.keys.map((k) => (
                    <kbd key={k} className="min-w-6 rounded border bg-surface px-1.5 text-center font-sans text-xs leading-5">
                      {k}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function Dashboard() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const routeRef = useRef(route);
  routeRef.current = route;
  useTitle(route);
  useRouteFocus();
  useEffect(
    () =>
      installShortcuts(() => routeRef.current, {
        onShortcuts: () => setShortcutsOpen(true),
        onSwitchProject: () => Array.from(document.querySelectorAll<HTMLElement>("[data-project-switcher]")).find((el) => el.offsetParent !== null)?.click(),
      }),
    [],
  );

  return (
    <>
      <AppShell onSearch={() => setSearchOpen(true)} onCreate={() => setCreateOpen(true)} onShortcuts={() => setShortcutsOpen(true)}>
        <div className={isWorkspace(route) ? "min-w-0" : "max-w-5xl"}>
          <RouteBoundary resetKey={href(route).split("?")[0]!}>
            <Page route={route} onCreate={() => setCreateOpen(true)} onDelete={() => setDeleteOpen(true)} onSearch={() => setSearchOpen(true)} />
          </RouteBoundary>
        </div>
      </AppShell>
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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

function ShellSkeleton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]" aria-busy="true" aria-label="Loading mybase">
      <div className="hidden h-dvh flex-col gap-3 border-r bg-sidebar px-5 py-5 md:flex">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-9 w-full" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-4 w-28" />
        ))}
      </div>
      <div className="grid content-start gap-4 px-4 py-6 md:px-8 md:py-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
    </div>
  );
}

/** Nothing but the sign-in (or first-run) screen until the API knows who this is. */
function Gate() {
  const auth = useAuth();
  // Usually a few milliseconds: nothing at first, then the shell's outline after 300 ms.
  if (auth.status === "loading") return <ShellSkeleton />;
  if (auth.status === "offline") {
    return (
      <AuthLayout title="Can't reach the mybase API" description="The dashboard is up, but the API behind it isn't answering.">
        <OfflinePanel onRetry={refreshAuth} />
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

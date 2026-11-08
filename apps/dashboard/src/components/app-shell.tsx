import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Boxes, ChevronDown, CircleHelp, Keyboard, LayoutGrid, Menu, Search, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { SERVICES, type AdvisorReport, type ServiceId } from "@mybase/shared";
import { ModeMenu } from "@/components/mode-menu";
import { ProjectMark, ProjectSwitcher } from "@/components/project-switcher";
import { SERVICE_GROUPS, SERVICE_PAGES, type ServiceGroup } from "@/components/service-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { SEARCH_SHORTCUT } from "@/lib/keys";
import { DOC_SERVICES, docRoute } from "@/lib/docs";
import { useCached, useLoad } from "@/lib/load";
import { useProjects } from "@/lib/projects";
import { useRecentProjects } from "@/lib/recent";
import { href, isProjectRoute, useRoute, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

const RECENT_SHOWN = 5;

type Link = {
  label: string;
  to: Route;
  icon?: LucideIcon;
  mark?: string;
  active: boolean;
  /** The current page sits below this link without being listed (a guide under Documentation). */
  inside?: boolean;
  badge?: ReactNode;
};

function NavLink({ link, nested = false, className, onNavigate }: { link: Link; nested?: boolean; className?: string; onNavigate?: () => void }) {
  const { label, to, icon: Icon, mark, active, badge } = link;
  return (
    <a
      href={href(to)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className={cn(
        "relative flex shrink-0 items-center gap-2.5 rounded-md px-2.5 whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150",
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        nested ? "h-7" : "h-8 pointer-coarse:h-11",
        link.inside && !active && "font-medium text-foreground",
        active && "bg-sidebar-accent font-medium text-foreground",
        // The accent marker: the current page in navigation.
        active && "before:absolute before:inset-y-1.5 before:w-0.5 before:rounded-full before:bg-primary",
        active && (nested ? "before:-left-[9.5px]" : "before:-left-3 max-md:before:-left-1"),
        className,
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
      {mark && <ProjectMark name={mark} />}
      <span className="min-w-0 truncate" title={nested ? label : undefined}>
        {label}
      </span>
      {badge && <span className="ml-auto">{badge}</span>}
    </a>
  );
}

const COLLAPSED_KEY = "mybase.rail.collapsed";
function readCollapsed(): ServiceGroup[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** A project's rail: Overview, then its services grouped Data / Compute / App (D7: services only). */
function ProjectLinks({ route, onNavigate }: { route: Route & { name: string }; onNavigate?: () => void }) {
  const { state } = useProjects();
  const { name } = route;
  const project = state.status === "ready" ? state.projects.find((p) => p.name === name) : undefined;
  const services = SERVICES.filter((s) => s.core || project?.services.includes(s.id));
  const [collapsed, setCollapsed] = useState<ServiceGroup[]>(readCollapsed);
  const toggle = (g: ServiceGroup) =>
    setCollapsed((c) => {
      const next = c.includes(g) ? c.filter((x) => x !== g) : [...c, g];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: remembered for this visit only.
      }
      return next;
    });

  return (
    <>
      <NavLink onNavigate={onNavigate} link={{ label: "Overview", icon: LayoutGrid, to: { page: "project", name }, active: route.page === "project" }} />
      {SERVICE_GROUPS.map((group) => {
        const items = services.filter((s) => SERVICE_PAGES[s.id].group === group.id);
        if (items.length === 0) return null;
        // A collapsed group still shows the service you're on.
        const isCollapsed = collapsed.includes(group.id);
        const shown = isCollapsed ? items.filter((s) => route.page === s.id) : items;
        return (
          <div key={group.id} className="mt-3">
            <button
              type="button"
              onClick={() => toggle(group.id)}
              aria-expanded={!isCollapsed}
              className="flex h-6 w-full items-center gap-1 rounded-sm px-2.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {group.label}
              <ChevronDown className={cn("size-3 opacity-60", isCollapsed && "-rotate-90")} aria-hidden />
            </button>
            <div className="flex flex-col gap-0.5">
              {shown.map((s) => {
                const { icon, route: to } = SERVICE_PAGES[s.id as ServiceId];
                return <NavLink key={s.id} onNavigate={onNavigate} link={{ label: s.name, icon, to: to(name), active: route.page === s.id }} />;
              })}
            </div>
          </div>
        );
      })}
      <div className="mt-3">
        <NavLink onNavigate={onNavigate} link={{ label: "Project settings", icon: Settings, to: { page: "project-settings", name }, active: route.page === "project-settings" }} />
      </div>
    </>
  );
}

function RecentProjects({ recent, onNavigate }: { recent: string[]; onNavigate?: () => void }) {
  const { state } = useProjects();
  if (state.status !== "ready" || state.projects.length === 0) return null;
  const byName = new Map(state.projects.map((p) => [p.name, p]));
  const newest = [...state.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => p.name);
  const shown = [...new Set([...recent.filter((n) => byName.has(n)), ...newest])].slice(0, RECENT_SHOWN);
  return (
    <section aria-labelledby="rail-recent" className="mt-6">
      <h2 id="rail-recent" className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">
        Recent
      </h2>
      <ul className="flex flex-col">
        {shown.map((name) => (
          <li key={name}>
            <NavLink onNavigate={onNavigate} link={{ label: byName.get(name)?.displayName || name, mark: name, to: { page: "project", name }, active: false }} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Inside the docs, the rail lists every guide, grouped like the docs index. */
function DocsLinks({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const current = route.page === "docs" ? route : null;
  return (
    <nav aria-label="Documentation" className="mt-6">
      {DOC_SERVICES.map((service) => (
        <section key={service.id} aria-labelledby={`rail-docs-${service.id}`}>
          <h2 id={`rail-docs-${service.id}`} className="mb-2 px-2.5 font-medium">
            {service.name}
          </h2>
          {service.sections.map((section) => (
            <div key={section.label} className="mb-3">
              <h3 className="mb-0.5 px-2.5 text-xs text-muted-foreground">{section.label}</h3>
              <ul className="ml-2.5 flex flex-col gap-0.5 border-l pl-2">
                {section.docs.map((doc) => (
                  <li key={doc.slug}>
                    <NavLink
                      nested
                      onNavigate={onNavigate}
                      link={{ label: doc.title, to: docRoute({ service, slug: doc.slug }), active: current?.service === service.id && current.slug === doc.slug }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </nav>
  );
}

/**
 * Which server this is, under the product name: host in mono + a health dot from `/health`
 * (loaded once and on focus, never polled). Up / unreachable only: "enabled" isn't "healthy".
 */
function Instance() {
  const health = useLoad("health", () => api.health(), { maxAge: 60_000 });
  const host = typeof location === "undefined" ? "" : location.host;
  const up = health.state.status === "ready" && !health.refreshError;
  const down = health.state.status === "error" || Boolean(health.refreshError);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:hidden"
        aria-label={`Server ${host}: ${up ? "reachable" : down ? "unreachable" : "checking"}`}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", up ? "bg-success" : down ? "bg-destructive" : "bg-muted-foreground/50")} aria-hidden />
        <span className="truncate font-mono">{host}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="font-mono text-[13px]">{host}</span>
          <span className="text-xs text-muted-foreground">
            {health.data ? `mybase ${health.data.version} · ${health.data.arch}` : down ? "Not answering" : "Checking…"}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void health.refresh()}>Check again</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href({ page: "security", tab: "advisor", project: null })}>Security advisor</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={href({ page: "docs", service: "mybase", slug: "self-hosting", section: null })}>Self-hosting guide</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Help: documentation, shortcuts. Sits next to Search (N12). */
function HelpMenu({ onShortcuts }: { onShortcuts: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Help">
          <CircleHelp />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-52">
        <DropdownMenuItem asChild>
          <a href={href({ page: "docs-home" })}>
            <BookOpen />
            Documentation
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShortcuts}>
          <Keyboard />
          Keyboard shortcuts
          <kbd className="ml-auto font-sans text-xs text-muted-foreground">?</kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Count of critical + warning findings from the advisor, if a page already loaded it. */
function SecurityBadge() {
  const report = useCached<AdvisorReport>("advisor:");
  const count = report?.findings.filter((f) => f.severity === "critical" || f.severity === "warn").length ?? 0;
  if (!count) return null;
  const critical = report!.findings.some((f) => f.severity === "critical");
  return (
    <span className={cn("rounded-sm px-1.5 text-xs font-medium tabular-nums", critical ? "bg-destructive/12 text-destructive" : "bg-warning/12 text-warning")} aria-label={`${count} findings`}>
      {count}
    </span>
  );
}

function RailBody({ route, project, onNavigate }: { route: Route; project?: string; onNavigate?: () => void }) {
  const recent = useRecentProjects(project);
  const inDocs = route.page === "docs" || route.page === "docs-home";
  return (
    <>
      <nav aria-label={project ? `Project ${project}` : "Main"} className="flex flex-col gap-0.5">
        {isProjectRoute(route) ? (
          <ProjectLinks route={route} onNavigate={onNavigate} />
        ) : (
          <NavLink onNavigate={onNavigate} link={{ label: "Projects", icon: Boxes, to: { page: "projects", query: "" }, active: route.page === "projects" }} />
        )}
      </nav>
      {inDocs ? <DocsLinks route={route} onNavigate={onNavigate} /> : !project && <RecentProjects recent={recent} onNavigate={onNavigate} />}
    </>
  );
}

function FooterLinks({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const settings: Link = { label: "Settings", icon: Settings, to: { page: "settings", newToken: false }, active: route.page === "settings" };
  const security: Link = { label: "Security", icon: ShieldCheck, to: { page: "security", tab: "advisor", project: null }, active: route.page === "security", badge: <SecurityBadge /> };
  return (
    <>
      <NavLink link={security} onNavigate={onNavigate} />
      <NavLink link={settings} onNavigate={onNavigate} />
    </>
  );
}

/** The current place, for the mobile bar: project + service ("shop · Queues"). */
function useHere(route: Route): string {
  const { state } = useProjects();
  if (!isProjectRoute(route)) {
    if (route.page === "settings") return "Settings";
    if (route.page === "security") return "Security";
    if (route.page === "docs" || route.page === "docs-home") return "Documentation";
    return "Projects";
  }
  const service = SERVICES.find((s) => s.id === route.page);
  const project = state.status === "ready" ? state.projects.find((p) => p.name === route.name) : undefined;
  return service ? service.name : project?.displayName || "Overview";
}

export function AppShell({ children, onSearch, onCreate, onShortcuts }: { children: ReactNode; onSearch: () => void; onCreate: () => void; onShortcuts: () => void }) {
  const route = useRoute();
  const project = isProjectRoute(route) ? route.name : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const here = useHere(route);
  const railRef = useRef<HTMLDivElement>(null);

  // Keep the current link in view when the rail scrolls (many services on).
  useEffect(() => {
    railRef.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [route]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only z-50 rounded-md bg-background px-3 py-2 font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-[3px] focus:ring-ring/50"
      >
        Skip to content
      </a>

      {/* Desktop: the left rail. */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <a href="#/projects" className="w-fit rounded-md px-2.5 text-base font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            mybase
          </a>
          <Instance />
          <ProjectSwitcher project={project} home={route.page === "projects"} onCreate={onCreate} className="mt-2" />
        </div>
        <div ref={railRef} className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-4 [scrollbar-width:thin]">
          <RailBody route={route} project={project} />
        </div>
        <div className="flex shrink-0 flex-col gap-0.5 border-t pt-3">
          <FooterLinks route={route} />
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={onSearch} className="flex-1 justify-start px-2.5 text-muted-foreground" aria-label="Search and commands">
              <Search />
              Search
              <kbd className="ml-auto font-sans text-xs text-muted-foreground">{SEARCH_SHORTCUT}</kbd>
            </Button>
            <HelpMenu onShortcuts={onShortcuts} />
            <ModeMenu />
          </div>
        </div>
      </aside>

      {/* Mobile: one sticky bar; the rail opens as a sheet from Menu. */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b bg-sidebar px-2 md:hidden">
        <Button variant="ghost" onClick={() => setMenuOpen(true)} className="shrink-0 gap-1.5 px-2" aria-label="Menu" aria-expanded={menuOpen}>
          <Menu />
        </Button>
        <ProjectSwitcher project={project} home={route.page === "projects"} onCreate={onCreate} className="min-w-0 max-w-[45%] flex-1" />
        <span className="min-w-0 truncate px-1 text-muted-foreground" aria-hidden>
          / {here}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          <Button variant="ghost" size="icon" onClick={onSearch} className="text-muted-foreground" aria-label="Search and commands">
            <Search />
          </Button>
          <ModeMenu />
        </div>
      </header>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent className="w-[min(20rem,100%)] max-w-[20rem] bg-sidebar">
          <SheetTitle className="px-5 pt-4">mybase</SheetTitle>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <RailBody route={route} project={project} onNavigate={() => setMenuOpen(false)} />
          </div>
          <div className="flex flex-col gap-0.5 border-t px-3 py-3">
            <NavLink onNavigate={() => setMenuOpen(false)} link={{ label: "Documentation", icon: BookOpen, to: { page: "docs-home" }, active: route.page === "docs-home", inside: route.page === "docs" }} />
            <FooterLinks route={route} onNavigate={() => setMenuOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <main id="main-content" tabIndex={-1} className="min-w-0 px-4 py-6 outline-none md:px-8 md:py-8">
        {children}
      </main>
    </div>
  );
}

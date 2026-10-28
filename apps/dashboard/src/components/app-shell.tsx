import type { ReactNode } from "react";
import { BookOpen, Boxes, LayoutGrid, Search, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { SERVICES } from "@mybase/shared";
import { ModeMenu } from "@/components/mode-menu";
import { ProjectMark, ProjectSwitcher } from "@/components/project-switcher";
import { SERVICE_PAGES } from "@/components/service-card";
import { Button } from "@/components/ui/button";
import { TAB_LABELS } from "@/pages/database/layout";
import { SEARCH_SHORTCUT } from "@/lib/keys";
import { DOC_SERVICES, docRoute } from "@/lib/docs";
import { useProjects } from "@/lib/projects";
import { useRecentProjects } from "@/lib/recent";
import { DB_TABS, href, isProjectRoute, useRoute, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

const RECENT_SHOWN = 5;

type Link = {
  label: string;
  to: Route;
  icon?: LucideIcon;
  mark?: string;
  active: boolean;
  /** Set when the current page sits below this link without being listed under it (a guide under Documentation). */
  inside?: boolean;
  children?: Link[];
};

function NavLink({ link, nested = false, className }: { link: Link; nested?: boolean; className?: string }) {
  const { label, to, icon: Icon, mark, active, children } = link;
  // A parent whose child is the current page reads as "you're inside this", without the marker.
  const inside = !active && (link.inside || children?.some((c) => c.active));
  return (
    <a
      href={href(to)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex shrink-0 items-center gap-2.5 rounded-md px-2.5 whitespace-nowrap text-muted-foreground outline-none",
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        nested ? "h-7" : "h-8",
        // Mobile hides the nested links, so the parent carries the selected surface there.
        inside && "font-medium text-foreground max-md:bg-sidebar-accent",
        active && "bg-sidebar-accent font-medium text-foreground",
        // Active marker: the one place the accent color shows in navigation. Nested items put it on the guide line.
        active && "md:before:absolute md:before:inset-y-1.5 md:before:w-0.5 md:before:rounded-full md:before:bg-primary",
        active && (nested ? "md:before:-left-[9.5px]" : "md:before:-left-3"),
        className,
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" />}
      {mark && <ProjectMark name={mark} />}
      <span className="truncate" title={nested ? label : undefined}>{label}</span>
    </a>
  );
}

/** Rail links for the current context: a project's own pages inside one, the project list everywhere else. */
function useLinks(route: Route): Link[] {
  const { state } = useProjects();
  if (!isProjectRoute(route)) {
    return [{ label: "Projects", icon: Boxes, to: { page: "projects", query: "" }, active: route.page === "projects" }];
  }
  const { name } = route;
  const project = state.status === "ready" ? state.projects.find((p) => p.name === name) : undefined;
  // Core services always; optional ones once the project has them on.
  const services = SERVICES.filter((s) => s.core || project?.services.includes(s.id));

  return [
    { label: "Overview", icon: LayoutGrid, to: { page: "project", name }, active: route.page === "project" },
    ...services.map((s): Link => {
      const { icon, route: to } = SERVICE_PAGES[s.id];
      const here = route.page === s.id;
      if (s.id !== "database") return { label: s.name, icon, to: to(name), active: here };
      const tab = route.page === "database" ? route.tab : null;
      return {
        label: s.name,
        icon,
        to: to(name),
        active: false,
        children: DB_TABS.map((t) => ({ label: TAB_LABELS[t], to: { page: "database", name, tab: t, table: null }, active: tab === t })),
      };
    }),
  ];
}

function RecentProjects({ recent }: { recent: string[] }) {
  const { state } = useProjects();
  if (state.status !== "ready" || state.projects.length === 0) return null;

  // Recently opened first, topped up with the newest projects so the list is useful from the first visit.
  const names = new Set(state.projects.map((p) => p.name));
  const newest = [...state.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => p.name);
  const shown = [...new Set([...recent.filter((n) => names.has(n)), ...newest])].slice(0, RECENT_SHOWN);

  return (
    <section aria-labelledby="rail-recent" className="mt-6 max-md:hidden">
      <h2 id="rail-recent" className="mb-1 px-2.5 text-xs text-muted-foreground">
        Recent
      </h2>
      <ul className="flex flex-col">
        {shown.map((name) => (
          <li key={name}>
            <NavLink link={{ label: name, mark: name, to: { page: "project", name }, active: false }} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Inside the docs, the rail lists every guide, grouped like the docs index. Desktop only; small screens get a picker. */
function DocsLinks({ route }: { route: Route }) {
  const current = route.page === "docs" ? route : null;
  return (
    <nav aria-label="Documentation" className="-mx-1 mt-6 min-h-0 flex-1 overflow-y-auto px-1 pb-4 [scrollbar-width:thin] max-md:hidden">
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

export function AppShell({ children, onSearch, onCreate }: { children: ReactNode; onSearch: () => void; onCreate: () => void }) {
  const route = useRoute();
  const project = isProjectRoute(route) ? route.name : undefined;
  const links = useLinks(route);
  const recent = useRecentProjects(project);
  const settings: Link = { label: "Settings", icon: Settings, to: { page: "settings", newToken: false }, active: route.page === "settings" };
  const security: Link = { label: "Security", icon: ShieldCheck, to: { page: "security", tab: "advisor", project: null }, active: route.page === "security" };
  const inDocs = route.page === "docs" || route.page === "docs-home";
  const docs: Link = { label: "Documentation", icon: BookOpen, to: { page: "docs-home" }, active: route.page === "docs-home", inside: route.page === "docs" };

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      {/* Desktop: left rail. Mobile: a sticky top bar (switcher, search, mode) over a scrolling row of links. */}
      <aside className="sticky top-0 z-10 flex flex-col border-b bg-sidebar md:h-dvh md:border-r md:border-b-0 md:px-3 md:py-4">
        <div className="flex items-center gap-2 px-4 pt-2 md:flex-col md:items-stretch md:gap-3 md:p-0">
          <a
            href="#/projects"
            className="shrink-0 rounded-md px-2.5 text-base font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:px-0"
          >
            mybase
          </a>
          <ProjectSwitcher project={project} home={route.page === "projects"} onCreate={onCreate} className="max-md:max-w-56 max-md:flex-1" />
          <div className="ml-auto flex items-center md:hidden">
            <Button variant="ghost" size="icon" onClick={onSearch} className="text-muted-foreground" aria-label="Search and commands">
              <Search />
            </Button>
            <ModeMenu />
          </div>
        </div>

        <nav
          aria-label={project ? `Project ${project}` : "Main"}
          className="flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] md:mt-4 md:flex-col md:gap-0.5 md:overflow-visible md:p-0"
        >
          {links.map((link) => (
            <div key={link.label} className="contents md:block">
              <NavLink link={link} />
              {link.children?.some((c) => c.active) && (
                <ul className="mt-0.5 mb-1 ml-[1.125rem] flex flex-col gap-0.5 border-l pl-2 max-md:hidden">
                  {link.children.map((c) => (
                    <li key={c.label}>
                      <NavLink link={c} nested />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <NavLink link={docs} className="md:hidden" />
          <NavLink link={security} className="md:hidden" />
          <NavLink link={settings} className="md:hidden" />
        </nav>

        {inDocs ? <DocsLinks route={route} /> : !project && <RecentProjects recent={recent} />}

        <div className="mt-auto flex shrink-0 flex-col gap-0.5 max-md:hidden">
          <NavLink link={docs} />
          <NavLink link={security} />
          <NavLink link={settings} />
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={onSearch} className="flex-1 justify-start px-2.5 text-muted-foreground" aria-label="Search and commands">
              <Search />
              Search
              <kbd className="ml-auto font-sans text-xs text-muted-foreground">{SEARCH_SHORTCUT}</kbd>
            </Button>
            <ModeMenu />
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

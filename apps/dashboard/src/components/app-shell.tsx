import type { ReactNode } from "react";
import { Database, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeMenu } from "@/components/mode-menu";
import { SEARCH_SHORTCUT } from "@/lib/keys";
import { href, useRoute, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

const NAV = [
  { page: "projects", label: "Projects", icon: Database, to: { page: "projects", query: "" } },
  { page: "settings", label: "Settings", icon: Settings, to: { page: "settings" } },
] satisfies { page: Route["page"]; label: string; icon: typeof Database; to: Route }[];

export function AppShell({ children, onSearch }: { children: ReactNode; onSearch: () => void }) {
  const route = useRoute();

  const links = NAV.map(({ page, label, icon: Icon, to }) => {
    // A project's own page sits under Projects.
    const active = route.page === page || (page === "projects" && route.page === "project");
    return (
      <a
        key={page}
        href={href(to)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-muted-foreground outline-none",
          "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
          active && "bg-sidebar-accent font-medium text-foreground",
          // Active marker: the one place the accent color shows in navigation.
          active && "md:before:absolute md:before:inset-y-1.5 md:before:-left-3 md:before:w-0.5 md:before:rounded-full md:before:bg-primary",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {label}
      </a>
    );
  });

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13rem_1fr]">
      {/* Desktop: left rail. Mobile: single top bar with the same links. */}
      <aside className="sticky top-0 z-10 flex items-center gap-1 border-b bg-sidebar px-4 py-2 md:h-dvh md:flex-col md:items-stretch md:gap-0 md:border-r md:border-b-0 md:px-3 md:py-4">
        <a href="#/projects" className="mr-2 px-2.5 text-base font-semibold tracking-tight md:mr-0 md:mb-6">
          mybase
        </a>
        <nav aria-label="Main" className="flex gap-1 md:flex-col">
          {links}
        </nav>
        <div className="ml-auto flex items-center gap-1 md:mt-auto md:ml-0 md:justify-between">
          <Button
            variant="ghost"
            onClick={onSearch}
            className="text-muted-foreground max-md:size-9 max-md:p-0 md:flex-1 md:justify-start md:px-2.5"
            aria-label="Search and commands"
          >
            <Search />
            <span className="max-md:sr-only">Search</span>
            <kbd className="ml-auto font-sans text-xs text-muted-foreground max-md:hidden">{SEARCH_SHORTCUT}</kbd>
          </Button>
          <ModeMenu />
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

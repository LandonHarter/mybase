import { Boxes, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { SERVICES, type Project, type ServiceId } from "@mybase/shared";
import { SERVICE_PAGES } from "@/components/service-card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProjects } from "@/lib/projects";
import { useRecentProjects } from "@/lib/recent";
import { isProjectRoute, navigate, useRoute, type Route } from "@/lib/router";
import { cn } from "@/lib/utils";

/** A project's letter tile, so projects are told apart at a glance in the rail. */
export function ProjectMark({ name, className }: { name: string; className?: string }) {
  const letter = (/[a-z0-9]/i.exec(name)?.[0] ?? "?").toUpperCase();
  return (
    <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] border bg-background text-[11px] font-semibold text-foreground", className)}>
      {letter}
    </span>
  );
}

/** Where switching to `target` lands: the same service if it has it (no item ids), else its Overview. */
export function switchRoute(route: Route, target: Project): Route {
  if (isProjectRoute(route) && route.page !== "project") {
    const id = route.page as ServiceId;
    const service = SERVICES.find((s) => s.id === id);
    if (service && (service.core || target.services.includes(id))) return SERVICE_PAGES[id].route(target.name);
  }
  return { page: "project", name: target.name };
}

/** Projects sorted by most recently opened, then newest. */
export function useSortedProjects(): Project[] {
  const { state } = useProjects();
  const recent = useRecentProjects(undefined);
  if (state.status !== "ready") return [];
  const rank = new Map(recent.map((n, i) => [n, i]));
  return [...state.projects].sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * The rail's project control: which project you're in, and a searchable jump to another (⌘P).
 * Switching keeps the current service when the other project has it.
 */
export function ProjectSwitcher({ project, home, onCreate, className }: { project?: string; home: boolean; onCreate: () => void; className?: string }) {
  const { state } = useProjects();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const projects = useSortedProjects();
  const current = state.status === "ready" ? state.projects.find((p) => p.name === project) : undefined;
  const label = current?.displayName || project;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-project-switcher=""
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-md border bg-background px-2 text-left outline-none pointer-coarse:h-11",
          "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent",
          className,
        )}
        aria-label={project ? `Project: ${label}. Switch project` : "Switch project"}
      >
        {project ? <ProjectMark name={project} /> : <Boxes className="size-4 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate", project ? "font-medium" : !home && "text-muted-foreground")}>{label ?? (home ? "All projects" : "Select project")}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find a project…" />
          <CommandList className="max-h-80">
            <CommandEmpty>{state.status === "offline" ? "Can't reach the API" : state.status === "loading" ? "Loading projects…" : "No matching project"}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all projects"
                onSelect={() => {
                  setOpen(false);
                  navigate({ page: "projects", query: "" });
                }}
              >
                <Boxes />
                All projects
              </CommandItem>
            </CommandGroup>
            {projects.length > 0 && (
              <CommandGroup heading="Projects">
                {projects.map((p) => (
                  <CommandItem
                    key={p.name}
                    value={`${p.name} ${p.displayName ?? ""}`}
                    onSelect={() => {
                      setOpen(false);
                      navigate(switchRoute(route, p));
                    }}
                  >
                    <ProjectMark name={p.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.displayName || p.name}</span>
                      {p.displayName && <span className="block truncate font-mono text-xs text-muted-foreground">{p.name}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums" title={`${p.services.length + 2} services`}>
                      {p.services.length + 2}
                    </span>
                    {p.name === project && <Check className="size-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="create project"
                onSelect={() => {
                  setOpen(false);
                  onCreate();
                }}
              >
                <Plus />
                Create project
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

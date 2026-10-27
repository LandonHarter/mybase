import { Boxes, Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** A project's letter tile, so projects are told apart at a glance in the rail. */
export function ProjectMark({ name, className }: { name: string; className?: string }) {
  const letter = (/[a-z0-9]/i.exec(name)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-[5px] border bg-background text-[11px] font-semibold text-foreground",
        className,
      )}
    >
      {letter}
    </span>
  );
}

/**
 * The rail's top control: shows which project you're in and jumps to another.
 * `project` is the open project, or undefined outside one.
 */
export function ProjectSwitcher({ project, home, onCreate, className }: { project?: string; home: boolean; onCreate: () => void; className?: string }) {
  const { state } = useProjects();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-md border bg-background px-2 text-left outline-none",
          "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent",
          className,
        )}
        aria-label={project ? `Project: ${project}. Switch project` : "Switch project"}
      >
        {project ? <ProjectMark name={project} /> : <Boxes className="size-4 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate", project ? "font-medium" : !home && "text-muted-foreground")}>
          {project ?? (home ? "All projects" : "Select project")}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuItem asChild>
          <a href={href({ page: "projects", query: "" })}>
            <Boxes />
            All projects
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {state.status === "loading" && <DropdownMenuItem disabled>Loading projects…</DropdownMenuItem>}
          {state.status === "offline" && <DropdownMenuItem disabled>Can't reach the API</DropdownMenuItem>}
          {state.status === "ready" && state.projects.length === 0 && <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>}
          {state.status === "ready" &&
            state.projects.map((p) => (
              <DropdownMenuItem key={p.name} onSelect={() => navigate({ page: "project", name: p.name })}>
                <ProjectMark name={p.name} />
                <span className="truncate">{p.name}</span>
                {p.name === project && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreate}>
          <Plus />
          Create project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

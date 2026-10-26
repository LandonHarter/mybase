import { useEffect } from "react";
import { Database, Monitor, Moon, Palette, Plus, Settings, Sun, Trash2 } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ACCENT_LABELS } from "@/components/accent-picker";
import { MODE_LABELS } from "@/components/mode-menu";
import { useProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";
import { ACCENTS, useTheme } from "@/lib/theme";

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Ctrl/⌘K: one place to jump to anything or run any action. */
export function CommandMenu({
  open,
  onOpenChange,
  onCreateProject,
  onDeleteProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateProject: () => void;
  /** Set on a project's page, for deleting that project. */
  onDeleteProject?: () => void;
}) {
  const { state } = useProjects();
  const { setMode, setAccent } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search and commands" description="Jump to a page or project, or run an action.">
      <CommandInput placeholder="Search projects, pages, actions" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={run(onCreateProject)}>
            <Plus />
            Create project
          </CommandItem>
          {onDeleteProject && (
            <CommandItem onSelect={run(onDeleteProject)}>
              <Trash2 />
              Delete this project
            </CommandItem>
          )}
        </CommandGroup>
        {state.status === "ready" && state.projects.length > 0 && (
          <CommandGroup heading="Projects">
            {state.projects.map((p) => (
              <CommandItem key={p.name} value={`project ${p.name}`} onSelect={run(() => navigate({ page: "project", name: p.name, prefix: "" }))}>
                <Database />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          <CommandItem onSelect={run(() => navigate({ page: "projects", query: "" }))}>
            <Database />
            Projects
          </CommandItem>
          <CommandItem onSelect={run(() => navigate({ page: "settings" }))}>
            <Settings />
            Settings
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Appearance">
          {(["light", "dark", "system"] as const).map((m) => {
            const Icon = MODE_ICONS[m];
            return (
              <CommandItem key={m} value={`mode ${MODE_LABELS[m]}`} onSelect={run(() => setMode(m))}>
                <Icon />
                Use {MODE_LABELS[m].toLowerCase()} mode
              </CommandItem>
            );
          })}
          {ACCENTS.map((a) => (
            <CommandItem key={a} value={`accent ${ACCENT_LABELS[a]}`} onSelect={run(() => setAccent(a))}>
              <Palette />
              Use {ACCENT_LABELS[a].toLowerCase()} accent
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

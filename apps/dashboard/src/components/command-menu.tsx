import { useEffect } from "react";
import { Blocks, BookOpen, Bug, ChartColumn, Clock, Database, FolderKanban, Gauge, Globe, HardDrive, KeyRound, KeySquare, Layers, LogOut, Monitor, Moon, Palette, Plus, Settings, SquareTerminal, Sun, Table2, Trash2, Zap } from "lucide-react";
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
import { signOut } from "@/lib/auth";
import { DOCS, docRoute } from "@/lib/docs";
import { useProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";
import { ACCENTS, useTheme } from "@/lib/theme";

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Ctrl/⌘K: one place to jump to anything or run any action. */
export function CommandMenu({
  open,
  onOpenChange,
  project,
  onCreateProject,
  onDeleteProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set on a project's pages: adds jumps to its services. */
  project?: string;
  onCreateProject: () => void;
  /** Set on a project's pages, for deleting that project. */
  onDeleteProject?: () => void;
}) {
  const { state } = useProjects();
  const hasCron = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("cron"));
  const hasAnalytics = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("analytics"));
  const hasCache = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("cache"));
  const hasRateLimit = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("ratelimit"));
  const hasQueue = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("queue"));
  const hasSearch = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("search"));
  const hasSecrets = state.status === "ready" && state.projects.some((p) => p.name === project && p.services.includes("secrets"));
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
      <CommandInput placeholder="Search projects, docs, pages, actions" />
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
          <CommandItem value="create api key token cli" onSelect={run(() => navigate({ page: "settings", newToken: true }))}>
            <KeyRound />
            Create API key
          </CommandItem>
          <CommandItem value="sign out log out" onSelect={run(() => void signOut())}>
            <LogOut />
            Sign out
          </CommandItem>
        </CommandGroup>
        {project && (
          <CommandGroup heading={project}>
            <CommandItem value={`${project} overview`} onSelect={run(() => navigate({ page: "project", name: project }))}>
              <FolderKanban />
              Project overview
            </CommandItem>
            <CommandItem value={`${project} database tables`} onSelect={run(() => navigate({ page: "database", name: project, tab: "tables", table: null }))}>
              <Table2 />
              Database tables
            </CommandItem>
            <CommandItem value={`${project} sql editor query`} onSelect={run(() => navigate({ page: "database", name: project, tab: "sql", table: null }))}>
              <SquareTerminal />
              SQL editor
            </CommandItem>
            <CommandItem value={`${project} postgres extensions`} onSelect={run(() => navigate({ page: "database", name: project, tab: "extensions", table: null }))}>
              <Blocks />
              Database extensions
            </CommandItem>
            <CommandItem value={`${project} database settings connection`} onSelect={run(() => navigate({ page: "database", name: project, tab: "settings", table: null }))}>
              <Database />
              Database settings
            </CommandItem>
            <CommandItem value={`${project} storage files`} onSelect={run(() => navigate({ page: "storage", name: project, prefix: "" }))}>
              <HardDrive />
              Storage
            </CommandItem>
            {state.status === "ready" && !hasCron && (
              <CommandItem value={`${project} turn on cron schedule`} onSelect={run(() => navigate({ page: "cron", name: project, job: null, create: false }))}>
                <Clock />
                Turn on cron
              </CommandItem>
            )}
            {hasCron && (
              <>
                <CommandItem value={`${project} cron jobs schedule`} onSelect={run(() => navigate({ page: "cron", name: project, job: null, create: false }))}>
                  <Clock />
                  Cron jobs
                </CommandItem>
                <CommandItem value={`${project} new cron job schedule`} onSelect={run(() => navigate({ page: "cron", name: project, job: null, create: true }))}>
                  <Plus />
                  New cron job
                </CommandItem>
              </>
            )}
            {state.status === "ready" && !hasAnalytics && (
              <CommandItem
                value={`${project} turn on analytics page views`}
                onSelect={run(() => navigate({ page: "analytics", name: project, tab: "overview", range: "7d" }))}
              >
                <ChartColumn />
                Turn on analytics
              </CommandItem>
            )}
            {hasAnalytics && (
              <>
                <CommandItem
                  value={`${project} analytics page views visitors routes`}
                  onSelect={run(() => navigate({ page: "analytics", name: project, tab: "overview", range: "7d" }))}
                >
                  <ChartColumn />
                  Analytics
                </CommandItem>
                <CommandItem value={`${project} analytics events recent`} onSelect={run(() => navigate({ page: "analytics", name: project, tab: "events", range: "7d" }))}>
                  <ChartColumn />
                  Analytics events
                </CommandItem>
                <CommandItem value={`${project} analytics errors exceptions`} onSelect={run(() => navigate({ page: "analytics", name: project, tab: "errors", range: "7d" }))}>
                  <Bug />
                  Analytics errors
                </CommandItem>
                <CommandItem value={`${project} analytics setup write key script`} onSelect={run(() => navigate({ page: "analytics", name: project, tab: "setup", range: "7d" }))}>
                  <KeyRound />
                  Analytics setup and write key
                </CommandItem>
              </>
            )}
            <CommandItem
              value={`${project} ${hasCache ? "" : "turn on "}cache redis valkey keys`}
              onSelect={run(() => navigate({ page: "cache", name: project, key: null, query: "" }))}
            >
              <Zap />
              {hasCache ? "Cache keys" : "Turn on cache"}
            </CommandItem>
            {hasCache && (
              <CommandItem value={`${project} cache connection password redis url`} onSelect={run(() => navigate({ page: "cache", name: project, key: null, query: "" }))}>
                <KeyRound />
                Cache connection and password
              </CommandItem>
            )}
            <CommandItem value={`${project} ${hasRateLimit ? "" : "turn on "}rate limits throttle rules`} onSelect={run(() => navigate({ page: "ratelimit", name: project }))}>
              <Gauge />
              {hasRateLimit ? "Rate limit rules" : "Turn on rate limits"}
            </CommandItem>
            <CommandItem value={`${project} ${hasQueue ? "" : "turn on "}queues messages sqs fifo`} onSelect={run(() => navigate({ page: "queue", name: project, queue: null }))}>
              <Layers />
              {hasQueue ? "Queues" : "Turn on queues"}
            </CommandItem>
            <CommandItem value={`${project} ${hasSearch ? "" : "turn on "}web search searxng fetch read page agent`} onSelect={run(() => navigate({ page: "search", name: project }))}>
              <Globe />
              {hasSearch ? "Web search" : "Turn on web search"}
            </CommandItem>
            <CommandItem
              value={`${project} ${hasSecrets ? "" : "turn on "}secrets env vars environment variables dotenv config doppler`}
              onSelect={run(() => navigate({ page: "secrets", name: project, env: null }))}
            >
              <KeySquare />
              {hasSecrets ? "Secrets" : "Turn on secrets"}
            </CommandItem>
          </CommandGroup>
        )}
        {state.status === "ready" && state.projects.length > 0 && (
          <CommandGroup heading="Projects">
            {state.projects.map((p) => (
              <CommandItem key={p.name} value={`project ${p.name}`} onSelect={run(() => navigate({ page: "project", name: p.name }))}>
                <Database />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Documentation">
          {DOCS.map((doc) => (
            <CommandItem
              key={doc.slug}
              value={`documentation ${doc.service.name} ${doc.service.packageName ?? ""} ${doc.section} ${doc.title} ${doc.summary} ${doc.markdown.replace(/[`*_#|\[\](){}]/g, " ")}`}
              onSelect={run(() => navigate(docRoute(doc)))}
            >
              <BookOpen />
              <span className="min-w-0 truncate">{doc.title}</span>
              <span className="ml-auto pl-3 text-xs text-muted-foreground max-md:hidden">{doc.service.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Go to">
          <CommandItem onSelect={run(() => navigate({ page: "projects", query: "" }))}>
            <Database />
            Projects
          </CommandItem>
          <CommandItem value="documentation guides sdk" onSelect={run(() => navigate({ page: "docs-home" }))}>
            <BookOpen />
            Documentation
          </CommandItem>
          <CommandItem onSelect={run(() => navigate({ page: "settings", newToken: false }))}>
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

import { useEffect, useMemo, useState } from "react";
import {
  BellRing,
  BookOpen,
  Boxes,
  Clock,
  Container,
  History,
  KeyRound,
  KeySquare,
  Layers,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  Power,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  Trash2,
} from "lucide-react";
import { SERVICES, type CronJob, type HostingOverview, type Queue, type RegistryOverview, type SecretsOverview, type TableSummary, type VectorIndex } from "@mybase/shared";
import { ACCENT_LABELS } from "@/components/accent-picker";
import { MODE_LABELS } from "@/components/mode-menu";
import { ProjectMark, useSortedProjects } from "@/components/project-switcher";
import { SERVICE_PAGES } from "@/components/service-card";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { api } from "@/lib/api";
import { signOut } from "@/lib/auth";
import { usePageCommands } from "@/lib/commands";
import { DOCS, docSections, type DocEntry } from "@/lib/docs";
import { prefetch } from "@/lib/load";
import { useProjects } from "@/lib/projects";
import { recentPages } from "@/lib/recent";
import { href, navigate, type Route } from "@/lib/router";
import { ACCENTS, useTheme } from "@/lib/theme";

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Built once: title, summary and headings per guide (N17), not the whole Markdown. */
let docIndex: { doc: DocEntry; text: string; sections: { id: string; title: string }[] }[] | null = null;
function docsIndex() {
  docIndex ??= DOCS.map((doc) => {
    const sections = docSections(doc.markdown).map((s) => ({ id: s.id, title: s.title }));
    return { doc, sections, text: `${doc.title} ${doc.summary} ${doc.service.name} ${doc.section} ${sections.map((s) => s.title).join(" ")}` };
  });
  return docIndex;
}

interface ProjectObject {
  kind: string;
  label: string;
  to: Route;
  icon: typeof Table2;
}

/**
 * The project's own objects for ⌘K (N13): tables, queues, cron jobs, sites, secrets envs, vector
 * indexes, repos. Loaded lazily when the menu opens (reusing the pages' cached lists, 30 s fresh).
 */
function useProjectObjects(project: string | undefined, open: boolean): ProjectObject[] {
  const { state } = useProjects();
  const services = state.status === "ready" ? (state.projects.find((p) => p.name === project)?.services ?? []) : [];
  const [objects, setObjects] = useState<ProjectObject[]>([]);
  const has = services.join(",");
  useEffect(() => {
    if (!open || !project) return;
    let live = true;
    const on = (id: string) => has.split(",").includes(id);
    const jobs: Promise<ProjectObject[]>[] = [
      prefetch<TableSummary[]>(`tables:${project}`, () => api.listTables(project)).then((t) =>
        (t ?? []).map((x) => ({ kind: x.kind === "table" ? "Table" : "View", label: `${x.schema}.${x.name}`, icon: Table2, to: { page: "database", name: project, tab: "tables", table: `${x.schema}.${x.name}` } })),
      ),
    ];
    if (on("queue")) jobs.push(prefetch<Queue[]>(`queues:${project}:0`, () => api.queues(project)).then((q) => (q ?? []).map((x) => ({ kind: "Queue", label: x.name, icon: Layers, to: { page: "queue", name: project, queue: x.name } }))));
    if (on("cron")) jobs.push(prefetch<CronJob[]>(`cron-jobs:${project}`, () => api.listCronJobs(project)).then((j) => (j ?? []).map((x) => ({ kind: "Cron job", label: x.name, icon: Clock, to: { page: "cron", name: project, job: x.name, create: false } }))));
    if (on("hosting")) jobs.push(prefetch<HostingOverview>(`hosting:${project}`, () => api.hosting(project)).then((h) => (h?.sites ?? []).map((x) => ({ kind: "Site", label: x.name, icon: Rocket, to: { page: "hosting", name: project, site: x.name } }))));
    if (on("secrets")) jobs.push(prefetch<SecretsOverview>(`secrets:${project}`, () => api.secrets(project)).then((s) => (s?.envs ?? []).map((x) => ({ kind: "Secrets env", label: x.name, icon: KeySquare, to: { page: "secrets", name: project, env: x.name } }))));
    if (on("vector")) jobs.push(prefetch<VectorIndex[]>(`vector-indexes:${project}:0`, () => api.vectorIndexes(project)).then((v) => (v ?? []).map((x) => ({ kind: "Vector index", label: x.name, icon: Sparkles, to: { page: "vector", name: project, index: x.name } }))));
    if (on("registry")) jobs.push(prefetch<RegistryOverview>(`registry:${project}`, () => api.registry(project)).then((r) => (r?.repositories ?? []).map((x) => ({ kind: "Repository", label: x.name, icon: Container, to: { page: "registry", name: project, repo: x.name } }))));
    // One failed list never hides the others.
    void Promise.all(jobs.map((j) => j.catch(() => []))).then((lists) => live && setObjects(lists.flat()));
    return () => {
      live = false;
    };
  }, [open, project, has]);
  return project ? objects : [];
}

/** Ctrl/⌘K: jump to anything (projects, pages, your tables and queues), or run an action. */
export function CommandMenu({
  open,
  onOpenChange,
  project,
  onCreateProject,
  onDeleteProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set on a project's pages: adds its services, objects and actions. */
  project?: string;
  onCreateProject: () => void;
  /** Set on a project's pages, for deleting that project. */
  onDeleteProject?: () => void;
}) {
  const { state } = useProjects();
  const projects = useSortedProjects();
  const { setMode, setAccent } = useTheme();
  const [search, setSearch] = useState("");
  const pageCommands = usePageCommands();
  const objects = useProjectObjects(project, open);
  const current = state.status === "ready" ? state.projects.find((p) => p.name === project) : undefined;
  const label = current?.displayName || project;
  const recent = useMemo(() => (open ? recentPages().filter((p) => p.hash !== window.location.hash).slice(0, 5) : []), [open]);
  const typed = search.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `key` can be missing: browser autofill sends keydown events without one.
      if (e.key?.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const go = (to: Route) => run(() => navigate(to));

  const services = current ? SERVICES.filter((s) => s.core || current.services.includes(s.id)) : [];
  const offServices = current ? SERVICES.filter((s) => !s.core && !current.services.includes(s.id)) : [];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search and commands" description="Jump to a page, project, or object, or run an action.">
      <CommandInput placeholder={project ? `Search ${label}, pages, docs, actions` : "Search projects, pages, docs, actions"} value={search} onValueChange={setSearch} />
      <CommandList className="max-h-[min(28rem,70dvh)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>

        {pageCommands.length > 0 && (
          <CommandGroup heading="This page">
            {pageCommands.map((c) => {
              const Icon = c.icon;
              return (
                <CommandItem key={c.id} value={`page ${c.label} ${c.keywords ?? ""}`} onSelect={run(c.run)}>
                  {Icon && <Icon />}
                  {c.label}
                  {c.shortcut && <kbd className="ml-auto font-sans text-xs text-muted-foreground">{c.shortcut}</kbd>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {!typed && recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((p) => (
              <CommandItem key={p.hash} value={`recent ${p.title} ${p.hash}`} onSelect={run(() => (window.location.hash = p.hash))}>
                <History />
                <span className="truncate">{p.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!typed && (
          <CommandGroup heading="Suggested">
            <CommandItem value="suggested create project" onSelect={run(onCreateProject)}>
              <Plus />
              Create project
            </CommandItem>
          </CommandGroup>
        )}

        {project && objects.length > 0 && typed && (
          <CommandGroup heading={`In ${label}`}>
            {objects.map((o) => (
              <CommandItem key={`${o.kind}:${o.label}`} value={`object ${o.label} ${o.kind}`} onSelect={go(o.to)}>
                <o.icon />
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">{o.kind}</span> <span className="font-mono text-[13px]">{o.label}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {project && (
          <CommandGroup heading={label}>
            <CommandItem value={`${project} overview`} onSelect={go({ page: "project", name: project })}>
              <LayoutGrid />
              Overview
            </CommandItem>
            {services.map((s) => {
              const page = SERVICE_PAGES[s.id];
              return (
                <CommandItem key={s.id} value={`${project} ${s.name} ${page.summary}`} onSelect={go(page.route(project))}>
                  <page.icon />
                  {s.name}
                </CommandItem>
              );
            })}
            {services.flatMap((s) =>
              (SERVICE_PAGES[s.id].commands?.(project) ?? []).map((c) => {
                const Icon = c.icon ?? SERVICE_PAGES[s.id].icon;
                return (
                <CommandItem key={`${s.id}:${c.label}`} value={`${project} ${s.name} ${c.label} ${c.keywords ?? ""}`} onSelect={go(c.to)}>
                  <Icon />
                  {c.label}
                </CommandItem>
                );
              }),
            )}
            <CommandItem value={`${project} security advisor checks`} onSelect={go({ page: "security", tab: "advisor", project })}>
              <ShieldCheck />
              Security checks for this project
            </CommandItem>
          </CommandGroup>
        )}

        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((p) => (
              <CommandItem key={p.name} value={`project ${p.name} ${p.displayName ?? ""}`} onSelect={go({ page: "project", name: p.name })}>
                <ProjectMark name={p.name} />
                <span className="truncate">{p.displayName || p.name}</span>
                {p.displayName && <span className="font-mono text-xs text-muted-foreground">{p.name}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          <CommandItem value="go projects" onSelect={go({ page: "projects", query: "" })}>
            <Boxes />
            Projects
          </CommandItem>
          <CommandItem value="go documentation guides sdk" onSelect={go({ page: "docs-home" })}>
            <BookOpen />
            Documentation
          </CommandItem>
          <CommandItem value="go security advisor checks problems findings" onSelect={go({ page: "security", tab: "advisor", project: null })}>
            <ShieldCheck />
            Security advisor
          </CommandItem>
          <CommandItem value="go audit log who did what sign-ins history" onSelect={go({ page: "security", tab: "audit", project: null })}>
            <ScrollText />
            Audit log
          </CommandItem>
          <CommandItem value="go security alerts notifications ntfy webhook" onSelect={go({ page: "security", tab: "alerts", project: null })}>
            <BellRing />
            Security alerts
          </CommandItem>
          <CommandItem value="go settings" onSelect={go({ page: "settings", newToken: false })}>
            <Settings />
            Settings
          </CommandItem>
          <CommandItem value="create api key token cli" onSelect={go({ page: "settings", newToken: true })}>
            <KeyRound />
            Create API key
          </CommandItem>
          <CommandItem value="two-factor authentication 2fa totp mfa recovery codes" onSelect={go({ page: "settings", newToken: false, section: "2fa" })}>
            <ShieldCheck />
            Two-factor authentication
          </CommandItem>
          <CommandItem value="change password account" onSelect={go({ page: "settings", newToken: false, section: "password" })}>
            <KeyRound />
            Change password
          </CommandItem>
        </CommandGroup>

        {typed && project && offServices.length > 0 && (
          <CommandGroup heading="Add a service">
            {offServices.map((s) => {
              const page = SERVICE_PAGES[s.id];
              return (
                <CommandItem key={s.id} value={`turn on ${s.name} ${page.summary}`} onSelect={go(page.route(project))}>
                  <Power />
                  Turn on {s.name.toLowerCase()}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {typed && (
          <CommandGroup heading="Documentation">
            {docsIndex().flatMap(({ doc, text, sections }) => [
              <CommandItem key={`${doc.service.id}/${doc.slug}`} value={`docs ${text}`} onSelect={go({ page: "docs", service: doc.service.id, slug: doc.slug, section: null })}>
                <BookOpen />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{doc.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{doc.summary}</span>
                </span>
                <span className="pl-3 text-xs text-muted-foreground max-md:hidden">{doc.service.name}</span>
              </CommandItem>,
              ...sections
                .filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase()))
                .slice(0, 3)
                .map((s) => (
                  <CommandItem key={`${doc.service.id}/${doc.slug}#${s.id}`} value={`docs section ${s.title} ${doc.title}`} onSelect={go({ page: "docs", service: doc.service.id, slug: doc.slug, section: s.id })}>
                    <BookOpen className="opacity-50" />
                    <span className="truncate">
                      {doc.title} <span className="text-muted-foreground">› {s.title}</span>
                    </span>
                  </CommandItem>
                )),
            ])}
            <CommandItem value={`docs search full text ${search}`} onSelect={go({ page: "docs-home", query: search.trim() })}>
              <Search />
              Search docs for “{search.trim()}”
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Appearance">
          {(["light", "dark", "system"] as const).map((m) => {
            const Icon = MODE_ICONS[m];
            return (
              <CommandItem key={m} value={`mode ${MODE_LABELS[m]} theme`} onSelect={run(() => setMode(m))}>
                <Icon />
                Use {MODE_LABELS[m].toLowerCase()} mode
              </CommandItem>
            );
          })}
          {ACCENTS.map((a) => (
            <CommandItem key={a} value={`accent color ${ACCENT_LABELS[a]}`} onSelect={run(() => setAccent(a))}>
              <Palette />
              Use {ACCENT_LABELS[a].toLowerCase()} accent
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Destructive and session actions: only after typing, ranked last (N16). */}
        {search.trim().length >= 3 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Account and danger">
              {onDeleteProject && (
                <CommandItem value={`delete project ${project}`} onSelect={run(onDeleteProject)} className="text-destructive data-[selected=true]:text-destructive">
                  <Trash2 />
                  Delete project {label}…
                </CommandItem>
              )}
              <CommandItem value="sign out log out" onSelect={run(() => void signOut())}>
                <LogOut />
                Sign out
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        <kbd className="font-sans">↵</kbd> open · <kbd className="font-sans">esc</kbd> close · <a className="underline-offset-2 hover:underline" href={href({ page: "docs-home" })} onClick={() => onOpenChange(false)}>Docs</a>
      </p>
    </CommandDialog>
  );
}

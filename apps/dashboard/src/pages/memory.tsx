import { useState, type FormEvent } from "react";
import { KeyRound, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@mybase/shared";
import type { Memory, MemorySettings } from "@mybase-dev/sdk/memory";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Facts, Inspector } from "@/components/inspector";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ConnectMethod, ConnectSheet, DangerZone, ServiceViews } from "@/components/service-layout";
import { ServiceOff } from "@/components/service-off";
import { TableSkeleton } from "@/components/states";
import { Badge, Section } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatCount, formatDate, plural } from "@/lib/format";
import { errorMessage, invalidate, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate, useServiceView } from "@/lib/router";

const sdkSnippet = (s: MemorySettings, project: string) => `import { createMemoryClient, memoryTools } from "@mybase-dev/sdk/memory";

const memory = createMemoryClient({
  apiUrl: "${s.apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

// After a turn of the conversation:
await memory.add({ userId, messages });
// Before answering:
const { results } = await memory.search("what do they like?", { userId });
// Or let the agent decide: search_memory + add_memory tools
const tools = memoryTools(memory, { userId });`;

interface MemoryRoute {
  name: string;
  user: string | null;
  agent?: string | null;
  query: string;
}

function MemoryDetail({ project, memory, onClose }: { project: string; memory: Memory; onClose: () => void }) {
  const history = useLoad(`memory-history:${project}:${memory.id}`, () => api.memoryHistory(project, memory.id));
  const [text, setText] = useState(memory.memory);
  const [pending, setPending] = useState(false);
  async function save() {
    setPending(true);
    try {
      await api.updateMemory(project, memory.id, text);
      toast.success("Memory updated");
      invalidate(`memory-`);
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    try {
      await api.deleteMemory(project, memory.id);
      toast.success("Memory deleted");
      invalidate("memory-");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    }
  }
  return (
    <Inspector
      open
      onOpenChange={(open) => !open && onClose()}
      kind="Memory"
      identifier={memory.id}
      actions={
        <>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={remove}>
            <Trash2 />
            Delete
          </Button>
          <Button onClick={save} disabled={pending || text.trim() === memory.memory || !text.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6">
        <div className="grid gap-1.5">
          <Label htmlFor="mem-text">Memory</Label>
          <Textarea id="mem-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        </div>
        <Facts
          items={[
            ["User", memory.userId ?? "—"],
            ["Agent", memory.agentId ?? "—"],
            ["Run", memory.runId ?? "—"],
            ["Updated", formatDate(memory.updatedAt)],
            ["Expires", memory.expiresAt ? formatDate(memory.expiresAt) : "Never"],
            ["Metadata", Object.keys(memory.metadata).length ? <code className="font-mono text-xs">{JSON.stringify(memory.metadata)}</code> : "—"],
          ]}
        />
        <section>
          <h3 className="mb-2 font-medium">History</h3>
          {history.state.status === "loading" && <LoadingLines label="Loading history" lines={2} />}
          {history.data && (
            <ol className="grid gap-2">
              {history.data.map((h) => (
                <li key={h.id} className="grid gap-0.5 border-t pt-2">
                  <span className="text-xs text-muted-foreground">
                    <Badge tone={h.event === "DELETE" ? "danger" : h.event === "ADD" ? "success" : "info"}>{h.event}</Badge> {formatDate(h.at)}
                  </span>
                  {h.old && <p className="text-muted-foreground line-through">{h.old}</p>}
                  {h.new && <p>{h.new}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Inspector>
  );
}

function AddDialog({ project, user, onClose }: { project: string; user: string | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [infer, setInfer] = useState(true);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    try {
      const res = await api.addMemory(project, {
        userId: String(f.get("userId") ?? "").trim() || undefined,
        agentId: String(f.get("agentId") ?? "").trim() || undefined,
        text: String(f.get("text") ?? ""),
        infer,
      });
      toast.success(res.results.length ? res.results.map((r) => `${r.event}: ${r.memory}`).join(" · ") : "Nothing new to remember");
      invalidate("memory-");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a memory</DialogTitle>
            <DialogDescription>With "Extract facts" on, the LLM pulls facts out of the text and reconciles them with this user's memories, exactly as apps do.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="add-user">User id</Label>
              <Input id="add-user" name="userId" defaultValue={user ?? ""} className="font-mono" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-agent">Agent id</Label>
              <Input id="add-agent" name="agentId" className="font-mono" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="add-text">Text</Label>
            <Textarea id="add-text" name="text" required rows={4} placeholder="I'm vegetarian and I just moved to Porto." autoFocus />
          </div>
          <label className="flex items-center gap-2">
            <Switch checked={infer} onCheckedChange={setInfer} aria-label="Extract facts" />
            Extract facts (two LLM calls through the AI gateway)
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add memory"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsView({ project, settings, onSaved }: { project: string; settings: MemorySettings; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ttl = String(f.get("ttl") ?? "").trim();
    try {
      await api.updateMemorySettings(project, {
        llmModel: String(f.get("llm") ?? "").trim(),
        embedModel: String(f.get("embed") ?? "").trim(),
        dimensions: Number(f.get("dims")),
        customPrompt: String(f.get("prompt") ?? "").trim() || null,
        defaultTtlDays: ttl ? Number(ttl) : null,
      });
      toast.success("Saved memory settings");
      setError(null);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function turnOff() {
    await api.disableService(project, "memory");
    await refreshProjects();
    toast.success(`Turned off memory for ${project}`);
    navigate({ page: "project", name: project });
  }
  return (
    <>
      <form onSubmit={save}>
        <Row title="Fact model" hint="Extracts facts and decides add/update/delete. Any gateway model id or alias.">
          <Input name="llm" defaultValue={settings.llmModel} required className="font-mono" />
        </Row>
        <Row title="Embedding model" hint="Changing it re-embeds every memory. Changing dimensions needs no memories stored.">
          <div className="flex gap-2">
            <Input name="embed" defaultValue={settings.embedModel} required className="font-mono" />
            <Input name="dims" type="number" min={1} max={2000} defaultValue={settings.dimensions} className="w-28" aria-label="Dimensions" />
          </div>
        </Row>
        <Row title="Extra instructions" hint="Added to the fact extraction prompt: what to keep, what to skip.">
          <Textarea name="prompt" rows={3} defaultValue={settings.customPrompt ?? ""} placeholder="Only keep food preferences and allergies." />
        </Row>
        <Row title="Forget after" hint="Days a memory lives (apps can set ttlDays per add). Empty: keep.">
          <Input name="ttl" type="number" min={1} max={3650} defaultValue={settings.defaultTtlDays ?? ""} placeholder="Keep" className="w-28" />
        </Row>
        {error && (
          <p role="alert" className="mb-3 text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="mb-8">
          Save settings
        </Button>
      </form>
      <DangerZone
        title="Delete memories and turn off"
        action={
          <Button variant="danger-outline" onClick={() => setOff(true)}>
            Turn off memory…
          </Button>
        }
      >
        {SERVICE_PAGES.memory.turnOff}
      </DangerZone>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off memory for ${project}`}
        description={SERVICE_PAGES.memory.turnOff}
        confirm="Turn off memory"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

function MemoryLayout({ project, route }: { project: Project; route: MemoryRoute }) {
  const name = project.name;
  const view = useServiceView();
  const settings = useLoad(`memory-settings:${name}`, () => api.memorySettings(name));
  const scopes = useLoad(`memory-scopes:${name}`, () => api.memoryScopes(name));
  const scoped = route.user !== null || (route.agent ?? null) !== null;
  const list = useLoad(`memory-list:${name}:${route.user ?? ""}:${route.agent ?? ""}`, () =>
    scoped ? api.memories(name, { userId: route.user, agentId: route.agent }) : Promise.resolve(null),
  );
  const [search, setSearch] = useState(route.query);
  const results = useLoad(`memory-search:${name}:${route.user ?? ""}:${route.query}`, () =>
    route.query ? api.searchMemories(name, { query: route.query, userId: route.user ?? undefined, agentId: route.agent ?? undefined, topK: 20 }) : Promise.resolve(null),
  );
  const [open, setOpen] = useState<Memory | null>(null);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState(false);
  const [clearing, setClearing] = useState(false);
  const s = settings.data;

  const go = (patch: Partial<MemoryRoute>) => navigate({ page: "memory", name, user: route.user, agent: route.agent, query: route.query, ...patch }, { replace: true });
  const rows = route.query ? (results.data?.results ?? []) : (list.data?.memories ?? []);

  return (
    <>
      <PageHeader
        title="Memory"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description={
          s ? (
            <span aria-live="polite">
              {plural(s.memories, "memory", "memories")} · facts by <span className="font-mono text-[13px]">{s.llmModel}</span>
            </span>
          ) : (
            " "
          )
        }
        action={
          <>
            {s && (
              <ConnectSheet title={`Use ${name}'s memory from an app`}>
                <Row title="API key" hint="memory:write to add, memory:read to search. Server-side only.">
                  <Button variant="outline" size="sm" onClick={() => setKey(true)}>
                    <KeyRound />
                    Create API key
                  </Button>
                </Row>
                <ConnectMethod title="SDK">
                  <CodeBlock code={sdkSnippet(s, name)} lang="ts" />
                </ConnectMethod>
                <ConnectMethod title="From SQL">
                  <CodeBlock code={`select content, updated_at from mybase_memory.memories where user_id = 'u_42' order by updated_at desc;`} lang="sql" />
                </ConnectMethod>
              </ConnectSheet>
            )}
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add memory
            </Button>
          </>
        }
      />
      <ServiceViews route={{ page: "memory", name, user: null, query: "" }} view={view} label="Memory" main="Memories" />

      {view === "settings" && s && <SettingsView project={name} settings={s} onSaved={settings.refresh} />}
      {view !== "settings" && (
        <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
          <Section id="memory-scopes" title="Users and agents" count={scopes.data ? formatCount(scopes.data.length) : undefined}>
            {scopes.state.status === "loading" && <LoadingLines label="Loading users" />}
            {scopes.state.status === "error" && <LoadError what="users" message={scopes.state.message} onRetry={scopes.refresh} />}
            {scopes.data && scopes.data.length === 0 && <p className="text-muted-foreground">No memories yet. Apps add them with memory.add, or add one here.</p>}
            {scopes.data && (
              <ul className="grid gap-0.5">
                {scopes.data.map((sc) => {
                  const selected = (sc.userId ?? null) === route.user && (sc.agentId ?? null) === (route.agent ?? null);
                  return (
                    <li key={`${sc.userId}\0${sc.agentId}`}>
                      <a
                        href={href({ page: "memory", name, user: sc.userId, agent: sc.agentId, query: "" })}
                        aria-current={selected ? "page" : undefined}
                        className="flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:bg-selected"
                      >
                        <span className="min-w-0 truncate font-mono text-[13px]">{sc.userId ?? `agent ${sc.agentId}`}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{sc.memories}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            id="memory-list"
            title={route.query ? `Results for "${route.query}"` : route.user ? `Memories of ${route.user}` : route.agent ? `Memories of agent ${route.agent}` : "Memories"}
            actions={
              scoped && (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setClearing(true)}>
                  <Trash2 />
                  Delete all
                </Button>
              )
            }
          >
            <form
              className="mb-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                go({ query: search.trim() });
              }}
            >
              <Input
                data-filter
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={route.user ? `Search ${route.user}'s memories` : "Search every memory"}
                aria-label="Search memories"
              />
              <Button type="submit" variant="outline">
                <Search />
                Search
              </Button>
            </form>
            {!scoped && !route.query ? (
              <p className="text-muted-foreground">Pick a user or agent, or search.</p>
            ) : (list.state.status === "loading" && !route.query) || (results.state.status === "loading" && route.query) ? (
              <TableSkeleton label="Loading memories" columns={2} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Memory</TableHead>
                    {route.query && <TableHead className="text-right">Score</TableHead>}
                    <TableHead className="text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && <TableEmpty colSpan={3}>{route.query ? "Nothing matches." : "No memories."}</TableEmpty>}
                  {rows.map((m) => (
                    <TableRow key={m.id} data-row className="relative">
                      <TableCell className="max-w-0 w-full">
                        <a href="#" onClick={(e) => (e.preventDefault(), setOpen(m))} className="outline-none after:absolute after:inset-0 focus-visible:underline">
                          {m.memory}
                        </a>
                        {!route.user && m.userId && <span className="ml-2 font-mono text-xs text-muted-foreground">{m.userId}</span>}
                      </TableCell>
                      {route.query && <TableCell className="text-right tabular-nums">{"score" in m ? (m.score as number).toFixed(3) : ""}</TableCell>}
                      <TableCell className="text-right whitespace-nowrap">
                        <TimeAgo iso={m.updatedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      )}

      {open && <MemoryDetail project={name} memory={open} onClose={() => setOpen(null)} />}
      {adding && <AddDialog project={name} user={route.user} onClose={() => setAdding(false)} />}
      <KeyDialog open={key} onOpenChange={setKey} preset={{ name: `${name} memory`, permissions: ["memory:write", "ai:write"], projects: [name] }} />
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title={`Delete every memory of ${route.user ?? `agent ${route.agent}`}`}
        description="They can't be recovered (their history keeps the old text)."
        confirm="Delete memories"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          const res = await api.deleteMemories(name, { userId: route.user ?? undefined, agentId: route.agent ?? undefined });
          toast.success(`Deleted ${plural(res.deleted, "memory", "memories")}`);
          invalidate("memory-");
          go({ user: null, agent: null, query: "" });
        }}
      />
    </>
  );
}

export function MemoryPage(route: MemoryRoute) {
  return (
    <ProjectGate name={route.name} title="Memory" backToProject>
      {(project) =>
        project.services.includes("memory") ? (
          <MemoryLayout project={project} route={route} />
        ) : (
          <ServiceOff project={project} id="memory">
            Long-term memory for your app's agents: send conversations, mybase keeps the facts about each user current, and agents search them before answering. Runs on the AI
            gateway.
          </ServiceOff>
        )
      }
    </ProjectGate>
  );
}

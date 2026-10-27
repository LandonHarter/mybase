import { useState, type FormEvent } from "react";
import { KeyRound, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import type {
  Project,
  StoredDocument,
  VectorIndex,
  VectorLanguage,
  VectorMetric,
  VectorQueryMode,
  VectorQueryResponse,
  VectorServiceSettings,
} from "@mybase/shared";
import { formatCount, LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

// The same values as VECTOR_INDEX_RULES / VECTOR_METRICS / VECTOR_LANGUAGES in @mybase-dev/sdk/vector
// (types only reach the dashboard's browser build, so the values are repeated here).
const VECTOR_INDEX_RULES = "Use 1–48 lowercase letters, digits, or `_`, starting with a letter.";
const VECTOR_METRICS: VectorMetric[] = ["cosine", "l2", "ip"];
const VECTOR_LANGUAGES: VectorLanguage[] = [
  "simple", "arabic", "armenian", "basque", "catalan", "danish", "dutch", "english", "finnish", "french",
  "german", "greek", "hindi", "hungarian", "indonesian", "irish", "italian", "lithuanian", "nepali",
  "norwegian", "portuguese", "romanian", "russian", "serbian", "spanish", "swedish", "tamil", "turkish", "yiddish",
];

const selectClass = "h-9 rounded-md border bg-transparent px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;
const mono = (text: string) => <code className="font-mono text-[0.85em] text-foreground">{text}</code>;

const METRIC_LABELS: Record<VectorMetric, string> = { cosine: "Cosine", l2: "Euclidean (L2)", ip: "Inner product" };
const MODE_LABELS: Record<VectorQueryMode, string> = { hybrid: "Hybrid", vector: "Vector", text: "Keywords" };

const sdkSnippet = (apiUrl: string, project: string, index: string) => `import { createVectorClient } from "@mybase-dev/sdk/vector";

const vector = createVectorClient({
  apiUrl: "${apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

const docs = vector.index("${index}");
await docs.upsert([{ id: "faq-1", title: "Reset your password", text: "…", metadata: { lang: "en" } }]);
const { matches } = await docs.query("forgot my password", { topK: 5, filter: { lang: "en" } });`;

const CONFIG_SNIPPET = `// mybase.config.ts, then: mybase vector sync
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "<project>",
  vector: {
    indexes: {
      docs: { dimensions: 1536, metric: "cosine", language: "english", embed: true },
      notes: { language: "simple" }, // keywords only
    },
  },
});`;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground" title={title}>
      {children}
    </span>
  );
}

const SOURCE_TAGS: Record<VectorIndex["source"], { label: string; title: string } | null> = {
  dashboard: null,
  code: { label: "Code", title: "Defined in mybase.config.ts; change it there and run mybase vector sync" },
  api: { label: "App", title: "Created by your app with createIndex()" },
};

function IndexTags({ index }: { index: VectorIndex }) {
  const source = SOURCE_TAGS[index.source];
  return (
    <>
      {index.embed && <Tag title="mybase embeds text that comes without a vector">Embeds</Tag>}
      {source && <Tag title={source.title}>{source.label}</Tag>}
    </>
  );
}

const describeVectors = (i: VectorIndex) => (i.dimensions ? `${i.dimensions} dimensions, ${METRIC_LABELS[i.metric].toLowerCase()}` : "Keywords only");

// ---- index list -------------------------------------------------------------

function IndexList({ project, indexes, onCreate }: { project: string; indexes: VectorIndex[]; onCreate: () => void }) {
  if (indexes.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No indexes yet</p>
        <p className="mt-1 text-muted-foreground">
          An index holds documents your app searches: help articles, products, chat history for an agent. Search by meaning (vectors), by keywords, or both. Create
          one here, declare them in {mono("mybase.config.ts")}, or call {mono("createIndex()")} from your app.
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onCreate}>
          <Plus />
          New index
        </Button>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Vectors</TableHead>
          <TableHead>Language</TableHead>
          <TableHead className="text-right">Documents</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {indexes.map((i) => (
          <TableRow key={i.name}>
            <TableCell>
              <span className="flex flex-wrap items-center gap-2">
                <a href={href({ page: "vector", name: project, index: i.name })} className="font-mono text-xs font-medium outline-none hover:underline focus-visible:underline">
                  {i.name}
                </a>
                <IndexTags index={i} />
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">{describeVectors(i)}</TableCell>
            <TableCell className="text-muted-foreground">{i.language}</TableCell>
            <TableCell className="text-right">{formatCount(i.documents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function IndexDialog({
  project,
  settings,
  open,
  onOpenChange,
}: {
  project: string;
  settings: VectorServiceSettings | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const model = settings?.embedding ?? null;
  const [embed, setEmbed] = useState(model !== null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const dims = String(form.get("dimensions") ?? "").trim();
    setPending(true);
    setError(null);
    try {
      const index = await api.createVectorIndex(project, {
        name,
        dimensions: embed ? undefined : dims ? Number(dims) : null,
        metric: String(form.get("metric")) as VectorMetric,
        language: String(form.get("language")) as VectorLanguage,
        embed,
      });
      toast.success(`Created ${index.name}`);
      onOpenChange(false);
      navigate({ page: "vector", name: project, index: index.name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>New index</DialogTitle>
            <DialogDescription>Vector size, distance, and language are fixed once it's created.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="index-name">Name</Label>
            <Input id="index-name" name="name" required autoFocus autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
            <p className="text-muted-foreground">{VECTOR_INDEX_RULES}</p>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="index-embed">Embed text for me</Label>
              <p className="mt-1 text-muted-foreground">
                {model ? `Documents and queries without a vector are embedded with ${model.model} (${model.dimensions} dimensions).` : "Set an embedding model below first."}
              </p>
            </div>
            <Switch id="index-embed" checked={embed} onCheckedChange={setEmbed} disabled={!model} />
          </div>
          {!embed && (
            <div className="grid gap-2">
              <Label htmlFor="index-dims">Dimensions</Label>
              <Input id="index-dims" name="dimensions" type="number" min={1} max={2000} placeholder="e.g. 1536" className="w-36" />
              <p className="text-muted-foreground">Your embedding model's vector length. Leave empty for keyword search only.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="index-metric">Distance</Label>
              <select id="index-metric" name="metric" defaultValue="cosine" className={selectClass}>
                {VECTOR_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="index-language">Keyword language</Label>
              <select id="index-language" name="language" defaultValue="english" className={selectClass}>
                {VECTOR_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l === "simple" ? "simple (no stemming)" : l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create index"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- embedding settings -----------------------------------------------------

function EmbeddingRow({ project, settings, onSaved }: { project: string; settings: VectorServiceSettings; onSaved: () => void }) {
  const current = settings.embedding;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const key = String(form.get("apiKey") ?? "");
    setPending(true);
    setError(null);
    try {
      await api.updateVectorSettings(project, {
        embedding: {
          url: String(form.get("url") ?? "").trim(),
          model: String(form.get("model") ?? "").trim(),
          dimensions: Number(form.get("dimensions")),
          // Empty keeps the stored key.
          apiKey: key ? key : undefined,
        },
      });
      toast.success("Saved the embedding model");
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    try {
      await api.updateVectorSettings(project, { embedding: null });
      toast.success("Removed the embedding model");
      onSaved();
    } catch (err) {
      toast.error(`Couldn't remove it: ${errorMessage(err)}`);
    }
  }

  return (
    <Row
      title="Embedding model"
      hint={
        <>
          Any OpenAI-compatible {mono("/embeddings")} endpoint: OpenAI, or Ollama on another machine. Without one, apps send their own vectors.
        </>
      }
    >
      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {current ? (
            <div className="min-w-0">
              <p className="font-medium">
                {current.model} <span className="font-normal text-muted-foreground">· {current.dimensions} dimensions</span>
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{current.url}</p>
              <p className="text-muted-foreground">{current.hasKey ? "API key stored, encrypted" : "No API key"}</p>
            </div>
          ) : (
            <p className="text-muted-foreground">None set.</p>
          )}
          <div className="flex gap-2">
            {current && (
              <Button variant="ghost" size="sm" onClick={remove}>
                Remove
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {current ? "Change" : "Set embedding model"}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="embed-url">Base URL</Label>
            <Input
              id="embed-url"
              name="url"
              type="url"
              required
              defaultValue={current?.url ?? ""}
              placeholder="https://api.openai.com/v1"
              className="font-mono text-xs md:text-xs"
            />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="embed-model">Model</Label>
              <Input id="embed-model" name="model" required defaultValue={current?.model ?? ""} placeholder="text-embedding-3-small" className="font-mono text-xs md:text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="embed-dims">Dimensions</Label>
              <Input id="embed-dims" name="dimensions" type="number" required min={1} max={2000} defaultValue={current?.dimensions ?? 1536} className="w-28" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="embed-key">API key</Label>
            <Input
              id="embed-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={current?.hasKey ? "Leave empty to keep the stored key" : "Optional (Ollama needs none)"}
              className="font-mono text-xs md:text-xs"
            />
            <p className="text-muted-foreground">Encrypted with {mono("MYBASE_SECRETS_KEY")} and never shown again.</p>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Row>
  );
}

// ---- service page -----------------------------------------------------------

function Indexes({ project }: { project: Project }) {
  const name = project.name;
  const [version, setVersion] = useState(0);
  const indexes = useLoad(`vector-indexes:${name}:${version}`, () => api.vectorIndexes(name));
  const settings = useLoad(`vector-settings:${name}:${version}`, () => api.vectorSettings(name));
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"key" | "off" | null>(null);

  async function turnOff() {
    try {
      await api.disableService(name, "vector");
      await refreshProjects();
      toast.success(`Turned off vector search for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off vector search: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Vector search"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Documents your app searches by meaning, keywords, or both. Stored in this project's database."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New index
          </Button>
        }
      />

      <section aria-labelledby="indexes" className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="indexes" className="text-base font-semibold">
            Indexes
          </h2>
          {indexes.state.status === "ready" && indexes.state.data.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
              <RefreshCw />
              Refresh
            </Button>
          )}
        </div>
        {indexes.state.status === "loading" && <LoadingLines label="Loading indexes" />}
        {indexes.state.status === "error" && <LoadError what="indexes" message={indexes.state.message} onRetry={indexes.refresh} />}
        {indexes.state.status === "ready" && <IndexList project={name} indexes={indexes.state.data} onCreate={() => setCreating(true)} />}
      </section>

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        {settings.state.status === "loading" && <LoadingLines label="Loading settings" />}
        {settings.state.status === "error" && <LoadError what="settings" message={settings.state.message} onRetry={settings.refresh} />}
        {settings.state.status === "ready" && (
          <>
            <EmbeddingRow project={name} settings={settings.state.data} onSaved={() => setVersion((v) => v + 1)} />
            <Row title="API key" hint="Your server sends an API key with vector:write for this project (vector:read is enough to search). Keep it out of browser code.">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground">Pass it as {mono("MYBASE_API_KEY")}. One key can cover several services.</p>
                <Button variant="outline" size="sm" onClick={() => setDialog("key")}>
                  <KeyRound />
                  Create API key
                </Button>
              </div>
            </Row>
            <Row
              title="Index and search"
              hint={
                <>
                  {mono("npm install @mybase-dev/sdk")}. {mono("retrievalTool")} turns an index into a tool for an LLM agent.
                </>
              }
            >
              {code(sdkSnippet(settings.state.data.apiUrl, name, indexes.state.status === "ready" ? (indexes.state.data[0]?.name ?? "docs") : "docs"))}
            </Row>
            <Row title="Indexes in code" hint="Code indexes show a Code tag and can only be changed by syncing.">
              {code(CONFIG_SNIPPET.replace("<project>", name))}
            </Row>
            <Row title="From SQL" hint="The project's role can read every index, so you can join documents with your own tables.">
              {code(`select id, title, metadata from mybase_vector.<index> where metadata->>'lang' = 'en';`)}
            </Row>
          </>
        )}
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off vector search
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every index and document. API keys stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off vector search
          </Button>
        </div>
      </section>

      {creating && (
        <IndexDialog project={name} settings={settings.state.status === "ready" ? settings.state.data : null} open onOpenChange={(open) => !open && setCreating(false)} />
      )}
      <KeyDialog
        open={dialog === "key"}
        onOpenChange={(open) => !open && setDialog(null)}
        preset={{ name: `${name} vector search`, permissions: ["vector:write"], projects: [name] }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off vector search for ${name}`}
        description={SERVICE_PAGES.vector.turnOff}
        confirm="Turn off vector search"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

// ---- one index --------------------------------------------------------------

function QueryPanel({ project, index }: { project: string; index: VectorIndex }) {
  const modes: VectorQueryMode[] = index.dimensions ? (index.embed ? ["hybrid", "vector", "text"] : ["text", "vector", "hybrid"]) : ["text"];
  const [mode, setMode] = useState<VectorQueryMode>(modes[0]!);
  const [result, setResult] = useState<{ data: VectorQueryResponse; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Vectors are typed in only when the index can't embed the text itself.
  const needsVector = mode !== "text" && !index.embed;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = String(form.get("text") ?? "").trim();
    const rawVector = String(form.get("vector") ?? "").trim();
    const rawFilter = String(form.get("filter") ?? "").trim();
    let vector: number[] | undefined;
    let filter: Record<string, unknown> | undefined;
    try {
      vector = rawVector ? (JSON.parse(rawVector) as number[]) : undefined;
      filter = rawFilter ? (JSON.parse(rawFilter) as Record<string, unknown>) : undefined;
    } catch {
      return setError("The vector and the filter are JSON, e.g. [0.1, 0.2] and {\"lang\": \"en\"}.");
    }
    setPending(true);
    setError(null);
    const start = performance.now();
    try {
      const data = await api.queryVector(project, index.name, { text: text || undefined, vector, mode, filter, topK: Number(form.get("topK")), highlight: true });
      setResult({ data, ms: Math.round(performance.now() - start) });
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="try-query" className="mb-10">
      <h2 id="try-query" className="mb-3 text-base font-semibold">
        Try a search
      </h2>
      <form onSubmit={onSubmit} className="mb-4 grid gap-3">
        {modes.length > 1 && (
          <div role="group" aria-label="Search mode" className="inline-flex w-fit rounded-md border p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={m === mode}
                onClick={() => setMode(m)}
                className={cn(
                  "h-8 rounded-[5px] px-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  m === mode && "bg-accent font-medium text-foreground",
                )}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          {mode !== "vector" || index.embed ? (
            <div className="grid min-w-64 flex-1 gap-1.5">
              <Label htmlFor="query-text">Query</Label>
              <Input id="query-text" name="text" placeholder="reset my password" maxLength={2000} autoComplete="off" required={mode !== "vector"} />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="query-top">Results</Label>
            <Input id="query-top" name="topK" type="number" min={1} max={100} defaultValue={10} className="w-20" />
          </div>
          <Button type="submit" disabled={pending}>
            <Search />
            {pending ? "Searching…" : "Search"}
          </Button>
        </div>
        {needsVector && (
          <div className="grid gap-1.5">
            <Label htmlFor="query-vector">Vector</Label>
            <Textarea id="query-vector" name="vector" required rows={2} spellCheck={false} placeholder={`[${index.dimensions} numbers]`} className="font-mono text-xs md:text-xs" />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="query-filter">Metadata filter</Label>
          <Input id="query-filter" name="filter" placeholder='{"lang": "en"}' spellCheck={false} autoComplete="off" className="font-mono text-xs md:text-xs" />
        </div>
      </form>
      {error && (
        <div role="alert" className="rounded-lg border border-dashed p-4">
          <p className="font-medium text-destructive">{error}</p>
        </div>
      )}
      {result && (
        <>
          <p className="mb-2 text-muted-foreground">
            {plural(result.data.matches.length, "match", "matches")} · {MODE_LABELS[result.data.mode].toLowerCase()} · {result.ms} ms
          </p>
          {result.data.matches.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-muted-foreground">Nothing matched. Try other words, or remove the filter.</p>
          ) : (
            <ol className="border-b">
              {result.data.matches.map((m) => (
                <li key={m.id} className="grid gap-1 border-t py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="font-mono text-xs">{m.id}</span>
                      {m.title && <span className="ml-2">{m.title}</span>}
                    </p>
                    {/* ts_headline wraps matched words in <b>; render them as marks, never as HTML. */}
                    {m.highlight ? <Highlight text={m.highlight} /> : m.text && <p className="mt-1 line-clamp-2 max-w-prose text-muted-foreground">{m.text}</p>}
                    {Object.keys(m.metadata).length > 0 && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{JSON.stringify(m.metadata)}</p>}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground" title="Higher is better">
                    {m.score.toFixed(4)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function Highlight({ text }: { text: string }) {
  const parts = text.split(/<b>(.*?)<\/b>/g);
  return (
    <p className="mt-1 max-w-prose text-muted-foreground">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-accent px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function AddDocumentDialog({ project, index, open, onOpenChange, onSaved }: { project: string; index: VectorIndex; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const takesVector = index.dimensions !== null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (field: string) => String(form.get(field) ?? "").trim();
    let metadata: Record<string, unknown> | undefined;
    let vector: number[] | undefined;
    try {
      metadata = text("metadata") ? (JSON.parse(text("metadata")) as Record<string, unknown>) : undefined;
      vector = text("vector") ? (JSON.parse(text("vector")) as number[]) : undefined;
    } catch {
      return setError("Metadata and vector are JSON, e.g. {\"lang\": \"en\"} and [0.1, 0.2].");
    }
    setPending(true);
    setError(null);
    try {
      const res = await api.upsertVectorDocuments(project, index.name, [{ id: text("id"), title: text("title") || null, text: text("text"), metadata, vector }]);
      toast.success(res.embedded ? "Saved and embedded the document" : "Saved the document");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Add a document to {index.name}</DialogTitle>
            <DialogDescription>A document with the same id is replaced.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="doc-id">Id</Label>
            <Input id="doc-id" name="id" required autoFocus maxLength={256} autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-title">Title</Label>
            <Input id="doc-title" name="title" maxLength={1000} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-text">Text</Label>
            <Textarea id="doc-text" name="text" rows={5} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-metadata">Metadata</Label>
            <Input id="doc-metadata" name="metadata" placeholder='{"lang": "en"}' spellCheck={false} autoComplete="off" className="font-mono text-xs md:text-xs" />
          </div>
          {takesVector && (
            <div className="grid gap-2">
              <Label htmlFor="doc-vector">Vector</Label>
              <Textarea
                id="doc-vector"
                name="vector"
                rows={2}
                spellCheck={false}
                required={!index.embed}
                placeholder={index.embed ? "Leave empty to embed the title and text" : `[${index.dimensions} numbers]`}
                className="font-mono text-xs md:text-xs"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Documents({ project, index, version, onChanged }: { project: string; index: VectorIndex; version: number; onChanged: () => void }) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const after = pages.at(-1);
  const docs = useLoad(`vector-docs:${project}:${index.name}:${version}:${after ?? ""}`, () => api.vectorDocuments(project, index.name, after));
  const [removing, setRemoving] = useState<StoredDocument | null>(null);

  async function remove() {
    if (!removing) return;
    try {
      await api.deleteVectorDocument(project, index.name, removing.id);
      toast.success(`Deleted ${removing.id}`);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't delete the document: ${errorMessage(err)}`);
    }
  }

  return (
    <section aria-labelledby="documents" className="mb-10">
      <h2 id="documents" className="mb-3 text-base font-semibold">
        Documents
      </h2>
      {docs.state.status === "loading" && <LoadingLines label="Loading documents" />}
      {docs.state.status === "error" && <LoadError what="documents" message={docs.state.message} onRetry={docs.refresh} />}
      {docs.state.status === "ready" &&
        (docs.state.data.documents.length === 0 && pages.length === 1 ? (
          <p className="max-w-prose rounded-lg border border-dashed p-4 text-muted-foreground">
            No documents yet. Add them from your app with {mono("upsert()")}, with {mono(`mybase vector upsert ${project} ${index.name} docs.jsonl`)}, or one at a time here.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Id</TableHead>
                  <TableHead>Title / text</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.state.data.documents.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-48 truncate font-mono text-xs">{d.id}</TableCell>
                    <TableCell className="max-w-md">
                      <p className="truncate">{d.title ?? <span className="text-muted-foreground">{d.text.slice(0, 200) || "(empty)"}</span>}</p>
                      {Object.keys(d.metadata).length > 0 && <p className="truncate font-mono text-xs text-muted-foreground">{JSON.stringify(d.metadata)}</p>}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={formatDate(d.updatedAt)}>
                      {timeAgo(d.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" aria-label={`Delete ${d.id}`} onClick={() => setRemoving(d)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-3 flex gap-2">
              {pages.length > 1 && (
                <Button variant="outline" size="sm" onClick={() => setPages((p) => p.slice(0, -1))}>
                  Previous
                </Button>
              )}
              {docs.state.data.next && (
                <Button variant="outline" size="sm" onClick={() => setPages((p) => [...p, (docs.state as { data: { next: string } }).data.next])}>
                  Next
                </Button>
              )}
            </div>
          </>
        ))}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.id ?? ""}`}
        description="Removes the document from the index. Your app can upsert it again."
        confirm="Delete document"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </section>
  );
}

function IndexDetail({ project, name }: { project: string; name: string }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const index = useLoad(`vector-index:${project}:${name}:${version}`, () => api.vectorIndex(project, name));
  const [dialog, setDialog] = useState<"add" | "delete" | null>(null);
  const breadcrumb = { label: "Vector search", href: href({ page: "vector", name: project, index: null }) };

  if (index.state.status !== "ready") {
    return (
      <>
        <PageHeader title={name} breadcrumb={breadcrumb} />
        {index.state.status === "loading" ? <LoadingLines label="Loading index" /> : <LoadError what="the index" message={index.state.message} onRetry={index.refresh} />}
      </>
    );
  }
  const i = index.state.data;
  const editable = i.source !== "code";

  async function toggleEmbed(embed: boolean) {
    try {
      await api.updateVectorIndex(project, name, embed);
      toast.success(embed ? `${name} now embeds text` : `${name} no longer embeds text`);
      bump();
    } catch (err) {
      toast.error(`Couldn't change it: ${errorMessage(err)}`);
    }
  }
  async function remove() {
    try {
      await api.deleteVectorIndex(project, name);
      toast.success(`Deleted ${name}`);
      navigate({ page: "vector", name: project, index: null });
    } catch (err) {
      toast.error(`Couldn't delete the index: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title={name}
        breadcrumb={breadcrumb}
        description={`${describeVectors(i)} · ${i.language} keywords · ${plural(i.documents, "document", "documents")}`}
        action={
          <Button onClick={() => setDialog("add")}>
            <Upload />
            Add document
          </Button>
        }
      />
      <QueryPanel key={version} project={project} index={i} />
      <Documents project={project} index={i} version={version} onChanged={bump} />

      <section aria-labelledby="index-settings" className="mb-10">
        <h2 id="index-settings" className="mb-3 text-base font-semibold">
          Settings
        </h2>
        {i.dimensions !== null && (
          <Row title="Embed text" hint="Documents and queries without a vector are embedded with the project's embedding model.">
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground">{i.embed ? "On" : "Off: your app sends vectors"}</p>
              <Switch checked={i.embed} onCheckedChange={toggleEmbed} disabled={!editable} aria-label="Embed text" />
            </div>
          </Row>
        )}
        <Row title="Table" hint="Read it from SQL as the project's role, or join it with your own tables.">
          <code className="font-mono text-xs">mybase_vector.{name}</code>
        </Row>
        <Row title="Created" hint={editable ? "Defined here." : "Defined in mybase.config.ts; change it there and run mybase vector sync."}>
          <span title={formatDate(i.createdAt)}>{timeAgo(i.createdAt)}</span>
        </Row>
      </section>

      {editable && (
        <section aria-labelledby="danger">
          <h2 id="danger" className="mb-3 text-base font-semibold">
            Delete index
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
            <p className="max-w-prose text-muted-foreground">Deletes the index and its {plural(i.documents, "document", "documents")}.</p>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
              Delete index
            </Button>
          </div>
        </section>
      )}

      {dialog === "add" && <AddDocumentDialog project={project} index={i} open onOpenChange={(open) => !open && setDialog(null)} onSaved={bump} />}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${name}`}
        description={`Deletes the index and every document in it. Apps querying it get 404s.`}
        confirm="Delete index"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </>
  );
}

export function VectorPage({ name, index }: { name: string; index: string | null }) {
  return (
    <ProjectGate name={name} title="Vector search" backToProject>
      {(project) => {
        if (!project.services.includes("vector")) {
          return (
            <ServiceOff project={project} id="vector">
              Turn it on to search your app's documents by meaning, by keywords, or both at once: help centers, product catalogs, memory for an AI agent. Built on
              pgvector and Postgres full-text search, in this project's own database.
            </ServiceOff>
          );
        }
        return index ? <IndexDetail key={index} project={name} name={index} /> : <Indexes project={project} />;
      }}
    </ProjectGate>
  );
}

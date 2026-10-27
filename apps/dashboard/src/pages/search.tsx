import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, FileText, KeyRound, Search } from "lucide-react";
import { toast } from "sonner";
import type { FetchResponse, Project, SearchCategory, SearchResponse, SearchTimeRange } from "@mybase/shared";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const CATEGORIES: { value: SearchCategory; label: string }[] = [
  { value: "general", label: "Web" },
  { value: "news", label: "News" },
  { value: "it", label: "Code (GitHub, Stack Overflow)" },
];

const TIME_RANGES: { value: SearchTimeRange | ""; label: string }[] = [
  { value: "", label: "Any time" },
  { value: "day", label: "Past day" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "year", label: "Past year" },
];

const selectClass = "h-9 rounded-md border bg-transparent px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const sdkSnippet = (apiUrl: string, project: string) => `import { createSearchClient, searchTools } from "@mybase-dev/sdk/search";

const web = createSearchClient({
  apiUrl: "${apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

const { results } = await web.search("bun sql postgres");
const page = await web.fetch(results[0].url); // { title, markdown, … }

// For an LLM agent: web_search + web_fetch tool definitions
const tools = searchTools(web);`;

/** A request the page made: what came back, or the API's error, and how long it took. */
type Attempt<T> = { status: "idle" } | { status: "loading" } | { status: "done"; data: T; ms: number } | { status: "error"; message: string; ms: number };

async function timed<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  const start = performance.now();
  try {
    const data = await run();
    return { status: "done", data, ms: Math.round(performance.now() - start) };
  } catch (err) {
    return { status: "error", message: errorMessage(err), ms: Math.round(performance.now() - start) };
  }
}

const Tag = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground" title={title}>
    {children}
  </span>
);

/** One line about the response: what the agent can rely on (count, cache, time). */
function Meta({ items }: { items: (string | false | null | undefined)[] }) {
  return <p className="text-muted-foreground">{items.filter(Boolean).join(" · ")}</p>;
}

/** Results or the exact JSON the API returned, which is what an app receives. */
function ViewToggle({ json, onChange }: { json: boolean; onChange: (json: boolean) => void }) {
  return (
    <div className="flex rounded-md border p-0.5" role="group" aria-label="View">
      {(["Formatted", "JSON"] as const).map((label) => {
        const pressed = (label === "JSON") === json;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(label === "JSON")}
            className={cn("rounded-sm px-2.5 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", pressed ? "bg-accent font-medium" : "text-muted-foreground")}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const ErrorPanel = ({ message, ms }: { message: string; ms: number }) => (
  <div role="alert" className="rounded-lg border border-dashed p-4">
    <p className="font-medium text-destructive">{message}</p>
    <p className="mt-1 text-muted-foreground">Failed after {ms} ms. Apps get the same error message.</p>
  </div>
);

function SearchPanel({ project, onRead }: { project: string; onRead: (url: string) => void }) {
  const [attempt, setAttempt] = useState<Attempt<SearchResponse>>({ status: "idle" });
  const [json, setJson] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const q = String(form.get("q") ?? "").trim();
    if (!q) return;
    setAttempt({ status: "loading" });
    setAttempt(
      await timed(() =>
        api.webSearch(project, {
          q,
          category: String(form.get("category")),
          timeRange: String(form.get("timeRange")) || undefined,
          limit: Number(form.get("limit")),
        }),
      ),
    );
  }

  return (
    <section aria-labelledby="try-search" className="mb-10">
      <h2 id="try-search" className="mb-3 text-base font-semibold">
        Search
      </h2>
      <form onSubmit={onSubmit} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label htmlFor="search-q">Query</Label>
          <Input id="search-q" name="q" placeholder="bun sql postgres" maxLength={400} autoComplete="off" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="search-category">Category</Label>
          <select id="search-category" name="category" className={selectClass}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="search-time">Time</Label>
          <select id="search-time" name="timeRange" className={selectClass}>
            {TIME_RANGES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="search-limit">Results</Label>
          <Input id="search-limit" name="limit" type="number" min={1} max={20} defaultValue={10} className="w-20" />
        </div>
        <Button type="submit" disabled={attempt.status === "loading"}>
          <Search />
          {attempt.status === "loading" ? "Searching…" : "Search"}
        </Button>
      </form>

      {attempt.status === "loading" && <p className="text-muted-foreground">Asking the search engines. This takes a few seconds.</p>}
      {attempt.status === "error" && <ErrorPanel message={attempt.message} ms={attempt.ms} />}
      {attempt.status === "done" && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <Meta
              items={[
                `${attempt.data.results.length} ${attempt.data.results.length === 1 ? "result" : "results"}`,
                attempt.data.cached ? "from cache" : "live",
                `${attempt.ms} ms`,
              ]}
            />
            <ViewToggle json={json} onChange={setJson} />
          </div>
          {json ? (
            <pre className="max-h-[32rem] overflow-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{JSON.stringify(attempt.data, null, 2)}</pre>
          ) : attempt.data.results.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-muted-foreground">No results. Try other words, or another category.</p>
          ) : (
            <ol className="border-b">
              {attempt.data.results.map((r) => (
                <li key={r.url} className="grid gap-1 border-t py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <div className="min-w-0">
                    <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
                      {r.title}
                      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                    <p className="truncate font-mono text-xs text-muted-foreground">{r.url}</p>
                    {r.snippet && <p className="mt-1 max-w-prose">{r.snippet}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.engines.map((e) => (
                        <Tag key={e}>{e}</Tag>
                      ))}
                      {r.publishedAt && <Tag title={formatDate(r.publishedAt)}>{r.publishedAt.slice(0, 10)}</Tag>}
                    </div>
                  </div>
                  <div>
                    <Button variant="outline" size="sm" onClick={() => onRead(r.url)}>
                      <FileText />
                      Read
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function ReadPanel({ project, request }: { project: string; request: { url: string; n: number } | null }) {
  const [attempt, setAttempt] = useState<Attempt<FetchResponse>>({ status: "idle" });
  const [json, setJson] = useState(false);
  const [url, setUrl] = useState("");
  const [maxChars, setMaxChars] = useState(20_000);

  async function read(target: string) {
    setAttempt({ status: "loading" });
    setAttempt(await timed(() => api.webFetch(project, target, maxChars)));
  }

  // A result's Read button hands over its URL (`n` changes on every click, even for the same URL).
  useEffect(() => {
    if (!request) return;
    setUrl(request.url);
    void read(request.url);
  }, [request]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (url.trim()) void read(url.trim());
  }

  return (
    <section id="read-page" aria-labelledby="try-read" className="mb-10 scroll-mt-6">
      <h2 id="try-read" className="mb-3 text-base font-semibold">
        Read a page
      </h2>
      <form onSubmit={onSubmit} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label htmlFor="read-url">URL</Label>
          <Input
            id="read-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://bun.com/docs/runtime/sql"
            className="font-mono text-xs md:text-xs"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="read-max">Max characters</Label>
          <Input id="read-max" type="number" min={500} max={100_000} step={500} value={maxChars} onChange={(e) => setMaxChars(Number(e.target.value))} className="w-28" />
        </div>
        <Button type="submit" variant="outline" disabled={attempt.status === "loading"}>
          <FileText />
          {attempt.status === "loading" ? "Reading…" : "Read page"}
        </Button>
      </form>

      {attempt.status === "loading" && <p className="text-muted-foreground">Fetching the page and pulling out its main content.</p>}
      {attempt.status === "error" && <ErrorPanel message={attempt.message} ms={attempt.ms} />}
      {attempt.status === "done" && (
        <>
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{attempt.data.title ?? "Untitled"}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{attempt.data.url}</p>
              <Meta
                items={[
                  attempt.data.contentType,
                  `${attempt.data.markdown.length.toLocaleString()} characters`,
                  attempt.data.truncated && `cut at ${maxChars.toLocaleString()}`,
                  attempt.data.cached ? "from cache" : "live",
                  `${attempt.ms} ms`,
                ]}
              />
            </div>
            <ViewToggle json={json} onChange={setJson} />
          </div>
          <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-accent/40 p-3 font-mono text-xs">
            {json ? JSON.stringify(attempt.data, null, 2) : attempt.data.markdown || "(no text content)"}
          </pre>
        </>
      )}
    </section>
  );
}

function WebSearch({ project }: { project: Project }) {
  const name = project.name;
  const apiUrl = window.location.origin;
  const [readRequest, setReadRequest] = useState<{ url: string; n: number } | null>(null);
  const [dialog, setDialog] = useState<"key" | "off" | null>(null);

  function readResult(url: string) {
    setReadRequest((prev) => ({ url, n: (prev?.n ?? 0) + 1 }));
    document.getElementById("read-page")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function turnOff() {
    try {
      await api.disableService(name, "search");
      await refreshProjects();
      toast.success(`Turned off web search for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off web search: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Web search"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Search the web and read pages as markdown, the way your app's agent does. Requests here count toward the project's limits and share its cache."
      />
      <SearchPanel project={name} onRead={readResult} />
      <ReadPanel project={name} request={readRequest} />

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        <Row title="API key" hint="Your server sends an API key with search:read for this project. Keep it out of browser code.">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground">
              Pass it as <code className="font-mono text-[0.85em] text-foreground">MYBASE_API_KEY</code>. One key can cover several services.
            </p>
            <Button variant="outline" size="sm" onClick={() => setDialog("key")}>
              <KeyRound />
              Create API key
            </Button>
          </div>
        </Row>
        <Row
          title="Search from code"
          hint={
            <>
              <code className="font-mono text-[0.85em] text-foreground">npm install @mybase-dev/sdk</code>. <code className="font-mono text-[0.85em] text-foreground">searchTools</code>{" "}
              works with any LLM tool-use loop.
            </>
          }
        >
          {code(sdkSnippet(apiUrl, name))}
        </Row>
        <Row title="Endpoints" hint="For other languages: GET with an API key as a Bearer token.">
          <div className="grid gap-2">
            <CopyField id="search-url" label="Search" value={`${apiUrl}/search/${name}?q=`} />
            <CopyField id="fetch-url" label="Read" value={`${apiUrl}/search/${name}/fetch?url=`} />
          </div>
        </Row>
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off web search
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Clears this project's cached searches and pages. API keys stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off web search
          </Button>
        </div>
      </section>

      <KeyDialog
        open={dialog === "key"}
        onOpenChange={(open) => !open && setDialog(null)}
        preset={{ name: `${name} web search`, permissions: ["search:read"], projects: [name] }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off web search for ${name}`}
        description={SERVICE_PAGES.search.turnOff}
        confirm="Turn off web search"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function SearchPage({ name }: { name: string }) {
  return (
    <ProjectGate name={name} title="Web search" backToProject>
      {(project) => {
        if (!project.services.includes("search")) {
          return (
            <ServiceOff project={project} id="search">
              Turn it on to let your app's AI agent search the web and read pages as markdown, through this server's own SearXNG. No search API to pay for;
              searches go out from this machine's IP.
            </ServiceOff>
          );
        }
        return <WebSearch project={project} />;
      }}
    </ProjectGate>
  );
}

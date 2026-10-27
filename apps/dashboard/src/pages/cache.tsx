import { useEffect, useState, type FormEvent } from "react";
import { Plus, RotateCw, Search } from "lucide-react";
import { toast } from "sonner";
import type { CacheKeySummary, Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { cacheCredentials, CredentialsDialog, type Credentials } from "@/components/service-credentials";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { CacheKeyView, TypeTag } from "@/pages/cache/key";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const tcpSnippet = (url: string, prefix: string) => `import Redis from "ioredis";

// Password: shown once when the cache was turned on (or rotate it below).
const redis = new Redis("${url.replace("@", ":<password>@")}", {
  keyPrefix: "${prefix}", // every key must start with it
});
await redis.set("session:abc", userId, "EX", 3600);`;

const httpSnippet = (apiUrl: string, project: string) => `import { createCache } from "@mybase/sdk/cache";

const cache = createCache({
  apiUrl: "${apiUrl}",
  project: "${project}",
  password: process.env.MYBASE_CACHE_PASSWORD!,
});
await cache.set("session:abc", userId, { ex: 3600 }); // key: ${project}:session:abc`;

/** "/cache/shop" off the end of the HTTP URL: what the SDK calls `apiUrl`. */
const apiUrlOf = (httpUrl: string) => httpUrl.replace(/\/cache\/[^/]+$/, "");

function NewKeyDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const prefix = `${project}:`;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("key") ?? "").trim();
    const ttl = String(form.get("ttl") ?? "").trim();
    if (!name) return setError("Give the key a name.");
    const seconds = ttl ? Number(ttl) : null;
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1)) return setError("Expiry is a whole number of seconds, or empty for none.");
    const key = name.startsWith(prefix) ? name : prefix + name;
    setPending(true);
    setError(null);
    try {
      await api.putCacheKey(project, key, { type: "string", value: String(form.get("value") ?? ""), ttlMs: seconds === null ? null : seconds * 1000 });
      toast.success(`Created ${key}`);
      close(false);
      navigate({ page: "cache", name: project, key, query: "" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>New key</DialogTitle>
            <DialogDescription>A string value. Apps can store hashes, lists, sets, and more; edit those from the key's page.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="cache-key">Key</Label>
            <div className="flex items-center rounded-md border focus-within:ring-[3px] focus-within:ring-ring/50">
              <span className="pl-3 font-mono text-xs text-muted-foreground">{prefix}</span>
              <Input id="cache-key" name="key" required autoFocus autoComplete="off" spellCheck={false} className="border-0 pl-0.5 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cache-value">Value</Label>
            <Textarea id="cache-value" name="value" rows={4} className="font-mono text-xs md:text-xs" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cache-ttl">Expires after (seconds)</Label>
            <Input id="cache-ttl" name="ttl" inputMode="numeric" placeholder="Never" className="max-w-40" />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The key browser: a SCAN over the project's prefix, filtered by a glob kept in the URL. */
function Keys({ project, query, onCreate }: { project: string; query: string; onCreate: () => void }) {
  const [search, setSearch] = useState(query);
  const match = query ? (/[*?[]/.test(query) ? query : `*${query}*`) : undefined;
  const first = useLoad(`cache-keys:${project}:${query}`, () => api.cacheKeys(project, { match }));
  // Pages after the first, from "Load more".
  const [more, setMore] = useState<{ keys: CacheKeySummary[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setMore(null), [first.state]);
  useEffect(() => setSearch(query), [query]);

  // Debounced, replacing history so typing doesn't stack up Back presses.
  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => navigate({ page: "cache", name: project, key: null, query: search.trim() }, { replace: true }), 250);
    return () => clearTimeout(t);
  }, [search, query, project]);

  const searchBox = (
    <div className="relative mb-3 max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Filter keys"
        placeholder="Filter keys (glob, e.g. session:*)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="pl-9"
      />
    </div>
  );

  if (first.state.status === "loading") {
    return (
      <>
        {searchBox}
        <LoadingLines label="Loading keys" />
      </>
    );
  }
  if (first.state.status === "error") {
    return (
      <>
        {searchBox}
        <LoadError what="keys" message={first.state.message} onRetry={first.refresh} />
      </>
    );
  }

  const keys = [...first.state.data.keys, ...(more?.keys ?? [])];
  const cursor = more ? more.cursor : first.state.data.cursor;

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.cacheKeys(project, { cursor, match });
      setMore((m) => ({ keys: [...(m?.keys ?? []), ...page.keys], cursor: page.cursor }));
    } catch (err) {
      toast.error(`Couldn't load more keys: ${errorMessage(err)}`);
    } finally {
      setLoadingMore(false);
    }
  }

  if (keys.length === 0) {
    return (
      <>
        {searchBox}
        <div className="max-w-prose rounded-lg border border-dashed p-5">
          {query ? (
            <>
              <p className="font-medium">No keys match {query}</p>
              <p className="mt-1 text-muted-foreground">Search uses Valkey globs: * for anything, ? for one character.</p>
            </>
          ) : (
            <>
              <p className="font-medium">The cache is empty</p>
              <p className="mt-1 text-muted-foreground">Keys your apps write show up here. Connect an app below, or create a key to try it out.</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={onCreate}>
                <Plus />
                New key
              </Button>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {searchBox}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Expires in</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => (
            <TableRow key={k.key}>
              <TableCell className="max-w-md">
                <a
                  href={href({ page: "cache", name: project, key: k.key, query: "" })}
                  className="block truncate font-mono text-xs outline-none hover:underline focus-visible:underline"
                  title={k.key}
                >
                  <span className="text-muted-foreground">{project}:</span>
                  {k.key.slice(project.length + 1)}
                </a>
              </TableCell>
              <TableCell>
                <TypeTag type={k.type} />
              </TableCell>
              <TableCell className="text-muted-foreground">{k.ttlMs === null ? "Never" : formatDuration(k.ttlMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {cursor && (
        <Button variant="outline" size="sm" className="mt-3" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </>
  );
}

function Cache({ project, query }: { project: Project; query: string }) {
  const name = project.name;
  const { state, refresh } = useLoad(`cache:${name}`, () => api.cacheOverview(name));
  const [createOpen, setCreateOpen] = useState(false);
  const [dialog, setDialog] = useState<"rotate" | "off" | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  async function rotate() {
    try {
      setCredentials(cacheCredentials(await api.rotateCachePassword(name)));
      await refresh();
    } catch (err) {
      toast.error(`Couldn't rotate the password: ${errorMessage(err)}`);
    }
  }
  async function turnOff() {
    try {
      await api.disableService(name, "cache");
      await refreshProjects();
      toast.success(`Turned off the cache for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off the cache: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Cache"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="A Redis-compatible key-value store, in memory. For sessions, cached queries, counters, and locks."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            New key
          </Button>
        }
      />

      <section aria-labelledby="keys" className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="keys" className="text-base font-semibold">
            Keys
            {state.status === "ready" && <span className="ml-2 font-normal text-muted-foreground">{state.data.keys.toLocaleString()}</span>}
          </h2>
        </div>
        <Keys project={name} query={query} onCreate={() => setCreateOpen(true)} />
      </section>

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        {state.status === "loading" && <LoadingLines label="Loading connection details" />}
        {state.status === "error" && <LoadError what="the cache" message={state.message} onRetry={refresh} />}
        {state.status === "ready" && (
          <>
            <Row title="Password" hint="Only shown when it's made. It's the TCP password and the HTTP Bearer token. Keep it server-side.">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground">Lost it? Rotate it for a new one. Apps using the old one are disconnected.</p>
                <Button variant="outline" size="sm" onClick={() => setDialog("rotate")}>
                  <RotateCw />
                  Rotate password
                </Button>
              </div>
            </Row>
            <Row title="Over TCP" hint="Fastest. From the LAN or Tailscale, with any Redis client. Set the key prefix so every key gets it.">
              <div className="grid gap-3">
                <CopyField id="cache-url" label="Connection string" value={state.data.info.url} />
                <CopyField id="cache-prefix" label="Key prefix" value={state.data.info.keyPrefix} />
                {code(tcpSnippet(state.data.info.url, state.data.info.keyPrefix))}
              </div>
            </Row>
            <Row
              title="Over HTTP"
              hint={
                <>
                  From anywhere, serverless hosts included. Uses <code className="font-mono text-[0.85em] text-foreground">@mybase/sdk/cache</code>, which adds the
                  prefix; <code className="font-mono text-[0.85em] text-foreground">@upstash/redis</code> works too.
                </>
              }
            >
              <div className="grid gap-3">
                <CopyField id="cache-http" label="HTTP URL" value={state.data.info.httpUrl} />
                {code(httpSnippet(apiUrlOf(state.data.info.httpUrl), name))}
              </div>
            </Row>
            <Row title="Memory" hint="Shared by every project. When it's full, the least recently used keys are evicted first.">
              <p>
                {formatBytes(state.data.memory.usedBytes)} used
                {state.data.memory.maxBytes > 0 && <span className="text-muted-foreground"> of {formatBytes(state.data.memory.maxBytes)}</span>}
              </p>
            </Row>
          </>
        )}
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off the cache
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every key and the password. Turning it back on makes a new password.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off cache
          </Button>
        </div>
      </section>

      <NewKeyDialog project={name} open={createOpen} onOpenChange={setCreateOpen} />
      <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
      <ConfirmDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rotate cache password"
        description="The current password stops working right away, and apps connected with it are disconnected until you deploy the new one."
        confirm="Rotate"
        pendingLabel="Rotating…"
        onConfirm={rotate}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off the cache for ${name}`}
        description={SERVICE_PAGES.cache.turnOff}
        confirm="Turn off cache"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function CachePage({ name, cacheKey, query }: { name: string; cacheKey: string | null; query: string }) {
  return (
    <ProjectGate name={name} title="Cache" backToProject>
      {(project) => {
        if (!project.services.includes("cache")) {
          return (
            <ServiceOff project={project} id="cache">
              Turn it on for a Redis-compatible key-value store your apps reach over TCP or HTTP: sessions, cached queries, counters, and locks. Data lives in memory
              and is snapshotted to disk every 15 minutes.
            </ServiceOff>
          );
        }
        return cacheKey ? <CacheKeyView key={cacheKey} project={project} cacheKey={cacheKey} /> : <Cache project={project} query={query} />;
      }}
    </ProjectGate>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, RotateCcw, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { HOSTING_SITE_RULES, type HostingDeploy, type HostingDeployStatus, type HostingOverview, type HostingSite, type Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
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
import { api, hostingLogsUrl } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;
const selectClass = "h-9 rounded-md border bg-transparent px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const pending = (s: HostingDeployStatus | undefined) => s === "queued" || s === "starting";
const siteUrl = (s: HostingSite) => s.url ?? `http://${s.name}.localhost`;

const STATUS_STYLE: Record<HostingDeployStatus, string> = {
  queued: "text-muted-foreground",
  starting: "text-muted-foreground",
  live: "text-foreground font-medium",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

function Status({ status }: { status: HostingDeployStatus | null }) {
  if (!status) return <span className="text-muted-foreground">Never deployed</span>;
  return <span className={STATUS_STYLE[status]}>{status === "starting" ? "Starting…" : status[0]!.toUpperCase() + status.slice(1)}</span>;
}

/** Re-runs `refresh` every 2 s while `active`, for deploys in progress. */
function usePoll(active: boolean, refresh: () => void) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [active, refresh]);
}

function CreateSiteDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const site = await api.createSite(project, {
        name: String(form.get("name") ?? "").trim(),
        port: Number(form.get("port") || 3000),
        healthPath: String(form.get("healthPath") || "/"),
      });
      toast.success(`Created ${site.name}`);
      onOpenChange(false);
      navigate({ page: "hosting", name: project, site: site.name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>New site</DialogTitle>
            <DialogDescription>It goes live at &lt;name&gt;.&lt;your domain&gt; after its first deploy.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="site-name">Name</Label>
            <Input id="site-name" name="name" required autoFocus autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
            <p className="text-muted-foreground">{HOSTING_SITE_RULES}. Unique across projects.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="site-port">Port</Label>
              <Input id="site-port" name="port" type="number" min={1} max={65535} defaultValue={3000} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="site-health">Health path</Label>
              <Input id="site-health" name="healthPath" defaultValue="/" className="font-mono text-xs md:text-xs" />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create site"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sites({ project }: { project: Project }) {
  const name = project.name;
  const { state, refresh } = useLoad(`hosting:${name}`, () => api.hosting(name));
  const [create, setCreate] = useState(false);
  const [off, setOff] = useState(false);
  usePoll(state.status === "ready" && state.data.sites.some((s) => pending(s.latest?.status)), refresh);

  async function turnOff() {
    try {
      await api.disableService(name, "hosting");
      await refreshProjects();
      toast.success(`Turned off hosting for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off hosting: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Hosting"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Your sites run as containers on this server, each at its own address. Deploys switch over once the new container answers."
        action={
          <Button onClick={() => setCreate(true)}>
            <Plus />
            New site
          </Button>
        }
      />
      {state.status === "loading" && <LoadingLines label="Loading sites" lines={3} />}
      {state.status === "error" && <LoadError what="sites" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" && (
        <>
          <section aria-labelledby="sites" className="mb-10">
            <h2 id="sites" className="mb-3 text-base font-semibold">
              Sites
            </h2>
            {state.data.sites.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6">
                <p className="max-w-prose text-muted-foreground">
                  No sites yet. A site is one app (a Next.js app, a static site, an API) that runs as a container here and answers at its own address.
                </p>
                <Button className="mt-4" variant="outline" onClick={() => setCreate(true)}>
                  <Plus />
                  New site
                </Button>
              </div>
            ) : (
              <SiteTable project={name} sites={state.data.sites} />
            )}
          </section>
          <DeployHelp project={name} overview={state.data} />
        </>
      )}
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off hosting
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Every site goes offline, and its deploys and images are deleted.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOff(true)}>
            Turn off hosting
          </Button>
        </div>
      </section>
      <CreateSiteDialog project={name} open={create} onOpenChange={setCreate} />
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off hosting for ${name}`}
        description={SERVICE_PAGES.hosting.turnOff}
        confirm="Turn off hosting"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

function SiteTable({ project, sites }: { project: string; sites: HostingSite[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Site</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last deploy</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sites.map((s) => (
          <TableRow key={s.name}>
            <TableCell>
              <a href={href({ page: "hosting", name: project, site: s.name })} className="font-medium hover:underline">
                {s.name}
              </a>
            </TableCell>
            <TableCell>
              {s.liveDeploy ? (
                <a href={siteUrl(s)} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
                  {siteUrl(s).replace(/^https?:\/\//, "")}
                </a>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{siteUrl(s).replace(/^https?:\/\//, "")}</span>
              )}
            </TableCell>
            <TableCell>
              <Status status={s.latest?.status ?? null} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {s.latest ? (
                <time dateTime={s.latest.createdAt} title={formatDate(s.latest.createdAt)}>
                  {timeAgo(s.latest.createdAt)}
                </time>
              ) : (
                "–"
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeployHelp({ project, overview, site }: { project: string; overview: HostingOverview; site?: string }) {
  const s = site ?? "<site>";
  return (
    <section aria-labelledby="deploy-help" className="mb-10">
      <h2 id="deploy-help" className="mb-3 text-base font-semibold">
        Deploy from your machine
      </h2>
      <Row title="With the CLI" hint={`Builds for ${overview.platform} with Docker on your machine, pushes the image here, and waits until it's live.`}>
        {code(`mybase hosting init --template nextjs --project ${project} --site ${s}\nmybase deploy`)}
      </Row>
      <Row title="Registry" hint="Or push with docker yourself (sign in with an API key that has registry:write), then deploy the digest. Images live in the project's container registry.">
        <div className="grid gap-3">
          <CopyField id="hosting-registry" label="Image" value={`${overview.registry}/${s}`} />
          {code(`docker login ${overview.registry.split("/")[0]} -u mybase   # password: an mb_… API key`)}
        </div>
      </Row>
      {!overview.domain && (
        <Row title="Domain" hint="Set on the server, with mybase server hosting.">
          <p className="text-muted-foreground">
            No domain yet: sites answer at <span className="font-mono text-xs">http://&lt;site&gt;.localhost</span> on this machine only. Run{" "}
            <span className="font-mono text-xs">mybase server hosting</span> to put them on your domain.
          </p>
        </Row>
      )}
    </section>
  );
}

function Logs({ project, site, deploy }: { project: string; site: string; deploy: string | null }) {
  const [follow, setFollow] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!deploy) return;
    const controller = new AbortController();
    setText("");
    setError(null);
    void (async () => {
      try {
        const res = await fetch(hostingLogsUrl(project, site, deploy, follow), { signal: controller.signal });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          // Keep the last 200 KB.
          setText((t) => (t + decoder.decode(chunk, { stream: true })).slice(-200_000));
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(errorMessage(err));
      }
    })();
    return () => controller.abort();
  }, [project, site, deploy, follow]);

  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  return (
    <section aria-labelledby="logs" className="mb-10">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="logs" className="text-base font-semibold">
          Logs
        </h2>
        <label className="flex items-center gap-2 text-muted-foreground">
          <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow logs" />
          Follow
        </label>
      </div>
      {!deploy ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">Nothing is live yet, so there's no output to show.</p>
      ) : error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : (
        <pre ref={box} className="h-80 overflow-auto rounded-md border bg-accent/40 p-3 font-mono text-xs whitespace-pre-wrap" aria-live="off">
          {text || "No output yet."}
        </pre>
      )}
    </section>
  );
}

function Deploys({ project, site, deploys, live, onChange }: { project: string; site: string; deploys: HostingDeploy[]; live: string | null; onChange: () => void }) {
  const [target, setTarget] = useState<HostingDeploy | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const liveDigest = deploys.find((d) => d.id === live)?.digest;
  if (!deploys.length) {
    return <p className="rounded-lg border border-dashed p-6 text-muted-foreground">No deploys yet. Push an image with mybase deploy and it shows up here.</p>;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Deploy</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>By</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {deploys.map((d) => (
            <TableRow key={d.id} className="align-top">
              <TableCell className="font-mono text-xs">{d.id.slice(0, 8)}</TableCell>
              <TableCell>
                <Status status={d.status} />
                {d.rollbackOf && <span className="block text-xs text-muted-foreground">rollback to {d.rollbackOf.slice(0, 8)}</span>}
                {d.error && (
                  <button type="button" className="block text-left text-xs text-destructive underline-offset-2 hover:underline" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? "Hide details" : d.error.split("\n")[0]}
                  </button>
                )}
                {open === d.id && d.error && <pre className="mt-2 max-w-xl overflow-x-auto rounded-md border bg-accent/40 p-2 font-mono text-xs whitespace-pre-wrap">{d.error}</pre>}
                {!d.error && (d.warnings?.length ?? 0) > 0 && (
                  <button type="button" className="block text-left text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen(open === `w:${d.id}` ? null : `w:${d.id}`)}>
                    {open === `w:${d.id}` ? "Hide warnings" : `${d.warnings.length} env warning${d.warnings.length === 1 ? "" : "s"}: ${d.warnings[0]!.split("\n")[0]}`}
                  </button>
                )}
                {open === `w:${d.id}` && <pre className="mt-2 max-w-xl overflow-x-auto rounded-md border bg-accent/40 p-2 font-mono text-xs whitespace-pre-wrap">{d.warnings.join("\n\n")}</pre>}
              </TableCell>
              <TableCell className="font-mono text-xs" title={d.digest}>
                {d.digest.slice(7, 19)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <time dateTime={d.createdAt} title={formatDate(d.createdAt)}>
                  {timeAgo(d.createdAt)}
                </time>
              </TableCell>
              <TableCell className="text-muted-foreground">{d.createdBy}</TableCell>
              <TableCell>
                {d.status === "stopped" && d.digest !== liveDigest && (
                  <Button variant="outline" size="sm" onClick={() => setTarget(d)}>
                    <RotateCcw />
                    Roll back
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Roll back ${site} to ${target?.id.slice(0, 8)}`}
        description="Starts that deploy's image with the current env vars, and switches over once it answers. The live deploy keeps serving until then."
        confirm="Roll back"
        pendingLabel="Rolling back…"
        onConfirm={async () => {
          await api.rollbackSite(project, site, target!.id);
          toast.success(`Rolling back ${site}`);
          onChange();
        }}
      />
    </>
  );
}

/** KEY=VALUE per line. */
const toLines = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

function parseLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`Line ${i + 1} isn't KEY=VALUE.`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}

function Settings({ project, site, secretsOn, onSaved }: { project: string; site: HostingSite; secretsOn: boolean; onSaved: () => void }) {
  const env = useLoad(`hosting-env:${project}:${site.name}`, () => api.siteEnv(project, site.name));
  const envs = useLoad(`secrets-envs:${project}:${secretsOn}`, () => (secretsOn ? api.secrets(project) : Promise.resolve(null)));
  const [envError, setEnvError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  async function saveEnv(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEnvError(null);
    try {
      const parsed = parseLines(String(new FormData(e.currentTarget).get("env") ?? ""));
      await api.putSiteEnv(project, site.name, parsed);
      toast.success(`Saved ${Object.keys(parsed).length} env vars. Redeploy to apply them.`);
      void env.refresh();
    } catch (err) {
      setEnvError(errorMessage(err));
    }
  }

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSettingsError(null);
    const form = new FormData(e.currentTarget);
    try {
      await api.updateSite(project, site.name, {
        port: Number(form.get("port")),
        healthPath: String(form.get("healthPath") ?? "/"),
        secretsEnv: String(form.get("secretsEnv") ?? "") || null,
      });
      toast.success(`Saved ${site.name}`);
      onSaved();
    } catch (err) {
      setSettingsError(errorMessage(err));
    }
  }

  return (
    <section aria-labelledby="site-settings" className="mb-10">
      <h2 id="site-settings" className="mb-3 text-base font-semibold">
        Settings
      </h2>
      <Row title="Env vars" hint="KEY=VALUE, one per line. Applied on the next deploy. PORT and MYBASE_SITE_URL are set for you.">
        {env.state.status === "loading" && <LoadingLines label="Loading env vars" lines={2} />}
        {env.state.status === "error" && <LoadError what="env vars" message={env.state.message} onRetry={() => void env.refresh()} />}
        {env.state.status === "ready" && (
          <form onSubmit={saveEnv} className="grid gap-3">
            <Textarea
              key={toLines(env.state.data.env)}
              name="env"
              rows={Math.min(12, Math.max(4, Object.keys(env.state.data.env).length + 2))}
              defaultValue={toLines(env.state.data.env)}
              spellCheck={false}
              aria-label="Env vars"
              className="font-mono text-xs md:text-xs"
            />
            <div>
              <Button type="submit" variant="outline">
                Save env vars
              </Button>
            </div>
            {envError && (
              <p role="alert" className="text-destructive">
                {envError}
              </p>
            )}
          </form>
        )}
      </Row>
      <form onSubmit={saveSettings}>
        <Row title="Container" hint="The port your app listens on (also its $PORT), and the path checked before a deploy goes live. Any answer below 500 counts.">
          <div className="flex flex-wrap gap-3">
            <div className="grid gap-2">
              <Label htmlFor="site-port-edit">Port</Label>
              <Input id="site-port-edit" key={site.port} name="port" type="number" min={1} max={65535} defaultValue={site.port} className="w-28" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="site-health-edit">Health path</Label>
              <Input id="site-health-edit" key={site.healthPath} name="healthPath" defaultValue={site.healthPath} className="w-48 font-mono text-xs md:text-xs" />
            </div>
          </div>
        </Row>
        <Row title="Secrets" hint={secretsOn ? "Values from this secrets environment are added to the container's env at deploy time." : "Turn on the secrets service to load an environment's values into this site."}>
          <select
            key={site.secretsEnv ?? ""}
            name="secretsEnv"
            defaultValue={site.secretsEnv ?? ""}
            disabled={!secretsOn}
            aria-label="Secrets environment"
            className={cn(selectClass, "w-56")}
          >
            <option value="">None</option>
            {envs.state.status === "ready" && envs.state.data?.envs.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </Row>
        <div className="flex flex-wrap items-center gap-3 border-t py-5">
          <Button type="submit" variant="outline">
            Save settings
          </Button>
          {settingsError && (
            <p role="alert" className="text-destructive">
              {settingsError}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function Site({ project, site: name }: { project: Project; site: string }) {
  const p = project.name;
  const site = useLoad(`hosting-site:${p}:${name}`, () => api.site(p, name));
  const deploys = useLoad(`hosting-deploys:${p}:${name}`, () => api.siteDeploys(p, name));
  const overview = useLoad(`hosting:${p}`, () => api.hosting(p));
  const [dialog, setDialog] = useState<"delete" | "redeploy" | null>(null);
  const refresh = () => {
    void site.refresh();
    void deploys.refresh();
  };
  const busy = deploys.state.status === "ready" && deploys.state.data.some((d) => pending(d.status));
  usePoll(busy, refresh);

  return (
    <>
      <PageHeader
        title={name}
        breadcrumb={{ label: `${p} / Hosting`, href: href({ page: "hosting", name: p, site: null }) }}
        description={
          site.state.status === "ready" ? (
            <a href={siteUrl(site.state.data)} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
              {siteUrl(site.state.data)}
            </a>
          ) : undefined
        }
        action={
          <Button variant="outline" disabled={site.state.status !== "ready" || !site.state.data.liveDeploy || busy} onClick={() => setDialog("redeploy")}>
            <RefreshCw />
            Redeploy
          </Button>
        }
      />
      {site.state.status === "loading" && <LoadingLines label="Loading site" lines={4} />}
      {site.state.status === "error" && <LoadError what="the site" message={site.state.message} onRetry={refresh} />}
      {site.state.status === "ready" && (
        <>
          <section aria-labelledby="deploys" className="mb-10">
            <h2 id="deploys" className="mb-3 text-base font-semibold">
              Deploys
            </h2>
            {deploys.state.status === "loading" && <LoadingLines label="Loading deploys" lines={3} />}
            {deploys.state.status === "error" && <LoadError what="deploys" message={deploys.state.message} onRetry={refresh} />}
            {deploys.state.status === "ready" && <Deploys project={p} site={name} deploys={deploys.state.data} live={site.state.data.liveDeploy} onChange={refresh} />}
          </section>
          <Logs project={p} site={name} deploy={site.state.data.liveDeploy} />
          <Settings project={p} site={site.state.data} secretsOn={project.services.includes("secrets")} onSaved={refresh} />
          {overview.state.status === "ready" && <DeployHelp project={p} overview={overview.state.data} site={name} />}
          <section aria-labelledby="danger">
            <h2 id="danger" className="mb-3 text-base font-semibold">
              Delete site
            </h2>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
              <p className="max-w-prose text-muted-foreground">The site goes offline, and its deploys and images are deleted. The name becomes free again.</p>
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
                Delete site
              </Button>
            </div>
          </section>
        </>
      )}
      <ConfirmDialog
        open={dialog === "redeploy"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Redeploy ${name}`}
        description="Starts the live image again with the current env vars and settings, then switches over once it answers."
        confirm="Redeploy"
        pendingLabel="Starting…"
        onConfirm={async () => {
          await api.redeploySite(p, name);
          toast.success(`Redeploying ${name}`);
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete ${name}`}
        description="The site goes offline now, and its deploys and images are deleted. This can't be undone."
        confirm="Delete site"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await api.deleteSite(p, name);
          toast.success(`Deleted ${name}`);
          navigate({ page: "hosting", name: p, site: null });
        }}
      />
    </>
  );
}

export function HostingPage({ name, site }: { name: string; site: string | null }) {
  return (
    <ProjectGate name={name} title="Hosting" backToProject>
      {(project) => {
        if (!project.services.includes("hosting")) {
          return (
            <ServiceOff project={project} id="hosting">
              Turn it on to run your sites here: build on your machine with mybase deploy, and each site answers at its own address on your domain.
            </ServiceOff>
          );
        }
        return site ? <Site key={site} project={project} site={site} /> : <Sites project={project} />;
      }}
    </ProjectGate>
  );
}

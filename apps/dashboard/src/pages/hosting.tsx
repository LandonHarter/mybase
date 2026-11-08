import { useEffect, useState, type FormEvent } from "react";
import { Plus, RotateCcw, RefreshCw, ScrollText, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  HOSTING_SITE_RULES,
  type HostingDeploy,
  type HostingDeployStatus,
  type HostingDomain,
  type HostingDomainStatus,
  type HostingOverview,
  type HostingSite,
  type Project,
} from "@mybase/shared";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { HOSTING_SITE_TABS, href, navigate, type HostingSiteTab } from "@/lib/router";
import { SiteLogs } from "@/pages/hosting-logs";
import { cn } from "@/lib/utils";
import { parseEnvText, toDotenv } from "@/lib/dotenv";

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

/** What the site's address serves now: the live deploy, independent of the newest deploy's outcome. */
function Serving({ site }: { site: HostingSite }) {
  if (site.liveDeploy) {
    return (
      <span>
        <span className="font-medium">Live</span> <span className="font-mono text-xs text-muted-foreground">{site.liveDeploy.slice(0, 8)}</span>
      </span>
    );
  }
  return <span className="text-muted-foreground">Not serving</span>;
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
    await api.disableService(name, "hosting");
    await refreshProjects();
    toast.success(`Turned off hosting for ${name}`);
    navigate({ page: "project", name });
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
          <TableHead>Serving</TableHead>
          <TableHead>Latest deploy</TableHead>
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
              <Serving site={s} />
            </TableCell>
            <TableCell>
              {s.latest ? (
                <>
                  <Status status={s.latest.status} />
                  <span className="text-muted-foreground">
                    {" · "}
                    <time dateTime={s.latest.createdAt} title={formatDate(s.latest.createdAt)}>
                      {timeAgo(s.latest.createdAt)}
                    </time>
                  </span>
                  {s.latest.status === "failed" && s.liveDeploy && s.latest.id !== s.liveDeploy && (
                    <span className="block text-xs text-muted-foreground">Deploy failed; previous version still serving.</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Never deployed</span>
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
              <TableCell className="font-mono text-xs">
                {d.id.slice(0, 8)}
                {d.id === live && <span className="ml-2 rounded-sm border px-1.5 py-0.5 font-sans text-xs font-medium">Serving</span>}
              </TableCell>
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
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" asChild>
                    <a href={href({ page: "hosting", name: project, site, tab: "logs", deploy: d.id === live ? null : d.id })} aria-label={`Logs of deploy ${d.id.slice(0, 8)}`}>
                      <ScrollText />
                      Logs
                    </a>
                  </Button>
                  {d.status === "stopped" && d.digest !== liveDigest && (
                    <Button variant="outline" size="sm" onClick={() => setTarget(d)}>
                      <RotateCcw />
                      Roll back
                    </Button>
                  )}
                </div>
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

/** Names-only diff between two envs: what saving would add, change and remove. */
function envDiff(before: Record<string, string>, after: Record<string, string>) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  const removed = Object.keys(before).filter((k) => !(k in after));
  return { added, changed, removed };
}

/** Raw .env editing with live parse errors and a names-only preview of what saving changes. */
function EnvTextEditor({ saved, onSubmit, error }: { saved: Record<string, string>; onSubmit: (text: string) => Promise<void>; error: string | null }) {
  const [text, setText] = useState(() => toDotenv(saved));
  const [busy, setBusy] = useState(false);
  const parsed = parseEnvText(text);
  const diff = envDiff(saved, parsed.env);
  const dirty = diff.added.length + diff.changed.length + diff.removed.length > 0;
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(text);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Textarea
        name="env"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        spellCheck={false}
        aria-label="Env vars"
        aria-invalid={parsed.errors.length > 0 || undefined}
        aria-describedby="site-env-preview"
        className="font-mono text-base md:text-[13px]"
      />
      <div id="site-env-preview" className="grid gap-1 text-sm" aria-live="polite">
        {parsed.errors.map((x) => (
          <p key={x.line} className="text-destructive">
            {x.message}
          </p>
        ))}
        {parsed.duplicates.length > 0 && <p className="text-muted-foreground">Set twice (the later line wins): {parsed.duplicates.join(", ")}</p>}
        {parsed.errors.length === 0 && (
          <p className="text-muted-foreground">
            {Object.keys(parsed.env).length} {Object.keys(parsed.env).length === 1 ? "var" : "vars"}
            {dirty ? (
              <>
                {" · on save: "}
                {[
                  ...diff.added.map((k) => `+ ${k}`),
                  ...diff.changed.map((k) => `~ ${k}`),
                  ...diff.removed.map((k) => `− ${k}`),
                ].join("  ")}
              </>
            ) : (
              " · no changes"
            )}
          </p>
        )}
      </div>
      <div>
        <Button type="submit" variant="outline" disabled={busy || !dirty || parsed.errors.length > 0}>
          {busy ? "Saving…" : "Save env vars"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function Settings({ project, site, secretsOn, onSaved }: { project: string; site: HostingSite; secretsOn: boolean; onSaved: () => void }) {
  const env = useLoad(`hosting-env:${project}:${site.name}`, () => api.siteEnv(project, site.name));
  const envs = useLoad(`secrets-envs:${project}:${secretsOn}`, () => (secretsOn ? api.secrets(project) : Promise.resolve(null)));
  const [envError, setEnvError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  async function saveEnv(text: string) {
    setEnvError(null);
    try {
      const result = parseEnvText(text);
      if (result.errors.length > 0) {
        setEnvError(result.errors.map((x) => x.message).join(" "));
        return;
      }
      const parsed = result.env;
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
          <EnvTextEditor key={toDotenv(env.state.data.env)} saved={env.state.data.env} onSubmit={saveEnv} error={envError} />
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

const DOMAIN_STATUS: Record<HostingDomainStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "text-foreground font-medium" },
  manual: { label: "Needs DNS", className: "text-muted-foreground" },
  error: { label: "Error", className: "text-destructive" },
};

/** A 409 from adding a domain whose name already has an address record in Cloudflare. */
const isRecordConflict = (message: string) => /already has .* in Cloudflare/.test(message);

function AddDomainDialog({ project, site, open, onOpenChange, onAdded }: { project: string; site: string; open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hostname, setHostname] = useState("");
  const [primary, setPrimary] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setHostname("");
      setPrimary(false);
    }
  }, [open]);

  async function add(replace: boolean) {
    setBusy(true);
    setError(null);
    try {
      const d = await api.addSiteDomain(project, site, { hostname: hostname.trim(), primary: primary || undefined, replace: replace || undefined });
      toast.success(d.status === "active" ? `${d.hostname} routes to ${site}` : `Added ${d.hostname}; finish its DNS setup`);
      onOpenChange(false);
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add(false);
          }}
          className="grid gap-5"
        >
          <DialogHeader className="text-left">
            <DialogTitle>Add domain</DialogTitle>
            <DialogDescription>Another hostname for this site, like shop.com or www.shop.com. Its zone must be in the same Cloudflare account as the tunnel.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="domain-host">Hostname</Label>
            <Input
              id="domain-host"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="shop.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              className="font-mono text-xs md:text-xs"
            />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} className="size-4 accent-primary" />
            Make it the site's URL (MYBASE_SITE_URL, after a redeploy)
          </label>
          {error && (
            <div role="alert" className="grid gap-2">
              <p className="text-destructive">{error}</p>
              {isRecordConflict(error) && (
                <Button type="button" variant="outline" disabled={busy} onClick={() => void add(true)} className="justify-self-start">
                  Replace the record
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !hostname.trim()}>
              {busy ? "Adding…" : "Add domain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Domains({ project, site, base, onChange }: { project: string; site: HostingSite; base: string | null; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<HostingDomain | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(hostname: string, run: () => Promise<unknown>, done: string) {
    setBusy(hostname);
    try {
      await run();
      toast.success(done);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const builtIn = base ? `${site.name}.${base}` : `${site.name}.localhost`;
  return (
    <section aria-labelledby="domains" className="mb-10">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="domains" className="text-base font-semibold">
          Domains
        </h2>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add domain
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Hostname</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-mono text-xs">
              {builtIn}
              {!site.domains.some((d) => d.primary) && <span className="ml-2 font-sans text-muted-foreground">primary</span>}
            </TableCell>
            <TableCell className="text-muted-foreground">Built in</TableCell>
            <TableCell />
          </TableRow>
          {site.domains.map((d) => (
            <TableRow key={d.hostname} className="align-top">
              <TableCell className="font-mono text-xs">
                <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="hover:underline">
                  {d.hostname}
                </a>
                {d.primary && <span className="ml-2 font-sans text-muted-foreground">primary</span>}
              </TableCell>
              <TableCell>
                <span className={DOMAIN_STATUS[d.status].className}>{DOMAIN_STATUS[d.status].label}</span>
                {d.error && <p className="max-w-md text-xs text-destructive">{d.error}</p>}
                {d.instructions && <p className="max-w-md text-xs text-muted-foreground">{d.instructions}</p>}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {d.status !== "active" && (
                    <Button variant="ghost" size="sm" disabled={busy === d.hostname} onClick={() => act(d.hostname, () => api.recheckSiteDomain(project, site.name, d.hostname), `Checked ${d.hostname}`)}>
                      <RefreshCw />
                      Re-check
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === d.hostname}
                    onClick={() =>
                      act(d.hostname, () => api.updateSiteDomain(project, site.name, d.hostname, !d.primary), d.primary ? `${builtIn} is the site's URL again; redeploy to update MYBASE_SITE_URL` : `${d.hostname} is the site's URL; redeploy to update MYBASE_SITE_URL`)
                    }
                  >
                    <Star />
                    {d.primary ? "Unset primary" : "Make primary"}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${d.hostname}`} disabled={busy === d.hostname} onClick={() => setRemoving(d)}>
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AddDomainDialog project={project} site={site.name} open={adding} onOpenChange={setAdding} onAdded={onChange} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.hostname ?? ""}`}
        description="It stops routing to this site, and the DNS record mybase made for it is deleted."
        confirm="Remove domain"
        pendingLabel="Removing…"
        onConfirm={async () => {
          if (!removing) return;
          await api.removeSiteDomain(project, site.name, removing.hostname);
          toast.success(`Removed ${removing.hostname}`);
          onChange();
        }}
      />
    </section>
  );
}

const SITE_TAB_LABELS: Record<HostingSiteTab, string> = { overview: "Overview", logs: "Logs" };

function Site({ project, site: name, tab, deploy }: { project: Project; site: string; tab: HostingSiteTab; deploy: string | null }) {
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
      <nav aria-label="Site" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
        {HOSTING_SITE_TABS.map((t) => (
          <a
            key={t}
            href={href({ page: "hosting", name: p, site: name, tab: t })}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground outline-none",
              "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
              t === tab && "border-foreground font-medium text-foreground",
            )}
          >
            {SITE_TAB_LABELS[t]}
          </a>
        ))}
      </nav>
      {site.state.status === "loading" && <LoadingLines label="Loading site" lines={4} />}
      {site.state.status === "error" && <LoadError what="the site" message={site.state.message} onRetry={refresh} />}
      {site.state.status === "ready" && tab === "logs" && (
        <SiteLogs
          project={p}
          site={name}
          liveDeploy={site.state.data.liveDeploy}
          deploys={deploys.state.status === "ready" ? deploys.state.data : []}
          deploy={deploy}
          onStreamEnd={refresh}
        />
      )}
      {site.state.status === "ready" && tab === "overview" && (
        <>
          <section aria-labelledby="deploys" className="mb-10">
            <h2 id="deploys" className="mb-3 text-base font-semibold">
              Deploys
            </h2>
            {deploys.state.status === "loading" && <LoadingLines label="Loading deploys" lines={3} />}
            {deploys.state.status === "error" && <LoadError what="deploys" message={deploys.state.message} onRetry={refresh} />}
            {deploys.state.status === "ready" && <Deploys project={p} site={name} deploys={deploys.state.data} live={site.state.data.liveDeploy} onChange={refresh} />}
          </section>
          <Domains project={p} site={site.state.data} base={overview.state.status === "ready" ? overview.state.data.domain : null} onChange={refresh} />
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

export function HostingPage({ name, site, tab, deploy }: { name: string; site: string | null; tab: HostingSiteTab; deploy: string | null }) {
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
        return site ? <Site key={site} project={project} site={site} tab={tab} deploy={deploy} /> : <Sites project={project} />;
      }}
    </ProjectGate>
  );
}

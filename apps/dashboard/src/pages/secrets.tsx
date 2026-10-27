import { useState, type FormEvent } from "react";
import { ClipboardPaste, KeyRound, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Project, SecretEntry, SecretsEnv, SecretsOverview } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { EnvDialog, LinkDialog, PasteDialog, RevisionDialog, SecretDialog, SecretValue, When } from "@/components/secrets-dialogs";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;
const mono = (text: string) => <code className="font-mono text-[0.85em] text-foreground">{text}</code>;

const sdkSnippet = (apiUrl: string, project: string, env: string) => `import { createSecretsClient } from "@mybase-dev/sdk/secrets";

const secrets = createSecretsClient({
  apiUrl: "${apiUrl}",
  project: "${project}",
  env: "${env}",
  apiKey: process.env.MYBASE_API_KEY!,
});

await secrets.load(); // into process.env; or secrets.get("STRIPE_SECRET_KEY")`;

/** Roots in order, each followed by its branch envs (the API sorts them that way). */
function EnvTabs({ project, envs, current, onNew }: { project: string; envs: SecretsEnv[]; current: string; onNew: () => void }) {
  return (
    <nav aria-label="Environments" className="mb-4 flex items-end gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
      {envs.map((e) => (
        <a
          key={e.name}
          href={href({ page: "secrets", name: project, env: e.name })}
          aria-current={e.name === current ? "page" : undefined}
          title={e.parent ? `Branch of ${e.parent}` : undefined}
          className={cn(
            "border-b-2 border-transparent px-3 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground outline-none",
            "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
            e.parent && "pl-2",
            e.name === current && "border-foreground font-medium text-foreground",
          )}
        >
          {e.parent && (
            <span className="mr-1 text-muted-foreground" aria-hidden="true">
              ↳
            </span>
          )}
          {e.name}
        </a>
      ))}
      <Button variant="ghost" size="sm" className="mb-1 ml-1 text-muted-foreground" onClick={onNew}>
        <Plus />
        Environment
      </Button>
    </nav>
  );
}

function Keys({
  project,
  env,
  version,
  onEdit,
  onAdd,
  onPaste,
}: {
  project: string;
  env: SecretsEnv;
  version: number;
  onEdit: (secret: SecretEntry) => void;
  onAdd: () => void;
  onPaste: () => void;
}) {
  const detail = useLoad(`secrets-env:${project}:${env.name}:${version}`, () => api.secretsEnv(project, env.name));
  const state = detail.state;
  if (state.status === "loading") return <LoadingLines label="Loading secrets" />;
  if (state.status === "error") return <LoadError what="secrets" message={state.message} onRetry={detail.refresh} />;
  const secrets = state.data.secrets;

  if (secrets.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No secrets in {env.name} yet</p>
        <p className="mt-1 text-muted-foreground">
          {env.parent
            ? `This branch inherits everything in ${env.parent}, which is empty too. Add keys there to share them, or here to keep them to ${env.name}.`
            : "Add API keys, connection strings, and config your app reads from env vars. They're stored encrypted and handed to your app at start."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus />
            Add secret
          </Button>
          <Button variant="outline" size="sm" onClick={onPaste}>
            <ClipboardPaste />
            Paste .env
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[38%]">Key</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="hidden w-28 sm:table-cell">Updated</TableHead>
          <TableHead className="w-20">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {secrets.map((s) => (
          <TableRow key={s.key}>
            <TableCell className="truncate font-mono text-xs" title={s.key}>
              {s.key}
              {s.inherited && <span className="ml-2 font-sans text-muted-foreground">from {env.parent}</span>}
            </TableCell>
            <TableCell className="min-w-0">
              <SecretValue name={s.key} value={s.value} />
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              <When iso={s.updatedAt} />
            </TableCell>
            <TableCell className="text-right">
              {s.managed && !s.inherited ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground" title="Project credentials: rotate them with Link credentials">
                  <Lock className="size-3.5" />
                  Linked
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onEdit(s)}>
                  {s.inherited ? "Override" : "Edit"}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function History({ project, env, version, onChanged }: { project: string; env: SecretsEnv; version: number; onChanged: () => void }) {
  const revisions = useLoad(`secrets-history:${project}:${env.name}:${version}`, () => api.secretsRevisions(project, env.name));
  const [viewing, setViewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const state = revisions.state;

  async function restore(revision: number) {
    try {
      const result = await api.restoreSecrets(project, env.name, revision);
      toast.success(result.changed === 0 ? "Already matches that revision" : `Restored ${env.name} to revision ${revision}`);
      setViewing(null);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't restore: ${errorMessage(err)}`);
    }
  }

  let body;
  if (state.status === "loading") body = <LoadingLines label="Loading history" lines={2} />;
  else if (state.status === "error") body = <LoadError what="history" message={state.message} onRetry={revisions.refresh} />;
  else if (state.data.length === 0) body = <p className="text-muted-foreground">No changes yet. Every save becomes a revision you can look at and restore.</p>;
  else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">#</TableHead>
            <TableHead className="w-1/2">Changes</TableHead>
            <TableHead className="hidden md:table-cell">By</TableHead>
            <TableHead className="hidden sm:table-cell">When</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((r) => (
            <TableRow key={r.revision}>
              <TableCell className="text-muted-foreground">{r.revision}</TableCell>
              <TableCell className="max-w-0 truncate whitespace-nowrap" title={r.changes.map((c) => c.key).join(", ")}>
                {r.message && <span className="mr-2">{r.message}</span>}
                <span className="font-mono text-xs text-muted-foreground">
                  {r.changes.map((c) => `${c.action === "added" ? "+" : c.action === "removed" ? "−" : "~"}${c.key}`).join(" ")}
                </span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{r.actor}</TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                <When iso={r.createdAt} />
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <Button variant="ghost" size="sm" onClick={() => setViewing(r.revision)}>
                  View
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-labelledby="history" className="mb-10">
      <h2 id="history" className="mb-3 text-base font-semibold">
        History
      </h2>
      {body}
      <RevisionDialog
        project={project}
        env={env.name}
        revision={viewing}
        latest={env.revision}
        onOpenChange={(open) => !open && setViewing(null)}
        onRestore={(revision) => setRestoring(revision)}
      />
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={`Restore ${env.name} to revision ${restoring}`}
        description="Puts every value back as it was right after that change, as a new revision (so this can be undone too). Linked project credentials stay as they are."
        confirm="Restore"
        pendingLabel="Restoring…"
        destructive={false}
        onConfirm={() => (restoring !== null ? restore(restoring) : Promise.resolve())}
      />
    </section>
  );
}

function RenameEnv({ project, env, onRenamed }: { project: string; env: SecretsEnv; onRenamed: (name: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (name === env.name) return;
    setPending(true);
    setError(null);
    try {
      await api.renameSecretsEnv(project, env.name, name);
      toast.success(`Renamed ${env.name} to ${name}`);
      onRenamed(name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <Label htmlFor="env-rename" className="sr-only">
        Name
      </Label>
      <div className="flex gap-2">
        <Input key={env.name} id="env-rename" name="name" defaultValue={env.name} autoComplete="off" spellCheck={false} className="max-w-56 font-mono text-xs md:text-xs" />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Renaming…" : "Rename"}
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

type DialogName = "add" | "paste" | "env" | "link" | "key" | "delete-env" | "off";

function Secrets({ project, overview, env, onChanged }: { project: Project; overview: SecretsOverview; env: SecretsEnv; onChanged: () => Promise<void> }) {
  const name = project.name;
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [editing, setEditing] = useState<SecretEntry | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [version, setVersion] = useState(0);
  const close = (open: boolean) => !open && setDialog(null);
  const changed = () => {
    setVersion((v) => v + 1);
    void onChanged();
  };
  const branches = overview.envs.filter((e) => e.parent === env.name).map((e) => e.name);
  const linked = overview.envs.filter((e) => e.linked).map((e) => e.name);

  async function deleteEnv() {
    try {
      await api.deleteSecretsEnv(name, env.name);
      toast.success(`Deleted ${env.name}`);
      await onChanged();
      navigate({ page: "secrets", name, env: null }, { replace: true });
    } catch (err) {
      toast.error(`Couldn't delete ${env.name}: ${errorMessage(err)}`);
    }
  }

  async function unlink() {
    try {
      await api.unlinkCredentials(name, env.name);
      toast.success(`Removed the credentials from ${env.name}`);
      changed();
    } catch (err) {
      toast.error(`Couldn't unlink: ${errorMessage(err)}`);
    }
  }

  async function turnOff() {
    try {
      await api.disableService(name, "secrets");
      await refreshProjects();
      toast.success(`Turned off secrets for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off secrets: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Secrets"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Env vars and secrets per environment, stored encrypted. Your app gets them at start with mybase run, or at runtime from the SDK."
        action={
          <Button onClick={() => setDialog("add")}>
            <Plus />
            Add secret
          </Button>
        }
      />
      <EnvTabs project={name} envs={overview.envs} current={env.name} onNew={() => setDialog("env")} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          {env.parent ? (
            <>
              Branch of <span className="font-mono text-[0.9em] text-foreground">{env.parent}</span>: inherits its keys, overrides what you set here.
            </>
          ) : (
            `${env.keys} key${env.keys === 1 ? "" : "s"}${branches.length ? ` · branches: ${branches.join(", ")}` : ""}`
          )}
          {env.linked && " · holds the project's credentials"}
        </p>
        <Button variant="outline" size="sm" onClick={() => setDialog("paste")}>
          <ClipboardPaste />
          Paste .env
        </Button>
      </div>
      <div className="mb-10">
        <Keys project={name} env={env} version={version} onEdit={setEditing} onAdd={() => setDialog("add")} onPaste={() => setDialog("paste")} />
      </div>

      <History project={name} env={env} version={version} onChanged={changed} />

      <section aria-labelledby="use" className="mb-10">
        <h2 id="use" className="mb-3 text-base font-semibold">
          Use them in your app
        </h2>
        <Row title="Run your app" hint={<>Once per repo, then start anything through {mono("mybase run")}: the env's keys arrive as env vars.</>}>
          {code(`mybase secrets setup -p ${name} -e ${env.name}\nmybase run -- bun start`)}
        </Row>
        <Row
          title="API key"
          hint={
            <>
              Deploys and CI read with an API key that has {mono("secrets:read")}, ideally limited to this project and env. Pass it as {mono("MYBASE_TOKEN")} to{" "}
              {mono("mybase run")} or {mono("MYBASE_API_KEY")} to the SDK.
            </>
          }
        >
          <Button variant="outline" size="sm" onClick={() => setDialog("key")}>
            <KeyRound />
            Create key for {env.name}
          </Button>
        </Row>
        <Row title="Read at runtime" hint={<>{mono("npm install @mybase-dev/sdk")}. Reads revalidate with an ETag, so polling is cheap.</>}>
          {code(sdkSnippet(overview.apiUrl, name, env.name))}
        </Row>
        <Row
          title="Project credentials"
          hint="Keep this project's database, storage, and cache credentials here too. Linking rotates them, since the old ones were never stored."
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground">{linked.length > 0 ? `Linked to ${linked.join(", ")}.` : "Not linked to any environment."}</p>
            <div className="flex gap-2">
              {env.linked && (
                <Button variant="ghost" size="sm" onClick={() => setUnlinking(true)}>
                  Unlink {env.name}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setDialog("link")}>
                {linked.length > 0 ? "Rotate credentials" : "Link credentials"}
              </Button>
            </div>
          </div>
        </Row>
      </section>

      <section aria-labelledby="env-settings" className="mb-10">
        <h2 id="env-settings" className="mb-3 text-base font-semibold">
          Environment {env.name}
        </h2>
        <Row title="Name" hint={<>Apps and {mono("mybase secrets setup")} refer to it by name; update them after renaming.</>}>
          <RenameEnv project={name} env={env} onRenamed={async (next) => {
            await onChanged();
            navigate({ page: "secrets", name, env: next }, { replace: true });
          }} />
        </Row>
        <Row title="Delete" hint="Deletes its values and history, and its branch envs.">
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete-env")}>
            Delete {env.name}
          </Button>
        </Row>
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off secrets
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every environment, value, and revision. API keys stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off secrets
          </Button>
        </div>
      </section>

      <SecretDialog key={`new:${env.name}`} project={name} env={env} secret={null} open={dialog === "add"} onOpenChange={close} onSaved={changed} />
      {editing && (
        <SecretDialog key={editing.key} project={name} env={env} secret={editing} open onOpenChange={(open) => !open && setEditing(null)} onSaved={changed} />
      )}
      <PasteDialog project={name} env={env.name} open={dialog === "paste"} onOpenChange={close} onSaved={changed} />
      <EnvDialog
        project={name}
        envs={overview.envs}
        open={dialog === "env"}
        onOpenChange={close}
        onCreated={async (created) => {
          await onChanged();
          navigate({ page: "secrets", name, env: created.name });
        }}
      />
      <LinkDialog project={name} envs={overview.envs} open={dialog === "link"} onOpenChange={close} onLinked={changed} />
      <KeyDialog
        open={dialog === "key"}
        onOpenChange={close}
        preset={{ name: `${name} ${env.name} secrets`, permissions: ["secrets:read"], projects: [name], environments: [env.name] }}
      />
      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title={`Unlink credentials from ${env.name}`}
        description="Removes DATABASE_URL, S3_*, and the other linked keys from this env. The credentials stay valid; nothing is rotated."
        confirm="Unlink"
        pendingLabel="Unlinking…"
        onConfirm={unlink}
      />
      <ConfirmDialog
        open={dialog === "delete-env"}
        onOpenChange={close}
        title={`Delete ${env.name}`}
        description={`Deletes every value and revision in ${env.name}${branches.length ? `, and its branch envs ${branches.join(", ")}` : ""}. Apps using it stop getting secrets. This can't be undone.`}
        confirm="Delete environment"
        pendingLabel="Deleting…"
        onConfirm={deleteEnv}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={close}
        title={`Turn off secrets for ${name}`}
        description={SERVICE_PAGES.secrets.turnOff}
        confirm="Turn off secrets"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

function SecretsLoader({ project, env }: { project: Project; env: string | null }) {
  const overview = useLoad(`secrets:${project.name}`, () => api.secrets(project.name));
  const state = overview.state;
  if (state.status === "loading") {
    return (
      <>
        <PageHeader title="Secrets" breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
        <LoadingLines label="Loading secrets" />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <PageHeader title="Secrets" breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
        <LoadError what="secrets" message={state.message} onRetry={overview.refresh} />
      </>
    );
  }
  const envs = state.data.envs;
  const current = envs.find((e) => e.name === env) ?? envs.find((e) => e.name === "dev") ?? envs[0];
  if (!current) {
    return (
      <>
        <PageHeader title="Secrets" breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
        <EmptyEnvs project={project.name} onCreated={overview.refresh} />
      </>
    );
  }
  return <Secrets project={project} overview={state.data} env={current} onChanged={overview.refresh} />;
}

function EmptyEnvs({ project, onCreated }: { project: string; onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-prose rounded-lg border border-dashed p-5">
      <p className="font-medium">No environments</p>
      <p className="mt-1 text-muted-foreground">An environment is one set of values, like dev or prod. Create one to start adding secrets.</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => setOpen(true)}>
        <Plus />
        New environment
      </Button>
      <EnvDialog project={project} envs={[]} open={open} onOpenChange={setOpen} onCreated={() => void onCreated()} />
    </div>
  );
}

export function SecretsPage({ name, env }: { name: string; env: string | null }) {
  return (
    <ProjectGate name={name} title="Secrets" backToProject>
      {(project) => {
        if (!project.services.includes("secrets")) {
          return (
            <ServiceOff project={project} id="secrets">
              Turn them on to keep your app's env vars and secrets here, encrypted, in dev, staging, and prod environments (plus branches like dev_alice). Start your
              app with {mono("mybase run -- <command>")} and they arrive as env vars; every change is kept and can be restored.
            </ServiceOff>
          );
        }
        return <SecretsLoader project={project} env={env} />;
      }}
    </ProjectGate>
  );
}

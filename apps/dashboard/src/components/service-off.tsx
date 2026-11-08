import { useState, type ReactNode } from "react";
import { Check, Power } from "lucide-react";
import { toast } from "sonner";
import type { Project, ServiceId } from "@mybase/shared";
import { SERVICE_REQUIRES, SERVICES } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LinkKeysOption, useLinkedEnvs } from "@/components/link-keys";
import { PageHeader } from "@/components/page-header";
import { SERVICE_PAGES } from "@/components/service-card";
import { CredentialsDialog, type Credentials } from "@/components/service-credentials";
import { InlineCode } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";

/** Host commands a service needs once, before any project can use it. Shown apart from Turn on. */
const HOST_SETUP: Partial<Record<ServiceId, string>> = {
  sandbox: "mybase server sandbox",
  registry: "mybase server registry",
  hosting: "mybase server hosting",
};

/**
 * Turning a service on (D4): one click, visible progress, then its page. A confirm only when there
 * is a choice to make (linked secrets envs that could get its keys). Credentials it hands out
 * (the cache password) are shown once before moving on.
 */
export function useEnableService(project: Project, id: ServiceId, { go = true }: { go?: boolean } = {}) {
  const service = SERVICES.find((s) => s.id === id)!;
  const linked = useLinkedEnvs(project);
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState(false);
  const [link, setLink] = useState(true);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const envs = linked.status === "ready" ? linked.envs : [];
  const label = service.name.toLowerCase();

  const finish = async () => {
    await refreshProjects();
    if (go) navigate((SERVICE_PAGES[id].firstRun ?? SERVICE_PAGES[id].route)(project.name));
  };

  async function enable(withLink: boolean) {
    setPending(true);
    try {
      const result = await api.enableService(project.name, id, withLink);
      toast.success(`Turned on ${label} for ${project.displayName || project.name}`);
      if (result) setCredentials(result);
      else await finish();
    } finally {
      setPending(false);
    }
  }

  async function start() {
    if (envs.length > 0 && id !== "secrets") return setAsking(true);
    try {
      await enable(false);
    } catch (err) {
      toast.error(`Couldn't turn on ${label}: ${errorMessage(err)}`, { duration: Infinity, action: { label: "Retry", onClick: () => void start() } });
    }
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive={false}
        title={`Turn on ${label} for ${project.displayName || project.name}`}
        description={SERVICE_PAGES[id].turnOn ?? ""}
        confirm={`Turn on ${label}`}
        pendingLabel="Turning on…"
        onConfirm={() => enable(link)}
      >
        <LinkKeysOption id={id} envs={envs} checked={link} onCheckedChange={setLink} />
      </ConfirmDialog>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => {
          setCredentials(null);
          void finish();
        }}
      />
    </>
  );
  // Ambiguous until we know whether linked envs exist (A06): wait, or let the user skip.
  const blocked = linked.status === "loading";
  return { start, pending, blocked, linked, dialogs };
}

/** The Turn on button with its pending state and dialogs. */
export function TurnOnButton({ project, id, variant = "default", size = "default", children }: { project: Project; id: ServiceId; variant?: "default" | "outline"; size?: "default" | "sm"; children?: ReactNode }) {
  const e = useEnableService(project, id);
  const name = SERVICES.find((s) => s.id === id)!.name.toLowerCase();
  return (
    <>
      <Button variant={variant} size={size} disabled={e.pending || e.blocked} onClick={() => void e.start()}>
        <Power />
        {e.pending ? "Turning on…" : (children ?? `Turn on ${name}`)}
      </Button>
      {e.linked.status === "error" && (
        <span className="text-xs text-muted-foreground">
          Couldn't check linked secrets envs.{" "}
          <button type="button" className="underline underline-offset-2" onClick={e.linked.retry}>
            Retry
          </button>
        </span>
      )}
      {e.dialogs}
    </>
  );
}

/**
 * A service page while the service is off (A05): icon, name, what you get, Turn on, and host
 * prerequisites shown apart from enabling it for this project. One component for every service.
 */
export function ServiceOff({ project, id, children }: { project: Project; id: ServiceId; children?: ReactNode }) {
  const service = SERVICES.find((s) => s.id === id)!;
  const page = SERVICE_PAGES[id];
  const Icon = page.icon;
  const requires = (SERVICE_REQUIRES as Partial<Record<ServiceId, readonly ServiceId[]>>)[id] ?? [];
  const host = HOST_SETUP[id];
  return (
    <>
      <PageHeader title={service.name} breadcrumb={{ label: project.displayName || project.name, href: href({ page: "project", name: project.name }) }} />
      <div className="grid max-w-3xl gap-6 md:grid-cols-[1fr_16rem]">
        <div className="grid content-start gap-4">
          <div className="flex items-center gap-3">
            <Icon className="size-6 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">{page.offLabel}</p>
              <p className="text-muted-foreground">{page.summary}</p>
            </div>
          </div>
          {page.bullets && (
            <ul className="grid gap-1.5">
              {page.bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
          )}
          {children && <div className="max-w-prose text-muted-foreground">{children}</div>}
          {requires.length > 0 && (
            <p className="text-muted-foreground">
              Also turns on {requires.map((r) => SERVICES.find((s) => s.id === r)?.name.toLowerCase()).join(", ")} for this project.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <TurnOnButton project={project} id={id} />
            <a href={href({ page: "docs", service: "mybase", slug: page.docs, section: null })} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Read the guide
            </a>
          </div>
          {host && (
            <div className="rounded-lg border p-4">
              <p className="font-medium">On the server, once</p>
              <p className="mt-1 text-muted-foreground">
                This service runs extra containers on the Docker host. If they aren't set up yet, run <InlineCode>{host}</InlineCode> there first; turning it on here only enables it for{" "}
                {project.displayName || project.name}.
              </p>
            </div>
          )}
        </div>
        {/* A greyed sample of the page: what you'll see once it's on. */}
        <div aria-hidden className="hidden content-start gap-2 rounded-lg border bg-surface p-4 opacity-60 md:grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-3 rounded-sm bg-muted-foreground/25" style={{ width: `${70 - i * 12}%` }} />
              <span className="ml-auto h-3 w-8 rounded-sm bg-muted-foreground/15" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

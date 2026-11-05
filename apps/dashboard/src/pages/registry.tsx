import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Project, RegistryOverview, RegistryTag } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

function Login({ project, overview }: { project: string; overview: RegistryOverview }) {
  return (
    <section aria-labelledby="registry-login" className="mb-10">
      <h2 id="registry-login" className="mb-3 text-base font-semibold">
        Push and pull
      </h2>
      <Row title="Sign in" hint="The user name can be anything. The password is an API key with registry:write (registry:read to pull only).">
        <div className="grid gap-3">
          {code(`mybase token create ${project}-registry --perm registry:write --project ${project}\ndocker login ${overview.host} -u mybase   # paste the mb_… key as the password`)}
        </div>
      </Row>
      <Row title="Images" hint={`Any name under the project. This server runs ${overview.platform}; images for other platforms can be stored too.`}>
        <div className="grid gap-3">
          <CopyField id="registry-prefix" label="Prefix" value={`${overview.prefix}/`} />
          {code(`docker tag my-app ${overview.prefix}/my-app:latest\ndocker push ${overview.prefix}/my-app:latest`)}
        </div>
      </Row>
    </section>
  );
}

function Repositories({ project, overview }: { project: string; overview: RegistryOverview }) {
  if (!overview.repositories.length) {
    return <p className="rounded-lg border border-dashed p-6 text-muted-foreground">No images yet. Push one with docker push and it shows up here.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead>Used by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {overview.repositories.map((r) => (
          <TableRow key={r.name}>
            <TableCell>
              <a href={href({ page: "registry", name: project, repo: r.name })} className="font-mono text-xs font-medium hover:underline">
                {r.name}
              </a>
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">{r.tags}</TableCell>
            <TableCell className="text-muted-foreground">{r.site ? `Site ${r.site} (hosting)` : "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Registry({ project }: { project: Project }) {
  const name = project.name;
  const { state, refresh } = useLoad(`registry:${name}`, () => api.registry(name));
  const [off, setOff] = useState(false);

  async function turnOff() {
    try {
      await api.disableService(name, "registry");
      await refreshProjects();
      toast.success(`Turned off the container registry for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off the registry: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Container registry"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="A private Docker image registry for this project. Sign in with an API key, then push and pull like any other registry."
      />
      {state.status === "loading" && <LoadingLines label="Loading the registry" lines={3} />}
      {state.status === "error" && <LoadError what="the registry" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" && (
        <>
          <section aria-labelledby="repositories" className="mb-10">
            <h2 id="repositories" className="mb-3 text-base font-semibold">
              Repositories
            </h2>
            <Repositories project={name} overview={state.data} />
          </section>
          <Login project={name} overview={state.data} />
        </>
      )}
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off the registry
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">
            Every image in this project is deleted.{project.services.includes("hosting") ? " Hosting stores its images here, so turn hosting off first." : ""}
          </p>
          <Button variant="outline" className="text-destructive hover:text-destructive" disabled={project.services.includes("hosting")} onClick={() => setOff(true)}>
            Turn off registry
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off the container registry for ${name}`}
        description={SERVICE_PAGES.registry.turnOff}
        confirm="Turn off registry"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

function Tags({ project, repo }: { project: Project; repo: string }) {
  const name = project.name;
  const { state, refresh } = useLoad(`registry-tags:${name}:${repo}`, () => api.registryTags(name, repo));
  const overview = useLoad(`registry:${name}`, () => api.registry(name));
  const [target, setTarget] = useState<RegistryTag | null>(null);
  const prefix = overview.state.status === "ready" ? overview.state.data.prefix : `${name}`;

  return (
    <>
      <PageHeader
        title={repo}
        breadcrumb={{ label: `${name} / Container registry`, href: href({ page: "registry", name, repo: null }) }}
        description={<span className="font-mono text-xs">{`${prefix}/${repo}`}</span>}
      />
      {state.status === "loading" && <LoadingLines label="Loading tags" lines={3} />}
      {state.status === "error" && <LoadError what="tags" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" &&
        (state.data.tags.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-muted-foreground">No tags in this repository.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead>Digest</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Platforms</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.tags.map((t) => (
                <TableRow key={`${t.tag ?? ""}@${t.digest}`}>
                  <TableCell className="font-mono text-xs">{t.tag ?? <span className="text-muted-foreground">untagged (deploy)</span>}</TableCell>
                  <TableCell className="font-mono text-xs" title={t.digest}>
                    {t.digest.slice(7, 19)}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{formatBytes(t.size)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{t.platforms.join(", ") || "–"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${t.tag ?? t.digest}`} onClick={() => setTarget(t)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Delete ${repo}${target?.tag ? `:${target.tag}` : ""}`}
        description={`Deletes the image ${target?.digest.slice(0, 19)}… and every tag that points at it. Disk space comes back at the next garbage collection.`}
        confirm="Delete image"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await api.deleteRegistryImage(name, repo, target!.digest);
          toast.success(`Deleted ${target!.digest.slice(7, 19)}`);
          void refresh();
        }}
      />
    </>
  );
}

export function RegistryPage({ name, repo }: { name: string; repo: string | null }) {
  return (
    <ProjectGate name={name} title="Container registry" backToProject>
      {(project) => {
        if (!project.services.includes("registry")) {
          return (
            <ServiceOff project={project} id="registry">
              Turn it on for a private Docker image registry: sign in with an API key, then docker push and pull images under this project.
            </ServiceOff>
          );
        }
        return repo ? <Tags key={repo} project={project} repo={repo} /> : <Registry project={project} />;
      }}
    </ProjectGate>
  );
}

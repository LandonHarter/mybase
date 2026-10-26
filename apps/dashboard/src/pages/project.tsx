import { RotateCw, Upload } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { FileBrowser } from "@/components/file-browser";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFiles } from "@/lib/files";
import { formatDate, timeAgo } from "@/lib/format";
import { useProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

export function ProjectPage({ name, prefix, onDelete }: { name: string; prefix: string; onDelete: () => void }) {
  const { state, refresh } = useProjects();
  const files = useFiles(name, prefix);
  const uploadInput = useRef<HTMLInputElement>(null);

  if (state.status === "offline") {
    return (
      <>
        <PageHeader title={name} />
        <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">Can't reach the API</p>
          <p className="mt-1 text-muted-foreground">
            Check that it's running (in development, <code className="font-mono text-[0.85em] text-foreground">bun run dev</code>), then retry.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
            <RotateCw />
            Retry
          </Button>
        </div>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <PageHeader title={name} />
        <div className="grid gap-3" aria-busy="true" aria-label="Loading project">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-full max-w-md" />
          ))}
        </div>
      </>
    );
  }

  const project = state.projects.find((p) => p.name === name);
  if (!project) {
    return (
      <>
        <PageHeader title={name} />
        <div className="max-w-prose rounded-lg border border-dashed p-5">
          <p className="font-medium">No project named {name}</p>
          <p className="mt-1 text-muted-foreground">It may have been deleted.</p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <a href="#/projects">All projects</a>
          </Button>
        </div>
      </>
    );
  }

  const { database, storage } = project;

  async function onPick(input: HTMLInputElement) {
    const picked = Array.from(input.files ?? []);
    input.value = "";
    const count = await files.upload(picked);
    if (count > 0) toast.success(`Uploaded ${count} ${count === 1 ? "file" : "files"}`);
  }

  const uploadButton = storage && (
    <>
      <input ref={uploadInput} type="file" multiple hidden onChange={(e) => onPick(e.currentTarget)} />
      <Button onClick={() => uploadInput.current?.click()} disabled={files.uploading !== null}>
        <Upload />
        {files.uploading ? `Uploading ${files.uploading.done + 1} of ${files.uploading.total}…` : "Upload files"}
      </Button>
    </>
  );

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            Created{" "}
            <time dateTime={project.createdAt} title={formatDate(project.createdAt)}>
              {timeAgo(project.createdAt)}
            </time>
          </>
        }
        action={uploadButton}
      />

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect
        </h2>
        <Row title="Database" hint="Postgres. The password was shown once, when the project was created.">
          <div className="grid gap-3">
            <CopyField id="db-host" label="Host and port" value={`${database.host}:${database.port}`} />
            <CopyField id="db-name" label="Database and user" value={database.name} />
          </div>
        </Row>
        <Row title="Storage" hint="S3-compatible: use any S3 client. The secret key was shown once, when the project was created.">
          {storage ? (
            <div className="grid gap-3">
              <CopyField id="s3-endpoint" label="Endpoint" value={storage.endpoint} />
              <div className="grid gap-3 sm:grid-cols-2">
                <CopyField id="s3-bucket" label="Bucket" value={storage.bucket} />
                <CopyField id="s3-region" label="Region" value={storage.region} />
              </div>
              <CopyField id="s3-public" label={`Public URL for ${PUBLIC_PREFIX}`} value={storage.publicUrl} />
            </div>
          ) : (
            <p className="text-muted-foreground">This project was created before storage existed, so it has no bucket.</p>
          )}
        </Row>
      </section>

      {storage && (
        <section aria-labelledby="files" className="mb-10">
          <h2 id="files" className="mb-3 text-base font-semibold">
            Files
          </h2>
          <FileBrowser
            project={project.name}
            bucket={storage.bucket}
            publicUrl={storage.publicUrl}
            prefix={prefix}
            files={files}
            onNavigate={(to) => navigate({ page: "project", name: project.name, prefix: to })}
          />
        </section>
      )}

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Delete project
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Permanently deletes the database, the storage bucket, and every file in it.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={onDelete}>
            Delete project
          </Button>
        </div>
      </section>
    </>
  );
}

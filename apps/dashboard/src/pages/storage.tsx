import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX, type Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { FileBrowser, UploadTray, useCollisionPrompt } from "@/components/file-browser";
import { CodeBlock } from "@/components/code-block";
import { ConnectSheet } from "@/components/service-layout";
import { Mono } from "@/components/status";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { droppedFiles, PROXY_LIMIT, useFiles, type UploadInput } from "@/lib/files";
import { useCommands } from "@/lib/commands";
import { formatBytes } from "@/lib/format";
import { href, navigate } from "@/lib/router";

function Storage({ project, prefix }: { project: Project; prefix: string }) {
  const files = useFiles(project.name, prefix);
  const collisions = useCollisionPrompt();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useCommands([{ id: "upload", label: "Upload files", icon: Upload, run: () => uploadInput.current?.click() }]);
  // A drop anywhere on the page (ST05): an overlay names where files will go.
  useEffect(() => {
    const has = (e: globalThis.DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: globalThis.DragEvent) => {
      if (!has(e)) return;
      depth.current++;
      setDragging(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (e: globalThis.DragEvent) => has(e) && e.preventDefault();
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
    };
  }, []);
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    await send(await droppedFiles(e.dataTransfer));
  }
  const breadcrumb = { label: project.name, href: href({ page: "project", name: project.name }) };
  const { storage } = project;

  if (!storage) {
    return (
      <>
        <PageHeader title="Storage" breadcrumb={breadcrumb} />
        <div className="grid max-w-prose gap-3">
          <p className="text-muted-foreground">This project was created before storage existed, so it has no bucket. mybase can't add one to an existing project yet.</p>
          <p className="font-medium">To get storage for this app</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Create a new project: it gets a database and a bucket.</li>
            <li>Copy the data across with pg_dump into the new database (the commands below run on any machine that can reach Postgres).</li>
            <li>Point the app at the new project's credentials, then delete this one.</li>
          </ol>
          <CodeBlock lang="bash" code={`pg_dump "postgresql://${project.database.user}:<password>@${project.database.host}:${project.database.port}/${project.database.name}" --no-owner --no-acl \\
  | psql "postgresql://<new project>:<password>@${project.database.host}:${project.database.port}/<new project>"`} />
        </div>
      </>
    );
  }

  async function send(items: UploadInput[]) {
    // Cloudflare's tunnel refuses bodies over 100 MB; say so before the upload fails.
    const big = items.filter((i) => i.file.size > PROXY_LIMIT);
    if (big.length && location.hostname !== "localhost" && !/^(\d+\.){3}\d+$/.test(location.hostname)) {
      toast.warning(`${big.length === 1 ? big[0]!.path : `${big.length} files`} over ${formatBytes(PROXY_LIMIT)}: a proxy like Cloudflare refuses uploads that big. Use the S3 API from your app for large files.`, { duration: 10_000 });
    }
    await files.upload(items, collisions.resolve);
  }

  async function onPick(input: HTMLInputElement) {
    const picked = Array.from(input.files ?? []).map((file) => ({ file, path: file.name }));
    input.value = "";
    await send(picked);
  }

  const uploadButton = (
    <>
      <input ref={uploadInput} type="file" multiple hidden onChange={(e) => onPick(e.currentTarget)} />
      <Button onClick={() => uploadInput.current?.click()} data-shortcut="create">
        <Upload />
        {files.active.length ? `Uploading ${files.active.length}…` : "Upload files"}
      </Button>
    </>
  );

  return (
    <div onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-background/80 p-6" aria-live="polite">
          <p className="rounded-lg border border-dashed border-foreground/40 bg-surface px-6 py-4 text-base">
            Drop to upload to <Mono>{storage.bucket}/{prefix}</Mono>
          </p>
        </div>
      )}
      <PageHeader
        title="Storage"
        breadcrumb={breadcrumb}
        description={
          <>
            Bucket <Mono>{storage.bucket}</Mono> · S3-compatible · files under <Mono>{PUBLIC_PREFIX}</Mono> are public
          </>
        }
        action={
          <>
            <ConnectSheet title={`Connect an app to ${project.name}'s bucket`}>
        <Row title="S3" hint="The secret key was shown once, when the project was created.">
          <div className="grid gap-3">
            <CopyField id="s3-endpoint" label="Endpoint" value={storage.endpoint} />
            <div className="grid gap-3 sm:grid-cols-2">
              <CopyField id="s3-bucket" label="Bucket" value={storage.bucket} />
              <CopyField id="s3-region" label="Region" value={storage.region} />
            </div>
          </div>
        </Row>
        <Row title="Public files" hint={`Anything under ${PUBLIC_PREFIX} can be read by anyone at this URL.`}>
          <CopyField id="s3-public" label={`Public URL for ${PUBLIC_PREFIX}`} value={storage.publicUrl} />
        </Row>
            </ConnectSheet>
            {uploadButton}
          </>
        }
      />

      <UploadTray files={files} />
      <section aria-label="Files" className="mb-8">
        <FileBrowser
          project={project.name}
          bucket={storage.bucket}
          publicUrl={storage.publicUrl}
          prefix={prefix}
          files={files}
          onNavigate={(to) => navigate({ page: "storage", name: project.name, prefix: to })}
          dragging={dragging}
        />
        {collisions.dialog}
      </section>

    </div>
  );
}

export function StoragePage({ name, prefix }: { name: string; prefix: string }) {
  return (
    <ProjectGate name={name} title="Storage" backToProject>
      {(project) => <Storage project={project} prefix={prefix} />}
    </ProjectGate>
  );
}

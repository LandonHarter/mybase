import { Upload } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX, type Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { FileBrowser, useCollisionPrompt } from "@/components/file-browser";
import { ConnectSheet } from "@/components/service-layout";
import { Mono } from "@/components/status";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { useFiles } from "@/lib/files";
import { href, navigate } from "@/lib/router";

function Storage({ project, prefix }: { project: Project; prefix: string }) {
  const files = useFiles(project.name, prefix);
  const collisions = useCollisionPrompt();
  const uploadInput = useRef<HTMLInputElement>(null);
  const breadcrumb = { label: project.name, href: href({ page: "project", name: project.name }) };
  const { storage } = project;

  if (!storage) {
    return (
      <>
        <PageHeader title="Storage" breadcrumb={breadcrumb} />
        <p className="max-w-prose text-muted-foreground">This project was created before storage existed, so it has no bucket.</p>
      </>
    );
  }

  async function onPick(input: HTMLInputElement) {
    const picked = Array.from(input.files ?? []);
    input.value = "";
    const count = await files.upload(picked, collisions.resolve);
    if (count > 0) toast.success(`Uploaded ${count} ${count === 1 ? "file" : "files"}`);
  }

  const uploadButton = (
    <>
      <input ref={uploadInput} type="file" multiple hidden onChange={(e) => onPick(e.currentTarget)} />
      <Button onClick={() => uploadInput.current?.click()} disabled={files.uploading !== null}>
        <Upload />
        {files.uploading ? `Uploading ${files.uploading.done + 1} of ${files.uploading.total} to ${files.uploading.prefix || "/"}…` : "Upload files"}
      </Button>
    </>
  );

  return (
    <>
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

      <section aria-label="Files" className="mb-8">
        <FileBrowser
          project={project.name}
          bucket={storage.bucket}
          publicUrl={storage.publicUrl}
          prefix={prefix}
          files={files}
          onNavigate={(to) => navigate({ page: "storage", name: project.name, prefix: to })}
          resolveCollisions={collisions.resolve}
        />
        {collisions.dialog}
      </section>

    </>
  );
}

export function StoragePage({ name, prefix }: { name: string; prefix: string }) {
  return (
    <ProjectGate name={name} title="Storage" backToProject>
      {(project) => <Storage project={project} prefix={prefix} />}
    </ProjectGate>
  );
}

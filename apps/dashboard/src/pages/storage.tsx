import { Upload } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX, type Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { FileBrowser } from "@/components/file-browser";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { useFiles } from "@/lib/files";
import { href, navigate } from "@/lib/router";

function Storage({ project, prefix }: { project: Project; prefix: string }) {
  const files = useFiles(project.name, prefix);
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
    const count = await files.upload(picked);
    if (count > 0) toast.success(`Uploaded ${count} ${count === 1 ? "file" : "files"}`);
  }

  const uploadButton = (
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
      <PageHeader title="Storage" breadcrumb={breadcrumb} description="S3-compatible: use any S3 client." action={uploadButton} />

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
          onNavigate={(to) => navigate({ page: "storage", name: project.name, prefix: to })}
        />
      </section>

      <section aria-labelledby="connect">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect
        </h2>
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

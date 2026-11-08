import { useState, type FormEvent } from "react";
import { PROJECT_NAME_RULES, type CreateProjectResponse } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { copyText } from "@/lib/clipboard";
import { Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { useSecretGuard } from "@/components/secret-guard";

/** The created project as a .env file: everything an app needs, secrets included (never stored). */
function dotenv(p: CreateProjectResponse) {
  return [
    `DATABASE_URL=${p.credentials.database.url}`,
    ...(p.storage ? [`S3_ENDPOINT=${p.storage.endpoint}`, `S3_REGION=${p.storage.region}`, `S3_BUCKET=${p.storage.bucket}`] : []),
    `S3_ACCESS_KEY_ID=${p.credentials.storage.accessKeyId}`,
    `S3_SECRET_ACCESS_KEY=${p.credentials.storage.secretAccessKey}`,
    "",
  ].join("\n");
}

async function copyEnv(p: CreateProjectResponse) {
  try {
    await copyText(dotenv(p));
    toast.success("Copied as .env");
  } catch {
    toast.error("Couldn't copy. Use Download .env instead.");
  }
}

function downloadEnv(p: CreateProjectResponse) {
  const url = URL.createObjectURL(new Blob([dotenv(p)], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${p.name}.env` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set after creation: the secrets are only returned once, so show them before closing.
  const [created, setCreated] = useState<CreateProjectResponse | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setError(null);
      setCreated(null);
    }
    onOpenChange(next);
  };
  const guard = useSecretGuard(created !== null, () => close(false));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    setPending(true);
    setError(null);
    try {
      setCreated(await api.createProject({ name }));
      await refreshProjects();
      // Land on the new project's page, which links to each of its services.
      navigate({ page: "project", name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? close(true) : created ? guard.requestClose() : close(false))}>
      <DialogContent className={created ? "sm:max-w-lg" : "sm:max-w-md"} {...guard.contentProps}>
        {created ? (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Created {created.name}</DialogTitle>
              <DialogDescription>Save these now. The password and secret key aren't stored, so they can't be shown again.</DialogDescription>
            </DialogHeader>
            <section aria-labelledby="created-database" className="grid gap-3">
              <h3 id="created-database" className="font-medium">
                Database
              </h3>
              <CopyField id="created-db-url" label="Postgres connection string" value={created.credentials.database.url} secret />
            </section>
            {created.storage && (
              <section aria-labelledby="created-storage" className="grid gap-3">
                <h3 id="created-storage" className="font-medium">
                  Storage (S3)
                </h3>
                <CopyField id="created-s3-endpoint" label="Endpoint" value={created.storage.endpoint} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <CopyField id="created-s3-bucket" label="Bucket" value={created.storage.bucket} />
                  <CopyField id="created-s3-region" label="Region" value={created.storage.region} />
                </div>
                <CopyField id="created-s3-key" label="Access key ID" value={created.credentials.storage.accessKeyId} />
                <CopyField id="created-s3-secret" label="Secret access key" value={created.credentials.storage.secretAccessKey} secret />
              </section>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void copyEnv(created)}>
                <Copy />
                Copy as .env
              </Button>
              <Button type="button" variant="outline" onClick={() => downloadEnv(created)}>
                <Download />
                Download .env
              </Button>
            </div>
            <div className="grid gap-1">
              <p className="font-medium">Next</p>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <a className="underline-offset-2 hover:underline" href={href({ page: "database", name: created.name, tab: "tables", table: null })}>
                  Open the database
                </a>
                <a className="underline-offset-2 hover:underline" href={href({ page: "storage", name: created.name, prefix: "" })}>
                  Upload a file
                </a>
                <a className="underline-offset-2 hover:underline" href={href({ page: "project", name: created.name })}>
                  Connect an app
                </a>
              </p>
            </div>
            {guard.notice}
            <DialogFooter>
              <Button type="button" onClick={guard.close}>
                I saved these
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Create project</DialogTitle>
              <DialogDescription>Each project gets its own Postgres database and storage bucket.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                name="name"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "project-name-error" : "project-name-hint"}
              />
              {error ? (
                <p id="project-name-error" className="text-destructive">
                  {error}
                </p>
              ) : (
                <p id="project-name-hint" className="text-muted-foreground">
                  {PROJECT_NAME_RULES}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

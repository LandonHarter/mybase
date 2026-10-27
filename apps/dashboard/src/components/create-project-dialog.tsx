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
import { api, ApiError } from "@/lib/api";
import { refreshProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

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
      setError(err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={created ? "sm:max-w-lg" : "sm:max-w-md"}>
        {created ? (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Created {created.name}</DialogTitle>
              <DialogDescription>
                Copy these now. The password and secret key aren't stored, so they can't be shown again.
              </DialogDescription>
            </DialogHeader>
            <section aria-labelledby="created-database" className="grid gap-3">
              <h3 id="created-database" className="font-medium">
                Database
              </h3>
              <CopyField id="created-db-url" label="Postgres connection string" value={created.credentials.database.url} />
            </section>
            <section aria-labelledby="created-storage" className="grid gap-3">
              <h3 id="created-storage" className="font-medium">
                Storage (S3)
              </h3>
              <CopyField id="created-s3-key" label="Access key ID" value={created.credentials.storage.accessKeyId} />
              <CopyField id="created-s3-secret" label="Secret access key" value={created.credentials.storage.secretAccessKey} />
              <p className="text-muted-foreground">
                Endpoint, region, and bucket are on the project's page.
              </p>
            </section>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
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

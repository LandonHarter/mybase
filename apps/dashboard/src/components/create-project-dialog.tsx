import { Check, Copy } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PROJECT_NAME_RULES, type CreateProjectResponse } from "@mybase/shared";
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
  // Set after creation: the password is only returned once, so show it before closing.
  const [created, setCreated] = useState<CreateProjectResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      setError(null);
      setCreated(null);
      setCopied(false);
    }
    onOpenChange(next);
  };

  async function copyUrl() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.credentials.url);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    setPending(true);
    setError(null);
    try {
      setCreated(await api.createProject({ name }));
      await refreshProjects();
      // Land where the new project is visible, whichever page the dialog opened from.
      navigate({ page: "projects", query: "" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Created {created.name}</DialogTitle>
              <DialogDescription>
                Copy the connection string now. The password isn't stored, so it can't be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="project-url">Postgres connection string</Label>
              <div className="flex gap-2">
                <Input
                  id="project-url"
                  readOnly
                  value={created.credentials.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs md:text-xs"
                />
                <Button type="button" variant="outline" size="icon" onClick={copyUrl} aria-label="Copy connection string">
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            </div>
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

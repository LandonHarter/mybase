import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PROJECT_DESCRIPTION_MAX, PROJECT_DISPLAY_NAME_MAX, type Project } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { refreshProjects } from "@/lib/projects";

/** Edits the display name and description. The project name itself is fixed. */
export function EditProjectDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.updateProject(project.name, {
        displayName: String(form.get("displayName") ?? ""),
        description: String(form.get("description") ?? ""),
      });
      await refreshProjects();
      toast.success("Saved project details");
      close(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Edit project details</DialogTitle>
            <DialogDescription>
              Shown in the dashboard only. The project name <span className="font-mono text-foreground">{project.name}</span> stays the
              same: it's the database, role, and bucket name your apps use.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-display-name">Display name</Label>
            <Input
              id="project-display-name"
              name="displayName"
              defaultValue={project.displayName ?? ""}
              placeholder={project.name}
              maxLength={PROJECT_DISPLAY_NAME_MAX}
              autoComplete="off"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              name="description"
              defaultValue={project.description ?? ""}
              placeholder="What this project is for"
              maxLength={PROJECT_DESCRIPTION_MAX}
              rows={3}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "project-edit-error" : undefined}
            />
          </div>
          {error && (
            <p id="project-edit-error" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

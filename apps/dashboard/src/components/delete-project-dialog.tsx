import { useState, type FormEvent } from "react";
import { toast } from "sonner";
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

/** Deleting can't be undone, so the user types the project name to confirm. */
export function DeleteProjectDialog({
  name,
  open,
  onOpenChange,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (typed !== name) return;
    setPending(true);
    setError(null);
    try {
      await api.deleteProject(name);
      await refreshProjects();
      close(false);
      navigate({ page: "projects", query: "" });
      toast.success(`Deleted ${name}`);
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
            <DialogTitle>Delete {name}</DialogTitle>
            <DialogDescription>
              This permanently deletes the project's database, its storage bucket, and every file in it. Apps using it stop working. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono">{name}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "delete-error" : undefined}
            />
            {error && (
              <p id="delete-error" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== name || pending}>
              {pending ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

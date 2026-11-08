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
import { api, errorMessage } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { refreshProjects, useProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

const n = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** What deleting removes, per enabled service, with real counts where the API has them. */
function Impact({ name }: { name: string }) {
  const projects = useProjects().state;
  const project = projects.status === "ready" ? projects.projects.find((p) => p.name === name) : undefined;
  const services = project?.services ?? [];
  const has = (id: string) => services.includes(id as never);
  const context = useLoad(`context:${name}`, () => api.projectContext(name));
  const database = useLoad(`db:${name}`, () => api.database(name));
  const cache = useLoad(`cache:${name}:${has("cache")}`, () => (has("cache") ? api.cacheOverview(name) : Promise.resolve(null)));
  const sandbox = useLoad(`sandbox:${name}:${has("sandbox")}`, () => (has("sandbox") ? api.sandboxUsage(name) : Promise.resolve(null)));
  const c = context.data;
  const loading = context.state.status === "loading";

  const items: { label: string; detail: string }[] = [];
  const db = database.data;
  items.push({
    label: "Database",
    detail: c?.database ? `${n(c.database.tables.length, "table", "tables")}${db ? `, ${formatBytes(db.sizeBytes)}` : ""}, and every row in them` : "every table and row",
  });
  if (project?.storage) items.push({ label: "Storage", detail: `bucket ${project.storage.bucket} and every file in it` });
  if (has("cron")) items.push({ label: "Cron", detail: c?.cron ? `${n(c.cron.jobs.length, "job", "jobs")}, their run history, and pending tasks` : "every job and its history" });
  if (has("queue")) {
    const queued = c?.queue?.queues.reduce((sum, q) => sum + q.counts.visible + q.counts.inFlight + q.counts.delayed, 0);
    items.push({ label: "Queues", detail: c?.queue ? `${n(c.queue.queues.length, "queue", "queues")} with ${n(queued ?? 0, "message", "messages")}` : "every queue and message" });
  }
  if (has("cache")) items.push({ label: "Cache", detail: cache.data ? n(cache.data.keys, "key", "keys") : "every key" });
  if (has("ratelimit")) items.push({ label: "Rate limits", detail: c?.ratelimit ? `${n(c.ratelimit.rules.length, "rule", "rules")} and their counters` : "every rule" });
  if (has("analytics")) items.push({ label: "Analytics", detail: "every recorded event" });
  if (has("secrets")) {
    const keys = c?.secrets?.envs.reduce((sum, e) => sum + e.keys.length, 0);
    items.push({ label: "Secrets", detail: c?.secrets ? `${n(c.secrets.envs.length, "environment", "environments")}, ${n(keys ?? 0, "value", "values")}, and their history` : "every environment and value" });
  }
  if (has("vector")) {
    const docs = c?.vector?.indexes.reduce((sum, i) => sum + i.documents, 0);
    items.push({ label: "Vector search", detail: c?.vector ? `${n(c.vector.indexes.length, "index", "indexes")} with ${n(docs ?? 0, "document", "documents")}` : "every index" });
  }
  if (has("users")) items.push({ label: "Users", detail: c?.users ? `${n(c.users.users, "user account", "user accounts")} and their sessions` : "every user account" });
  if (has("registry")) {
    const tags = c?.registry?.repositories.reduce((sum, r) => sum + r.tags, 0);
    items.push({ label: "Registry", detail: c?.registry ? `${n(c.registry.repositories.length, "repository", "repositories")} with ${n(tags ?? 0, "tag", "tags")}` : "every image" });
  }
  if (has("hosting")) {
    const sites = c?.hosting?.sites ?? [];
    items.push({ label: "Hosting", detail: c?.hosting ? (sites.length ? `${n(sites.length, "site", "sites")} go offline: ${sites.map((x) => x.name).join(", ")}` : "no sites") : "every site goes offline" });
  }
  if (has("sandbox")) items.push({ label: "Sandboxes", detail: sandbox.data ? `${n(sandbox.data.active, "active sandbox", "active sandboxes")} stopped, and every artifact` : "every sandbox and artifact" });
  if (has("realtime")) items.push({ label: "Realtime", detail: "every open connection is closed" });
  if (has("captcha")) items.push({ label: "Captcha", detail: "its key; widgets stop verifying" });
  if (has("search")) items.push({ label: "Web search", detail: "access for this project's keys" });

  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">What gets deleted</p>
      <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-3 text-sm" aria-busy={loading || undefined}>
        {items.map((item) => (
          <li key={item.label} className="grid grid-cols-[7.5rem_1fr] gap-2">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="min-w-0 break-words">{item.detail}</span>
          </li>
        ))}
      </ul>
      {context.state.status === "error" && <p className="text-sm text-muted-foreground">Couldn't load counts ({context.state.message}). Everything above is still deleted.</p>}
    </div>
  );
}

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
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Delete {name}</DialogTitle>
            <DialogDescription>Deleting is permanent and can't be undone: there's no restore except from a backup. Apps using this project stop working.</DialogDescription>
          </DialogHeader>
          {open && <Impact name={name} />}
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

import { useState, type FormEvent } from "react";
import { Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { KEY_RESOURCES, type ApiToken, type CreateApiTokenResponse, type KeyLevel, type KeyPermission, type KeyResource } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { useProjects } from "@/lib/projects";

type Level = KeyLevel | "none";

/** What a new key starts with: a name, its permissions, and its projects (null = all). */
export interface KeyPreset {
  name?: string;
  permissions: KeyPermission[];
  projects: string[] | null;
}

// Least privilege by default: nothing is picked yet.
const EMPTY_PRESET: KeyPreset = { permissions: [], projects: null };

function levelsOf(permissions: readonly KeyPermission[]): Record<KeyResource, Level> {
  const levels = Object.fromEntries(KEY_RESOURCES.map((r) => [r.id, "none"])) as Record<KeyResource, Level>;
  for (const p of permissions) {
    const [resource, level] = p.split(":") as [KeyResource, KeyLevel | undefined];
    if (level && levels[resource] !== "write") levels[resource] = level;
  }
  return levels;
}

/** "Full admin", or "queue:write, cache:read" in plain words. */
export function describePermissions(permissions: readonly KeyPermission[]): string {
  if (permissions.includes("admin")) return "Full admin";
  const levels = levelsOf(permissions);
  return KEY_RESOURCES.filter((r) => levels[r.id] !== "none")
    .map((r) => `${r.name} (${levels[r.id]})`)
    .join(", ");
}

const LEVELS: { value: Level; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

/**
 * Creates a key (then shows it once) or edits one (`editing`). `preset` fills in a new key,
 * e.g. from a service page: that project, that service's write permission.
 */
export function KeyDialog({
  open,
  onOpenChange,
  onSaved,
  editing,
  preset = EMPTY_PRESET,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  editing?: ApiToken | null;
  preset?: KeyPreset;
}) {
  const start = editing ?? preset;
  const [admin, setAdmin] = useState(start.permissions.includes("admin"));
  const [levels, setLevels] = useState(() => levelsOf(start.permissions));
  const [limited, setLimited] = useState(start.projects !== null);
  const [chosen, setChosen] = useState<string[]>(start.projects ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The token is only returned once, so keep the dialog open to show it.
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);
  const { state: projects } = useProjects();

  // Start over each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAdmin(start.permissions.includes("admin"));
      setLevels(levelsOf(start.permissions));
      setLimited(start.projects !== null);
      setChosen(start.projects ?? []);
      setError(null);
      setCreated(null);
    }
  }

  const permissions: KeyPermission[] = admin
    ? ["admin"]
    : KEY_RESOURCES.flatMap((r) => (levels[r.id] === "none" ? [] : [`${r.id}:${levels[r.id] as KeyLevel}` as const]));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (permissions.length === 0) return setError("Give the key at least one permission.");
    if (!admin && limited && chosen.length === 0) return setError("Pick at least one project, or allow all projects.");
    const input = { name, permissions, projects: admin || !limited ? null : chosen };
    setPending(true);
    setError(null);
    try {
      if (editing) {
        await api.updateToken(editing.id, input);
        toast.success(`Saved ${name}`);
        onOpenChange(false);
      } else {
        setCreated(await api.createToken(input));
      }
      onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const projectNames = projects.status === "ready" ? projects.projects.map((p) => p.name) : [];
  // A preset or saved project that's since been deleted still shows, so it can be removed.
  const listed = [...new Set([...projectNames, ...chosen])].sort();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {created ? (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Created {created.name}</DialogTitle>
              <DialogDescription>Copy it now. Only a hash is stored, so it can't be shown again.</DialogDescription>
            </DialogHeader>
            <CopyField id="created-token" label="MYBASE_API_KEY" value={created.token} secret />
            <p className="text-muted-foreground">
              Apps pass it to <span className="font-mono text-[0.9em]">@mybase/sdk</span> as <span className="font-mono text-[0.9em]">apiKey</span>. Scripts send{" "}
              <span className="font-mono text-[0.9em]">Authorization: Bearer &lt;key&gt;</span>; the CLI reads{" "}
              <span className="font-mono text-[0.9em]">MYBASE_TOKEN</span>.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>{editing ? `Edit ${editing.name}` : "Create API key"}</DialogTitle>
              <DialogDescription>
                {editing ? "Changes apply on the key's next request." : "Give it only what it needs. Name it after where it'll be used."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" name="name" required autoFocus autoComplete="off" defaultValue={start.name ?? ""} placeholder="e.g. shop backend" />
            </div>

            <fieldset className="grid gap-3">
              <legend className="mb-2 font-medium">Access</legend>
              <RadioGroup value={admin ? "admin" : "custom"} onValueChange={(v) => setAdmin(v === "admin")} className="gap-2.5">
                <label className="flex items-start gap-3">
                  <RadioGroupItem value="custom" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Choose permissions</span>
                    <span className="block text-muted-foreground">For apps and scripts.</span>
                  </span>
                </label>
                <label className="flex items-start gap-3">
                  <RadioGroupItem value="admin" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Full admin</span>
                    <span className="block text-muted-foreground">Everything, including keys, the SQL editor, and the password. For the CLI.</span>
                  </span>
                </label>
              </RadioGroup>
            </fieldset>

            {!admin && (
              <>
                <div className="grid">
                  {KEY_RESOURCES.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t py-2.5">
                      <div className="min-w-0">
                        <p id={`perm-${r.id}`} className="font-medium">
                          {r.name}
                        </p>
                        <p className="text-muted-foreground">{r.description}</p>
                      </div>
                      <RadioGroup
                        aria-labelledby={`perm-${r.id}`}
                        value={levels[r.id]}
                        onValueChange={(v) => setLevels((l) => ({ ...l, [r.id]: v as Level }))}
                        className="flex gap-3"
                      >
                        {LEVELS.map((l) => (
                          <label key={l.value} className="flex items-center gap-1.5">
                            <RadioGroupItem value={l.value} />
                            {l.label}
                          </label>
                        ))}
                      </RadioGroup>
                    </div>
                  ))}
                </div>

                <fieldset className="grid gap-3">
                  <legend className="mb-2 font-medium">Projects</legend>
                  <RadioGroup value={limited ? "some" : "all"} onValueChange={(v) => setLimited(v === "some")} className="gap-2.5">
                    <label className="flex items-center gap-3">
                      <RadioGroupItem value="all" />
                      All projects, including new ones
                    </label>
                    <label className="flex items-center gap-3">
                      <RadioGroupItem value="some" />
                      Only these
                    </label>
                  </RadioGroup>
                  {limited && (
                    <div className="grid gap-2 pl-7">
                      {listed.length === 0 && <p className="text-muted-foreground">No projects yet.</p>}
                      {listed.map((name) => (
                        <label key={name} className="flex items-center gap-2.5">
                          <Switch
                            size="sm"
                            checked={chosen.includes(name)}
                            onCheckedChange={(on) => setChosen((c) => (on ? [...c, name] : c.filter((n) => n !== name)))}
                          />
                          <span className="font-mono text-[0.9em]">{name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
              </>
            )}

            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {editing ? (pending ? "Saving…" : "Save key") : pending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiTokens({ createOpen, onCreateOpenChange }: { createOpen: boolean; onCreateOpenChange: (open: boolean) => void }) {
  const { state, refresh } = useLoad("tokens", api.listTokens);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [editing, setEditing] = useState<ApiToken | null>(null);

  async function revoke(token: ApiToken) {
    try {
      await api.deleteToken(token.id);
      toast.success(`Revoked ${token.name}`);
      await refresh();
    } catch (err) {
      toast.error(`Couldn't revoke ${token.name}: ${errorMessage(err)}`);
    }
  }

  let body;
  if (state.status === "loading") {
    body = (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading API keys">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" />
        ))}
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={refresh}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  } else if (state.data.length === 0) {
    body = (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No API keys</p>
        <p className="mt-1 text-muted-foreground">
          <span className="font-mono text-[0.9em]">mybase login</span> creates an admin key for the CLI. Create one for each app, script, or CI job, with only the
          permissions it needs.
        </p>
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((token) => (
            <TableRow key={token.id}>
              <TableCell className="font-medium" title={`Created ${formatDate(token.createdAt)}`}>
                {token.name}
              </TableCell>
              <TableCell className="whitespace-normal">
                {describePermissions(token.permissions)}
                {token.projects && <span className="block text-muted-foreground">{token.projects.join(", ")}</span>}
              </TableCell>
              <TableCell>
                {token.lastUsedAt ? <span title={formatDate(token.lastUsedAt)}>{timeAgo(token.lastUsedAt)}</span> : <span className="text-muted-foreground">Never</span>}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <Button variant="ghost" size="sm" onClick={() => setEditing(token)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevoking(token)}>
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <section aria-labelledby="api-tokens" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="api-tokens" className="text-base font-semibold">
            API keys
          </h2>
          <p className="mt-0.5 text-muted-foreground">For apps, the CLI, scripts, and CI. Each key has its own permissions and projects.</p>
        </div>
        <Button variant="outline" onClick={() => onCreateOpenChange(true)}>
          <Plus />
          Create key
        </Button>
      </div>
      {body}
      <KeyDialog open={createOpen} onOpenChange={onCreateOpenChange} onSaved={refresh} />
      <KeyDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} onSaved={refresh} editing={editing} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "key"}`}
        description="Anything using this key stops working right away. This can't be undone."
        confirm="Revoke key"
        pendingLabel="Revoking…"
        onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())}
      />
    </section>
  );
}

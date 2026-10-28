import { useState, type FormEvent } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import type { SecretEntry, SecretsEnv, SecretsRevision } from "@mybase/shared";
import { parseDotenv } from "@mybase/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { cn } from "@/lib/utils";

const MASK = "••••••••••••";

const ErrorLine = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-destructive">
      {error}
    </p>
  ) : null;

/** A value shown masked, with reveal and copy. */
export function SecretValue({ name, value }: { name: string; value: string | null | undefined }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  if (value === null || value === undefined) return <span className="text-muted-foreground">none</span>;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Reveal the value and copy it by hand.");
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className={cn("min-w-0 truncate font-mono text-xs", !revealed && "text-muted-foreground")} title={revealed ? value : undefined}>
        {revealed ? value || '""' : MASK}
      </span>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => setRevealed(!revealed)} aria-label={`${revealed ? "Hide" : "Show"} ${name}`}>
        {revealed ? <EyeOff /> : <Eye />}
      </Button>
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={copy} aria-label={`Copy ${name}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Add a key, or change / remove one. An inherited key is overridden in this env, never changed in the parent. */
export function SecretDialog({
  project,
  env,
  secret,
  open,
  onOpenChange,
  onSaved,
}: {
  project: string;
  env: SecretsEnv;
  /** null: a new key. */
  secret: SecretEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const overriding = secret?.inherited ?? false;

  async function save(input: { set?: Record<string, string>; unset?: string[]; message?: string }, done: string) {
    setPending(true);
    setError(null);
    try {
      const result = await api.updateSecrets(project, env.name, input);
      toast.success(result.changed === 0 ? "Nothing changed" : done);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const key = secret?.key ?? String(form.get("key") ?? "").trim();
    const message = String(form.get("message") ?? "").trim() || undefined;
    void save({ set: { [key]: String(form.get("value") ?? "") }, message }, secret ? `Saved ${key}` : `Added ${key}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>{secret ? (overriding ? `Override ${secret.key}` : `Edit ${secret.key}`) : `Add a secret to ${env.name}`}</DialogTitle>
            <DialogDescription>
              {overriding
                ? `Sets ${secret!.key} in ${env.name} only. ${env.parent} keeps its value.`
                : "Saved encrypted. Apps see it on their next start (mybase run) or read."}
            </DialogDescription>
          </DialogHeader>
          {!secret && (
            <div className="grid gap-2">
              <Label htmlFor="secret-key">Key</Label>
              <Input id="secret-key" name="key" required autoFocus autoComplete="off" spellCheck={false} placeholder="STRIPE_SECRET_KEY" className="font-mono text-xs md:text-xs" />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="secret-value">Value</Label>
            <Textarea
              id="secret-value"
              name="value"
              autoFocus={secret !== null}
              autoComplete="off"
              spellCheck={false}
              defaultValue={overriding ? "" : (secret?.value ?? "")}
              rows={3}
              className="max-h-64 font-mono text-xs md:text-xs"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="secret-message">Note (optional)</Label>
            <Input id="secret-message" name="message" autoComplete="off" placeholder="Shown in the history" />
          </div>
          <ErrorLine error={error} />
          <DialogFooter className="sm:justify-between">
            {secret && !overriding ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                onClick={() => void save({ unset: [secret.key] }, `Removed ${secret.key}`)}
              >
                Remove key
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : secret ? "Save" : "Add secret"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Paste a .env file: every KEY=value line is set, as one revision. */
export function PasteDialog({ project, env, open, onOpenChange, onSaved }: { project: string; env: string; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const parsed = parseDotenv(text);
  const count = Object.keys(parsed).length;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (count === 0) return setError("No KEY=value lines found.");
    setPending(true);
    setError(null);
    try {
      const result = await api.updateSecrets(project, env, { set: parsed, message: "pasted .env" });
      toast.success(result.changed === 0 ? "Nothing changed" : `Saved ${result.changed} key${result.changed === 1 ? "" : "s"} to ${env}`);
      setText("");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Paste a .env file into {env}</DialogTitle>
            <DialogDescription>Each KEY=value line is added or replaced. Keys that aren't in the paste stay as they are.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="secrets-paste">Contents</Label>
            <Textarea
              id="secrets-paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              rows={8}
              placeholder={"DATABASE_POOL=10\nSTRIPE_SECRET_KEY=sk_live_…"}
              className="max-h-[50dvh] font-mono text-xs md:text-xs"
            />
            <p className="text-muted-foreground" aria-live="polite">
              {count === 0 ? "Comments and blank lines are skipped." : `${count} key${count === 1 ? "" : "s"}: ${Object.keys(parsed).slice(0, 6).join(", ")}${count > 6 ? ", …" : ""}`}
            </p>
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || count === 0}>
              {pending ? "Saving…" : `Save ${count || ""} key${count === 1 ? "" : "s"}`.replace("  ", " ")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Create an environment, optionally as a branch of a root one. */
export function EnvDialog({
  project,
  envs,
  open,
  onOpenChange,
  onCreated,
}: {
  project: string;
  envs: SecretsEnv[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (env: SecretsEnv) => void;
}) {
  const roots = envs.filter((e) => e.parent === null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const parent = String(form.get("parent") ?? "") || null;
    setPending(true);
    setError(null);
    try {
      const env = await api.createSecretsEnv(project, { name, parent });
      toast.success(`Created ${env.name}`);
      onCreated(env);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>A branch env starts with every key of its parent and overrides only what you change, e.g. dev_alice for your own machine.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="env-name">Name</Label>
            <Input id="env-name" name="name" required autoFocus autoComplete="off" spellCheck={false} placeholder="preview" className="font-mono text-xs md:text-xs" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="env-parent">Branch of</Label>
            <select
              id="env-parent"
              name="parent"
              className="h-9 rounded-md border bg-transparent px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              defaultValue=""
            >
              <option value="">Nothing: a separate environment</option>
              {roots.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create environment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ACTION_MARK = { added: "+", changed: "~", removed: "−" } as const;

/** One revision's changes, with old and new values (masked until revealed). */
export function RevisionDialog({
  project,
  env,
  revision,
  latest,
  onOpenChange,
  onRestore,
}: {
  project: string;
  env: string;
  revision: number | null;
  latest: number;
  onOpenChange: (open: boolean) => void;
  onRestore: (revision: number) => void;
}) {
  const detail = useLoad(`secrets-rev:${project}:${env}:${revision}`, () =>
    revision === null ? Promise.resolve(null as SecretsRevision | null) : api.secretsRevision(project, env, revision),
  );
  const state = detail.state;

  return (
    <Dialog open={revision !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="text-left">
          <DialogTitle>
            Revision {revision} of {env}
          </DialogTitle>
          <DialogDescription>
            {state.status === "ready" && state.data
              ? `${state.data.actor}, ${formatDate(state.data.createdAt)}${state.data.message ? `: ${state.data.message}` : ""}`
              : "What this change did."}
          </DialogDescription>
        </DialogHeader>
        {state.status === "loading" && <Skeleton className="h-16 w-full" />}
        {state.status === "error" && <ErrorLine error={state.message} />}
        {state.status === "ready" && state.data && (
          <div className="grid">
            {state.data.changes.map((c) => (
              <div key={c.key} className="grid gap-1 border-t py-2.5 sm:grid-cols-[12rem_1fr]">
                <p className="font-mono text-xs">
                  <span className="mr-1.5 text-muted-foreground" aria-label={c.action}>
                    {ACTION_MARK[c.action]}
                  </span>
                  {c.key}
                  {c.managed && <span className="ml-2 font-sans text-muted-foreground">(credentials)</span>}
                </p>
                <div className="grid min-w-0 gap-0.5">
                  {c.action !== "added" && (
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-10 shrink-0 text-muted-foreground">Before</span>
                      <SecretValue name={`${c.key} before`} value={c.oldValue} />
                    </div>
                  )}
                  {c.action !== "removed" && (
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-10 shrink-0 text-muted-foreground">After</span>
                      <SecretValue name={`${c.key} after`} value={c.newValue} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {revision !== null && revision < latest && (
            <Button type="button" variant="outline" onClick={() => onRestore(revision)}>
              Restore to after this change
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Pick the envs that should hold the project's credentials, then rotate them. */
export function LinkDialog({
  project,
  envs,
  open,
  onOpenChange,
  onLinked,
}: {
  project: string;
  envs: SecretsEnv[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const linked = envs.filter((e) => e.linked).map((e) => e.name);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChosen(linked.length > 0 ? linked : envs.some((e) => e.name === "prod") ? ["prod"] : []);
      setError(null);
    }
  }

  async function link() {
    if (chosen.length === 0) return setError("Pick at least one environment.");
    setPending(true);
    setError(null);
    try {
      const result = await api.linkCredentials(project, chosen);
      toast.success(`Rotated credentials and stored them in ${result.envs.join(", ")}`);
      onLinked();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="text-left">
          <DialogTitle>Rotate and store credentials for {project}</DialogTitle>
          <DialogDescription>
            The database password and storage key were shown once and never stored, so this makes new ones (and a new cache password if the cache is on) and keeps
            them here as DATABASE_URL, S3_*, REDIS_URL, MYBASE_URL, and MYBASE_PROJECT, along with the other services' keys: MYBASE_API_KEY (a new key for this
            project's services), MYBASE_CRON_SECRET, MYBASE_ANALYTICS_KEY, MYBASE_CAPTCHA_SECRET, and MYBASE_REALTIME_SECRET, for the ones that are on. Apps still using the old
            credentials stop working until they restart with these.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium">Environments</legend>
          {envs.map((e) => (
            <label key={e.name} className="flex items-center gap-2.5">
              <Switch
                size="sm"
                checked={chosen.includes(e.name)}
                disabled={e.linked}
                onCheckedChange={(on) => setChosen((c) => (on ? [...c, e.name] : c.filter((n) => n !== e.name)))}
              />
              <span className="font-mono text-[0.9em]">{e.name}</span>
              {e.linked && <span className="text-muted-foreground">already linked, updated too</span>}
            </label>
          ))}
        </fieldset>
        <ErrorLine error={error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={link}>
            {pending ? "Rotating…" : "Rotate and store"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "3 hours ago", exact on hover. */
export const When = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={formatDate(iso)}>
    {timeAgo(iso)}
  </time>
);

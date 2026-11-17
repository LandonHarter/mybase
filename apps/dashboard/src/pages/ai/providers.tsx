import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import type { AiProviderStatus } from "@mybase-dev/sdk/ai";
import { LoadError } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TableSkeleton } from "@/components/states";
import { Badge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { errorMessage, invalidate, useLoad } from "@/lib/load";
import { formatCount } from "@/lib/format";
import { href } from "@/lib/router";
import { ProviderLogo } from "@/pages/ai/provider-logo";

const mono = (t: string) => <code className="font-mono text-[0.85em]">{t}</code>;

function KeyDialog({ project, provider, keysEnv, onClose }: { project: string; provider: AiProviderStatus; keysEnv: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const set: Record<string, string> = {};
    for (const k of provider.keys) {
      const v = String(form.get(k) ?? "").trim();
      if (v) set[k] = v;
    }
    if (Object.keys(set).length === 0) return setError("Enter at least one value.");
    setPending(true);
    try {
      const res = await api.setAiKeys(project, set);
      toast.success(`Stored ${Object.keys(set).join(", ")} in secrets env ${res.env}`);
      invalidate(`ai-`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{provider.name} key</DialogTitle>
            <DialogDescription>
              Stored in the secrets env {mono(keysEnv)} as a new revision (restorable from Secrets). Apps never see it: they call the gateway with a mybase API key.
            </DialogDescription>
          </DialogHeader>
          {provider.keys.map((k, i) => (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={`key-${k}`} className="font-mono text-xs">
                {k}
              </Label>
              <Input
                id={`key-${k}`}
                name={k}
                type={/KEY|SECRET|TOKEN/.test(k) ? "password" : "text"}
                autoComplete="off"
                autoFocus={i === 0}
                placeholder={provider.missing.includes(k) ? "" : "Set: leave empty to keep it"}
                className="font-mono"
              />
            </div>
          ))}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    try {
      const id = String(f.get("id") ?? "").trim();
      const keyName = String(f.get("keyName") ?? "").trim();
      await api.putAiProvider(project, id, { name: String(f.get("name") ?? "").trim() || undefined, baseUrl: String(f.get("baseUrl") ?? "").trim(), keyName: keyName || null });
      toast.success(`Added ${id}: call it as ${id}/<model>`);
      invalidate("ai-");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a custom provider</DialogTitle>
            <DialogDescription>Any OpenAI-compatible API: Ollama, LM Studio, vLLM, LiteLLM. LAN addresses work. This server sends prompts to it.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cp-id">Id</Label>
              <Input id="cp-id" name="id" required pattern="[a-z][a-z0-9\-]{1,31}" placeholder="ollama" className="font-mono" autoFocus />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cp-name">Name</Label>
              <Input id="cp-name" name="name" placeholder="Ollama on the NAS" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-url">Base URL</Label>
            <Input id="cp-url" name="baseUrl" type="url" required placeholder="http://ollama.lan:11434/v1" className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-key">Key name (optional)</Label>
            <Input id="cp-key" name="keyName" placeholder="OLLAMA_API_KEY" className="font-mono" />
            <p className="text-muted-foreground">The secrets key holding its API key. Leave empty for keyless servers.</p>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiProviders({ project, keysEnv }: { project: string; keysEnv: string }) {
  const load = useLoad(`ai-providers:${project}`, () => api.aiProviders(project));
  const [editing, setEditing] = useState<AiProviderStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AiProviderStatus | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function test(p: AiProviderStatus) {
    setTesting(p.id);
    try {
      const r = await api.testAiProvider(project, p.id);
      if (r.ok) toast.success(`${p.name}: ${r.message} (${r.ms} ms)`);
      else toast.error(`${p.name}: ${r.message}`, { duration: Infinity });
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    } finally {
      setTesting(null);
    }
  }

  async function remove(p: AiProviderStatus) {
    if (p.custom) await api.deleteAiProvider(project, p.id);
    else
      await api.setAiKeys(
        project,
        {},
        p.keys.filter((k) => !p.missing.includes(k)),
      );
    toast.success(p.custom ? `Removed ${p.id}` : `Removed ${p.name}'s key`);
    invalidate("ai-");
  }

  if (load.state.status === "loading") return <TableSkeleton label="Loading providers" columns={3} />;
  if (load.state.status === "error") return <LoadError what="providers" message={load.state.message} onRetry={load.refresh} />;
  const list = [...load.state.data].sort((a, b) => Number(b.configured) - Number(a.configured) || Number(b.custom) - Number(a.custom));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-muted-foreground">
          Keys live in the secrets env{" "}
          <a className="text-primary underline-offset-4 hover:underline" href={href({ page: "secrets", name: project, env: keysEnv })}>
            {mono(keysEnv)}
          </a>
          . Call a model as {mono("<provider>/<model>")}.
        </p>
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          Custom provider
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden text-right md:table-cell">Models</TableHead>
            <TableHead className="hidden xl:table-cell">Endpoints</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((p) => (
            <TableRow key={p.id} className="group">
              <TableCell className="w-full max-w-0">
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderLogo id={p.id} name={p.name} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{p.name}</span>
                      {p.custom && <Badge tone="outline">custom</Badge>}
                      {p.docUrl && (
                        <a
                          href={p.docUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="focus-ring inline-flex shrink-0 items-center rounded-sm text-muted-foreground hover:text-foreground"
                          aria-label={`${p.name} docs (opens in a new tab)`}
                          title="Docs"
                        >
                          <ExternalLink className="size-3.5" aria-hidden />
                        </a>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {p.custom && p.baseUrl ? p.baseUrl : p.configured || p.keys.length === 0 ? `${p.id}/<model>` : p.missing.join(", ")}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {p.configured ? (
                  <Badge tone="success" dot>
                    Ready
                  </Badge>
                ) : (
                  <Badge title={`Needs ${p.missing.join(", ")}`}>Needs key</Badge>
                )}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{p.models === null ? "—" : formatCount(p.models)}</TableCell>
              <TableCell className="hidden xl:table-cell">
                <span className="flex flex-wrap gap-1">
                  {(
                    [
                      ["chat", p.endpoints.chat],
                      ["embeddings", p.endpoints.embeddings],
                      ["images", p.endpoints.images],
                      ["responses", p.endpoints.responses],
                      ["native", p.endpoints.native],
                    ] as const
                  )
                    .filter(([, on]) => on)
                    .map(([name]) => (
                      <Badge key={name}>{name}</Badge>
                    ))}
                </span>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {p.configured && (
                  <Button variant="ghost" size="sm" onClick={() => test(p)} disabled={testing === p.id} aria-label={`Test ${p.name}`}>
                    <Zap />
                    {testing === p.id ? "Testing…" : "Test"}
                  </Button>
                )}
                {p.keys.length > 0 && (
                  <Button variant={p.configured ? "ghost" : "outline"} size="sm" onClick={() => setEditing(p)}>
                    <KeyRound />
                    {p.configured ? "Replace key" : "Set key"}
                  </Button>
                )}
                {(p.custom || p.configured) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                    onClick={() => setRemoving(p)}
                    aria-label={p.custom ? `Remove ${p.id}` : `Remove ${p.name}'s key`}
                  >
                    <Trash2 />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing && <KeyDialog project={project} provider={editing} keysEnv={keysEnv} onClose={() => setEditing(null)} />}
      {adding && <CustomDialog project={project} onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.custom ? `Remove ${removing.id}` : `Remove ${removing?.name}'s key`}
        description={
          removing?.custom
            ? "Calls to this provider fail with 400 until you add it again. Its key (if any) stays in secrets."
            : `Deletes ${removing?.keys.join(", ")} from the secrets env (a revision you can restore). Calls to ${removing?.id}/… fail with 409 until a key is set again.`
        }
        confirm={removing?.custom ? "Remove provider" : "Remove key"}
        pendingLabel="Removing…"
        onConfirm={() => remove(removing!)}
      />
    </>
  );
}

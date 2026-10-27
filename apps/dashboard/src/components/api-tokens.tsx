import { useState, type FormEvent } from "react";
import { Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import type { ApiToken, CreateApiTokenResponse } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";

function CreateTokenDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The token is only returned once, so keep the dialog open to show it.
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);

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
      setCreated(await api.createToken({ name }));
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
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
              <DialogDescription>Copy it now. Only a hash is stored, so it can't be shown again.</DialogDescription>
            </DialogHeader>
            <CopyField id="created-token" label="API token" value={created.token} />
            <p className="text-muted-foreground">
              Send it as <span className="font-mono text-[0.9em]">Authorization: Bearer &lt;token&gt;</span>, or set{" "}
              <span className="font-mono text-[0.9em]">MYBASE_TOKEN</span> for the CLI.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Create API token</DialogTitle>
              <DialogDescription>A token can do anything the admin can. Name it after where it'll be used.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                name="name"
                required
                autoFocus
                autoComplete="off"
                placeholder="e.g. deploy pipeline"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "token-name-error" : undefined}
              />
              {error && (
                <p id="token-name-error" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create token"}
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
      <div className="grid gap-3" aria-busy="true" aria-label="Loading API tokens">
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
        <p className="font-medium">No API tokens</p>
        <p className="mt-1 text-muted-foreground">
          <span className="font-mono text-[0.9em]">mybase login</span> creates one for the CLI. Create one by hand for scripts and CI.
        </p>
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.data.map((token) => (
            <TableRow key={token.id}>
              <TableCell className="font-medium">{token.name}</TableCell>
              <TableCell title={formatDate(token.createdAt)}>{timeAgo(token.createdAt)}</TableCell>
              <TableCell>
                {token.lastUsedAt ? <span title={formatDate(token.lastUsedAt)}>{timeAgo(token.lastUsedAt)}</span> : <span className="text-muted-foreground">Never</span>}
              </TableCell>
              <TableCell className="text-right">
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
            API tokens
          </h2>
          <p className="mt-0.5 text-muted-foreground">For the CLI, scripts, and CI. Each one has full admin access.</p>
        </div>
        <Button variant="outline" onClick={() => onCreateOpenChange(true)}>
          <Plus />
          Create token
        </Button>
      </div>
      {body}
      <CreateTokenDialog open={createOpen} onOpenChange={onCreateOpenChange} onCreated={refresh} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "token"}`}
        description="Anything using this token stops working right away. This can't be undone."
        confirm="Revoke token"
        pendingLabel="Revoking…"
        onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())}
      />
    </section>
  );
}

import { useState } from "react";
import { RotateCw, Search } from "lucide-react";
import { toast } from "sonner";
import type { Extension, Project } from "@mybase/shared";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { DatabaseLayout } from "@/pages/database/layout";

function DisableDialog({
  extension,
  onOpenChange,
  onConfirm,
}: {
  extension: Extension | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (ext: Extension) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  async function confirm() {
    if (!extension) return;
    setPending(true);
    await onConfirm(extension);
    setPending(false);
    onOpenChange(false);
  }
  return (
    <Dialog open={extension !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Disable {extension?.name}</DialogTitle>
          <DialogDescription>
            Removes the extension's functions and types from this database. If tables still use them, Postgres refuses and nothing changes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={confirm}>
            {pending ? "Disabling…" : "Disable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExtensionsTab({ project }: { project: Project }) {
  const { state, refresh } = useLoad(`ext:${project.name}`, () => api.listExtensions(project.name));
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [toDisable, setToDisable] = useState<Extension | null>(null);

  async function enable(ext: Extension) {
    setPending(ext.name);
    try {
      await api.enableExtension(project.name, ext.name);
      await refresh();
      toast.success(`Enabled ${ext.name}`);
    } catch (err) {
      toast.error(`Couldn't enable ${ext.name}: ${errorMessage(err)}`);
    } finally {
      setPending(null);
    }
  }

  async function disable(ext: Extension) {
    try {
      await api.disableExtension(project.name, ext.name);
      await refresh();
      toast.success(`Disabled ${ext.name}`);
    } catch (err) {
      toast.error(`Couldn't disable ${ext.name}: ${errorMessage(err)}`);
    }
  }

  let body;
  if (state.status === "loading") {
    body = (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading extensions">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" />
        ))}
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Can't list extensions</p>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  } else {
    const needle = filter.trim().toLowerCase();
    const visible = state.data
      .filter((e) => !needle || e.name.includes(needle) || e.description.toLowerCase().includes(needle))
      // Enabled ones first: they're what the user most often comes back for.
      .sort((a, b) => Number(b.installedVersion !== null) - Number(a.installedVersion !== null) || a.name.localeCompare(b.name));
    const enabled = state.data.filter((e) => e.installedVersion !== null).length;

    body = (
      <>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Filter extensions"
              placeholder="Filter by name or description"
              className="pl-8"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <p className="text-muted-foreground">
            {enabled} of {state.data.length} enabled
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-muted-foreground">Name</TableHead>
              <TableHead className="w-full text-muted-foreground">Description</TableHead>
              <TableHead className="text-muted-foreground">Version</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((ext) => {
              const on = ext.installedVersion !== null;
              return (
                <TableRow key={ext.name}>
                  <TableCell className="whitespace-nowrap">
                    <span className="font-mono text-xs font-medium">{ext.name}</span>
                    {on && <span className="ml-2 rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground">Enabled</span>}
                  </TableCell>
                  <TableCell className="max-w-0 truncate text-muted-foreground" title={ext.description}>
                    {ext.description}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{ext.installedVersion ?? ext.defaultVersion}</TableCell>
                  <TableCell className="py-1 text-right">
                    {on ? (
                      <Button variant="ghost" size="sm" onClick={() => setToDisable(ext)} aria-label={`Disable ${ext.name}`}>
                        Disable
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => enable(ext)} aria-label={`Enable ${ext.name}`}>
                        {pending === ext.name ? "Enabling…" : "Enable"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-muted-foreground">
                  No extensions match "{filter.trim()}".
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </>
    );
  }

  return (
    <DatabaseLayout project={project} tab="extensions">
      {body}
      <DisableDialog extension={toDisable} onOpenChange={(open) => !open && setToDisable(null)} onConfirm={disable} />
    </DatabaseLayout>
  );
}

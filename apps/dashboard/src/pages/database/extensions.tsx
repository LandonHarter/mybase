import { useState } from "react";
import { RotateCw, Search } from "lucide-react";
import { toast } from "sonner";
import type { Extension, Project } from "@mybase/shared";
import { ErrorPanel } from "@/components/states";
import { Badge } from "@/components/status";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SegmentedControl } from "@/components/tabs";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const DOCS: Record<string, string> = {
  vector: "https://github.com/pgvector/pgvector#readme",
  postgis: "https://postgis.net/documentation/",
  hypopg: "https://hypopg.readthedocs.io/",
  pg_partman: "https://github.com/pgpartman/pg_partman#readme",
  pg_stat_statements: "https://www.postgresql.org/docs/current/pgstatstatements.html",
};

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90;
  return (
    <span className="block">
      <span className={cn("text-muted-foreground", !open && "line-clamp-2")}>{text}</span>
      {long && (
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Less" : "More"}
        </button>
      )}
    </span>
  );
}

export function ExtensionsTab({ project, show }: { project: Project; show: "all" | "enabled" | "available" }) {
  const { state, refresh } = useLoad(`ext:${project.name}`, () => api.listExtensions(project.name));
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [toDisable, setToDisable] = useState<Extension | null>(null);

  // D25: one at a time (concurrent superuser DDL on a Pi is a bad idea); the error stays on its row.
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);
  async function enable(ext: Extension) {
    setPending(ext.name);
    setRowError(null);
    try {
      await api.enableExtension(project.name, ext.name);
      await refresh();
      toast.success(`Enabled ${ext.name}`);
    } catch (err) {
      setRowError({ name: ext.name, message: errorMessage(err) });
    } finally {
      setPending(null);
    }
  }

  async function disable(ext: Extension) {
    await api.disableExtension(project.name, ext.name);
    await refresh();
    toast.success(`Disabled ${ext.name}`);
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
      <ErrorPanel title="Can't list extensions" message={state.message} onRetry={refresh} />
    );
  } else {
    const needle = filter.trim().toLowerCase();
    const visible = state.data
      .filter((e) => (show === "enabled" ? e.installedVersion !== null : show === "available" ? e.installedVersion === null : true))
      .filter((e) => !needle || e.name.includes(needle) || e.description.toLowerCase().includes(needle))
      // Enabled ones first: they're what the user most often comes back for.
      .sort((a, b) => Number(b.installedVersion !== null) - Number(a.installedVersion !== null) || a.name.localeCompare(b.name));
    const enabled = state.data.filter((e) => e.installedVersion !== null).length;

    body = (
      <>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <SegmentedControl
            label="Show"
            value={show}
            onChange={(v) => navigate({ page: "database", name: project.name, tab: "extensions", table: null, show: v }, { replace: true })}
            options={[
              { value: "all", label: "All" },
              { value: "enabled", label: `Enabled ${enabled}` },
              { value: "available", label: "Available" },
            ]}
          />
          {state.data.length > 10 && (
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
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="w-full">Description</TableHead>
              <TableHead>Version</TableHead>
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
                  <TableCell className="align-top whitespace-nowrap">
                    <span className="font-mono text-[13px] font-medium">{ext.name}</span>
                    {on && <Badge className="ml-2">Enabled</Badge>}
                    {DOCS[ext.name] && (
                      <a href={DOCS[ext.name]} target="_blank" rel="noreferrer" className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:underline">
                        Docs ↗
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <Description text={ext.description} />
                    {rowError?.name === ext.name && (
                      <p role="alert" className="mt-1 text-destructive">
                        Couldn't enable it: {rowError.message}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground tabular-nums whitespace-nowrap">
                    {on ? (ext.installedVersion !== ext.defaultVersion ? `${ext.installedVersion} (${ext.defaultVersion} available)` : ext.installedVersion) : `${ext.defaultVersion} available`}
                  </TableCell>
                  <TableCell className="py-1 text-right">
                    {on ? (
                      <Button variant="ghost" size="sm" onClick={() => setToDisable(ext)} aria-label={`Disable ${ext.name}`}>
                        Disable
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => enable(ext)} aria-label={`Enable ${ext.name}`}>
                        {pending === ext.name ? `Enabling ${ext.name}…` : "Enable"}
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
      <ConfirmDialog
        open={toDisable !== null}
        onOpenChange={(open) => !open && setToDisable(null)}
        title={`Disable ${toDisable?.name ?? ""} in ${project.name}`}
        description="Removes the extension's functions and types from this database. If tables still use them, Postgres refuses and nothing changes."
        confirm="Disable"
        pendingLabel="Disabling…"
        onConfirm={() => disable(toDisable!)}
      />
    </DatabaseLayout>
  );
}

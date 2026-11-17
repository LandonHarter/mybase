import { useState, type FormEvent } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { VectorSource, VectorSourceKind } from "@mybase-dev/sdk/vector";
import { LoadError } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge, LiveIndicator, Section } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { errorMessage, invalidate, POLL, useLoad } from "@/lib/load";

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function where(s: VectorSource) {
  if (s.kind === "storage") return `${String(s.config.prefix) || "(bucket root)"} · ${(s.config.include as string[] | undefined)?.join(" ") ?? ""}`;
  if (s.kind === "table") return `${s.config.schema}.${s.config.table}`;
  return "pushed by your app";
}

function StatusCell({ s }: { s: VectorSource }) {
  if (s.status === "error")
    return (
      <Badge tone="danger" title={s.lastError ?? undefined}>
        Failed
      </Badge>
    );
  if (s.status === "syncing")
    return (
      <Badge tone="info" dot>
        Syncing
      </Badge>
    );
  if (s.status === "queued") return <Badge tone="info">Queued</Badge>;
  return s.lastSyncAt ? (
    <span className="text-muted-foreground">
      Synced <TimeAgo iso={s.lastSyncAt} />
    </span>
  ) : (
    <span className="text-muted-foreground">{s.kind === "push" ? "Ready" : "Not synced"}</span>
  );
}

function AddSourceDialog({ project, index, onClose }: { project: string; index: string; onClose: () => void }) {
  const [kind, setKind] = useState<VectorSourceKind>("storage");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const id = String(f.get("id") ?? "").trim();
    const config =
      kind === "storage"
        ? { prefix: String(f.get("prefix") ?? "").trim(), ...(list(f.get("include")).length && { include: list(f.get("include")) }) }
        : kind === "table"
          ? {
              schema: String(f.get("schema") ?? "public").trim() || "public",
              table: String(f.get("table") ?? "").trim(),
              id: String(f.get("idCol") ?? "id").trim() || "id",
              text: list(f.get("text")),
              ...(String(f.get("title") ?? "").trim() && { title: String(f.get("title")).trim() }),
              ...(list(f.get("metadata")).length && { metadata: list(f.get("metadata")) }),
              ...(String(f.get("updatedAt") ?? "").trim() && { updatedAt: String(f.get("updatedAt")).trim() }),
            }
          : {};
    setPending(true);
    try {
      await api.putVectorSource(project, index, id, {
        kind,
        config: config as never,
        chunkSize: Number(f.get("chunkSize")) || undefined,
        chunkOverlap: f.get("chunkOverlap") === "" ? undefined : Number(f.get("chunkOverlap")),
        intervalMin: kind === "push" ? undefined : Number(f.get("interval")),
      });
      toast.success(kind === "push" ? `Source ${id} ready` : `Source ${id} added; first sync queued`);
      invalidate(`vector-sources:${project}:${index}`);
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
            <DialogTitle>Add a source</DialogTitle>
            <DialogDescription>mybase reads it, splits it into chunks, and keeps this index in step: changed items are re-chunked, deleted ones removed.</DialogDescription>
          </DialogHeader>
          <SegmentedControl
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "storage", label: "Storage" },
              { value: "table", label: "Table" },
              { value: "push", label: "Push" },
            ]}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="src-id">Id</Label>
            <Input id="src-id" name="id" required pattern="[a-z][a-z0-9_\-]{0,47}" placeholder={kind === "table" ? "products" : "handbook"} className="font-mono" autoFocus />
          </div>
          {kind === "storage" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="src-prefix">Prefix in the bucket</Label>
                <Input id="src-prefix" name="prefix" placeholder="docs/" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-include">Files (comma separated globs)</Label>
                <Input id="src-include" name="include" placeholder="*.md, *.pdf, *.docx, *.html (default: text, markdown, HTML, PDF, docx)" className="font-mono" />
              </div>
            </>
          )}
          {kind === "table" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="src-schema">Schema</Label>
                <Input id="src-schema" name="schema" defaultValue="public" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-table">Table</Label>
                <Input id="src-table" name="table" required className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-idcol">Id column</Label>
                <Input id="src-idcol" name="idCol" defaultValue="id" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-title">Title column</Label>
                <Input id="src-title" name="title" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-text">Text columns</Label>
                <Input id="src-text" name="text" required placeholder="name, description" className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="src-meta">Metadata columns</Label>
                <Input id="src-meta" name="metadata" placeholder="category" className="font-mono" />
              </div>
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="src-updated">Updated-at column</Label>
                <Input id="src-updated" name="updatedAt" placeholder="updated_at (reads only changed rows)" className="font-mono" />
              </div>
            </div>
          )}
          {kind === "push" && <p className="text-muted-foreground">Apps POST whole documents to …/indexes/{index}/ingest; mybase chunks and embeds them.</p>}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="src-size">Chunk size</Label>
              <Input id="src-size" name="chunkSize" type="number" min={100} max={8000} defaultValue={1000} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="src-overlap">Overlap</Label>
              <Input id="src-overlap" name="chunkOverlap" type="number" min={0} max={4000} defaultValue={150} />
            </div>
            {kind !== "push" && (
              <div className="grid gap-1.5">
                <Label htmlFor="src-interval">Sync every (min)</Label>
                <Input id="src-interval" name="interval" type="number" min={0} max={10080} defaultValue={15} />
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The sources that fill one index, with sync status (polled while one is syncing). */
export function VectorSources({ project, index, editable }: { project: string; index: string; editable: boolean }) {
  const load = useLoad(`vector-sources:${project}:${index}`, () => api.vectorSources(project, index), {
    interval: (data) => (data?.some((s) => s.status === "queued" || s.status === "syncing") ? POLL.progress : POLL.list),
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<VectorSource | null>(null);

  async function sync(s: VectorSource) {
    try {
      await api.syncVectorSource(project, index, s.id, s.kind === "table");
      toast.success(`Sync of ${s.id} queued`);
      void load.refresh();
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    }
  }

  return (
    <Section
      id="vector-sources"
      title="Sources"
      count={load.data ? formatCount(load.data.length) : undefined}
      live={load.data && load.data.length > 0 ? <LiveIndicator load={load} /> : undefined}
      actions={
        editable && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add source
          </Button>
        )
      }
    >
      {load.state.status === "error" && <LoadError what="sources" message={load.state.message} onRetry={load.refresh} />}
      {load.data && load.data.length === 0 && (
        <p className="max-w-prose text-muted-foreground">
          No sources. Let mybase fill this index from files in storage (markdown, PDF, docx, HTML), rows of a table, or whole documents your app pushes; it chunks and embeds them
          and keeps them current.
        </p>
      )}
      {load.data && load.data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Chunks</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {load.data.map((s) => (
              <TableRow key={s.id} className="group">
                <TableCell className="max-w-0 w-full">
                  <span className="font-mono text-[13px]">{s.id}</span> <Badge tone="outline">{s.kind}</Badge> {s.source === "code" && <Badge tone="outline">code</Badge>}
                  <p className="truncate text-xs text-muted-foreground">{where(s)}</p>
                  {s.status === "error" && s.lastError && <p className="text-xs text-destructive">{s.lastError}</p>}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <StatusCell s={s} />
                </TableCell>
                <TableCell className="text-right">{formatCount(s.items)}</TableCell>
                <TableCell className="text-right">{formatCount(s.chunks)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {s.kind !== "push" && (
                    <Button variant="ghost" size="sm" onClick={() => sync(s)} disabled={s.status === "syncing"} aria-label={`Sync ${s.id} now`}>
                      <RefreshCw />
                      Sync
                    </Button>
                  )}
                  {s.source !== "code" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                      onClick={() => setRemoving(s)}
                      aria-label={`Remove source ${s.id}`}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {adding && <AddSourceDialog project={project} index={index} onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove source ${removing?.id}`}
        description={`Deletes the source and the ${formatCount(removing?.chunks ?? 0)} chunks it added to ${index}.`}
        confirm="Remove source"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await api.deleteVectorSource(project, index, removing!.id);
          toast.success(`Removed ${removing!.id}`);
          invalidate(`vector-sources:${project}:${index}`);
        }}
      />
    </Section>
  );
}

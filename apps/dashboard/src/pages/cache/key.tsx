import { useState, type FormEvent } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { CacheKeyDetail, CacheKeyType, Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { href, navigate } from "@/lib/router";

const TYPE_LABELS: Record<CacheKeyType, string> = {
  string: "String",
  hash: "Hash",
  list: "List",
  set: "Set",
  zset: "Sorted set",
  stream: "Stream",
  other: "Other",
};

export const TypeTag = ({ type }: { type: CacheKeyType }) => <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground">{TYPE_LABELS[type]}</span>;

const mono = "font-mono text-xs";

function Expiry({ project, detail, onSaved }: { project: string; detail: CacheKeyDetail; onSaved: (d: CacheKeyDetail) => void }) {
  const [seconds, setSeconds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(ttlMs: number | null) {
    setPending(true);
    setError(null);
    try {
      onSaved(await api.setCacheKeyTtl(project, detail.key, ttlMs));
      setSeconds("");
      toast.success(ttlMs === null ? "Removed the expiry" : `Expires in ${formatDuration(ttlMs)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = Number(seconds.trim());
    if (!Number.isInteger(n) || n < 1) return setError("Enter a whole number of seconds.");
    void save(n * 1000);
  }

  return (
    <div className="grid gap-3">
      <p>{detail.ttlMs === null ? "Never expires" : `Expires in ${formatDuration(detail.ttlMs)}`}</p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ttl">Expire after (seconds)</Label>
          <Input id="ttl" inputMode="numeric" value={seconds} onChange={(e) => setSeconds(e.target.value)} className="w-40" />
        </div>
        <Button type="submit" variant="outline" disabled={pending || !seconds.trim()}>
          Set expiry
        </Button>
        {detail.ttlMs !== null && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => save(null)}>
            Never expire
          </Button>
        )}
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function StringEditor({ project, detail, onSaved }: { project: string; detail: Extract<CacheKeyDetail, { type: "string" }>; onSaved: (d: CacheKeyDetail) => void }) {
  const [value, setValue] = useState(detail.value);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      onSaved(await api.putCacheKey(project, detail.key, { type: "string", value }));
      toast.success("Saved");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (detail.truncated) {
    return (
      <div className="grid gap-2">
        <pre className={`max-h-96 overflow-auto rounded-md border bg-accent/40 p-3 ${mono}`}>{detail.value}</pre>
        <p className="text-muted-foreground">Showing the first 256 KB of {detail.size.toLocaleString()} bytes. Too big to edit here.</p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Textarea aria-label="Value" rows={Math.min(16, Math.max(3, value.split("\n").length))} value={value} onChange={(e) => setValue(e.target.value)} className={`${mono} md:text-xs`} />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="outline" disabled={pending || value === detail.value}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function HashEditor({ project, detail, onSaved }: { project: string; detail: Extract<CacheKeyDetail, { type: "hash" }>; onSaved: (d: CacheKeyDetail) => void }) {
  const initial = () => Object.entries(detail.value).map(([field, value]) => ({ field, value }));
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (i: number, patch: Partial<{ field: string; value: string }>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const kept = rows.filter((r) => r.field !== "");
    if (kept.length === 0) return setError("A hash needs at least one field. Delete the key instead.");
    if (new Set(kept.map((r) => r.field)).size !== kept.length) return setError("Field names must be unique.");
    setPending(true);
    setError(null);
    try {
      const saved = await api.putCacheKey(project, detail.key, { type: "hash", value: Object.fromEntries(kept.map((r) => [r.field, r.value])) });
      onSaved(saved);
      toast.success("Saved");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (detail.truncated) return <ReadOnly detail={detail} />;
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={`Field ${i + 1}`} placeholder="field" value={row.field} onChange={(e) => set(i, { field: e.target.value })} className={`w-40 sm:w-56 ${mono} md:text-xs`} />
            <Input aria-label={`Value ${i + 1}`} placeholder="value" value={row.value} onChange={(e) => set(i, { value: e.target.value })} className={`${mono} md:text-xs`} />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove field ${row.field || i + 1}`} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => setRows((r) => [...r, { field: "", value: "" }])}>
          <Plus />
          Add field
        </Button>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** Lists, sets, sorted sets, streams, and oversized hashes: shown, not edited. Apps own their shape. */
function ReadOnly({ detail }: { detail: CacheKeyDetail }) {
  let head: string[];
  let rows: string[][];
  switch (detail.type) {
    case "hash":
      head = ["Field", "Value"];
      rows = Object.entries(detail.value);
      break;
    case "list":
      head = ["Index", "Value"];
      rows = detail.value.map((v, i) => [String(i), v]);
      break;
    case "set":
      head = ["Member"];
      rows = detail.value.map((v) => [v]);
      break;
    case "zset":
      head = ["Member", "Score"];
      rows = detail.value.map((v) => [v.member, String(v.score)]);
      break;
    case "stream":
      head = ["Entry", "Fields"];
      rows = detail.value.map((e) => [e.id, Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(" ")]);
      break;
    default:
      return <p className="text-muted-foreground">This type can't be shown here.</p>;
  }
  return (
    <div className="grid gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((cell, j) => (
                <TableCell key={j} className={`max-w-md truncate ${mono}`} title={cell}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {detail.truncated && <p className="text-muted-foreground">Showing {rows.length.toLocaleString()} of {detail.size.toLocaleString()}.</p>}
    </div>
  );
}

const sizeLabel = (d: CacheKeyDetail) => {
  if (d.type === "string") return `${d.size.toLocaleString()} bytes`;
  const unit = { hash: "field", list: "item", set: "member", zset: "member", stream: "entry", other: "item" }[d.type];
  return `${d.size.toLocaleString()} ${d.size === 1 ? unit : unit === "entry" ? "entries" : `${unit}s`}`;
};

export function CacheKeyView({ project, cacheKey }: { project: Project; cacheKey: string }) {
  const name = project.name;
  const { state, refresh } = useLoad(`cache-key:${name}:${cacheKey}`, () => api.cacheKey(name, cacheKey));
  const [saved, setSaved] = useState<CacheKeyDetail | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const listHref = href({ page: "cache", name, key: null, query: "" });
  const breadcrumb = { label: `${name} / Cache`, href: listHref };
  const detail = saved ?? (state.status === "ready" ? state.data : null);

  async function remove() {
    try {
      await api.deleteCacheKey(name, cacheKey);
      toast.success(`Deleted ${cacheKey}`);
      navigate({ page: "cache", name, key: null, query: "" }, { replace: true });
    } catch (err) {
      toast.error(`Couldn't delete the key: ${errorMessage(err)}`);
    }
  }

  if (state.status === "loading") {
    return (
      <>
        <PageHeader title={cacheKey} breadcrumb={breadcrumb} />
        <LoadingLines label="Loading key" />
      </>
    );
  }
  if (state.status === "error" || !detail) {
    return (
      <>
        <PageHeader title={cacheKey} breadcrumb={breadcrumb} />
        <LoadError what="this key" message={state.status === "error" ? state.message : ""} onRetry={refresh} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={cacheKey} breadcrumb={breadcrumb} description={`${TYPE_LABELS[detail.type]} · ${sizeLabel(detail)}`} />
      <section aria-labelledby="value" className="mb-10">
        <h2 id="value" className="mb-3 text-base font-semibold">
          Value
        </h2>
        {detail.type === "string" && <StringEditor key={detail.value} project={name} detail={detail} onSaved={setSaved} />}
        {detail.type === "hash" && <HashEditor key={JSON.stringify(detail.value)} project={name} detail={detail} onSaved={setSaved} />}
        {detail.type !== "string" && detail.type !== "hash" && <ReadOnly detail={detail} />}
      </section>
      <section aria-labelledby="expiry" className="mb-10">
        <h2 id="expiry" className="mb-3 text-base font-semibold">
          Expiry
        </h2>
        <Row title="Time to live" hint="The key is deleted when it runs out. Writing the value keeps the current expiry.">
          <Expiry project={name} detail={detail} onSaved={setSaved} />
        </Row>
      </section>
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Delete key
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Removes the key and its value right away.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete key
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${cacheKey}`}
        description="Apps reading it get nothing back. This can't be undone."
        confirm="Delete key"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </>
  );
}

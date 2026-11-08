import { ArrowDown, ArrowUp, Check, Copy, Download, File as FileIcon, FileArchive, FileCode, FileImage, FileText, FileVideo, Folder, FolderPlus, Globe, Link, MoreHorizontal, Music, RotateCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX, type StorageFile } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Facts, Inspector } from "@/components/inspector";
import { InlineDelete } from "@/components/inline-delete";
import { EmptyState, ErrorPanel, TableSkeleton } from "@/components/states";
import { Badge, LiveIndicator, Mono } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fileUrl } from "@/lib/api";
import { copyText, useCopy } from "@/lib/clipboard";
import type { Collision, ResolveCollisions, UploadItem, useFiles } from "@/lib/files";
import { formatBytes, formatDate, plural } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

/** The last path segment: "a/b/c.txt" → "c.txt", "a/b/" → "b". */
export const baseName = (key: string) => key.replace(/\/$/, "").split("/").pop() ?? key;
const ext = (key: string) => (/\.([a-z0-9]+)$/i.exec(key)?.[1] ?? "").toLowerCase();

type Kind = "image" | "video" | "audio" | "pdf" | "text" | "archive" | "code" | "other";
const KINDS: Record<string, Kind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  pdf: "pdf",
  txt: "text", md: "text", csv: "text", log: "text", json: "text", yaml: "text", yml: "text", toml: "text", env: "text",
  zip: "archive", gz: "archive", tar: "archive", tgz: "archive", "7z": "archive", rar: "archive",
  js: "code", ts: "code", tsx: "code", css: "code", html: "code", svg: "code", xml: "code", sql: "code", py: "code", sh: "code",
};
const kindOf = (key: string): Kind => KINDS[ext(key)] ?? "other";
const KIND_ICONS: Record<Kind, typeof FileIcon> = { image: FileImage, video: FileVideo, audio: Music, pdf: FileText, text: FileText, archive: FileArchive, code: FileCode, other: FileIcon };
const KIND_LABELS: Record<Kind, string> = { image: "Image", video: "Video", audio: "Audio", pdf: "PDF", text: "Text", archive: "Archive", code: "Code", other: "File" };

const isPublic = (key: string) => key.startsWith(PUBLIC_PREFIX);
const publicLink = (publicUrl: string, key: string) => publicUrl + key.slice(PUBLIC_PREFIX.length).split("/").map(encodeURIComponent).join("/");

function IconButton({ label, onClick, href, children }: { label: string; onClick?: () => void; href?: string; children: ReactNode }) {
  const button = href ? (
    <Button asChild variant="ghost" size="icon-sm" aria-label={label}>
      <a href={href} download>
        {children}
      </a>
    </Button>
  ) : (
    <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Bucket root → current folder; middle levels collapse into a menu when deep. The current folder stays copyable. */
function Breadcrumb({ project, bucket, prefix }: { project: string; bucket: string; prefix: string }) {
  const parts = prefix.split("/").filter(Boolean);
  const link = (to: string) => href({ page: "storage", name: project, prefix: to });
  const { copied, copy } = useCopy(prefix);
  const collapsed = parts.length > 3 ? parts.slice(0, parts.length - 2) : [];
  const shown = parts.length > 3 ? parts.slice(-2) : parts;
  const offset = parts.length - shown.length;
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center font-mono text-[13px]">
      <a href={link("")} className="text-muted-foreground hover:text-foreground" aria-current={parts.length === 0 ? "page" : undefined}>
        {bucket}
      </a>
      {collapsed.length > 0 && (
        <>
          <span className="px-1 text-muted-foreground">/</span>
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-sm px-1 text-muted-foreground hover:text-foreground" aria-label="Folders above">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {collapsed.map((p, i) => (
                <DropdownMenuItem key={i} asChild>
                  <a href={link(parts.slice(0, i + 1).join("/") + "/")} className="font-mono text-[13px]">
                    {p}
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      {shown.map((part, i) => {
        const at = offset + i;
        const last = at === parts.length - 1;
        return (
          <span key={at} className="flex min-w-0 items-center">
            <span className="px-1 text-muted-foreground">/</span>
            <a href={link(parts.slice(0, at + 1).join("/") + "/")} className={cn("truncate", last ? "text-foreground" : "text-muted-foreground hover:text-foreground")} aria-current={last ? "page" : undefined}>
              {part}
            </a>
          </span>
        );
      })}
      {prefix && (
        <Button type="button" variant="ghost" size="icon-xs" className="ml-1" aria-label="Copy folder path" title="Copy folder path" onClick={() => copy(prefix, "folder path")}>
          {copied ? <Check /> : <Copy />}
        </Button>
      )}
    </nav>
  );
}

function NewFolderDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (name: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const close = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("folder") ?? "").trim();
    if (!name || name.includes("/") || name === "." || name === "..") return setError("Use a name without slashes, other than . or ..");
    close(false);
    onCreate(name);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Open a new folder path</DialogTitle>
            <DialogDescription>S3 has no empty folders: a folder is part of each file's key. This opens the path; it's saved once you upload a file into it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input id="folder-name" name="folder" required autoFocus autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={error ? "folder-error" : undefined} className="font-mono md:text-[13px]" />
            {error && (
              <p id="folder-error" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit">Open folder</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks once per upload batch what to do with names that already exist in the folder:
 * Replace, Skip, or Keep both ("photo (1).png"). Pass `resolve` to `files.upload`.
 */
export function useCollisionPrompt() {
  const [pending, setPending] = useState<{ names: string[]; done: (c: Collision | null) => void } | null>(null);
  const resolve = useCallback<ResolveCollisions>((names) => new Promise((done) => setPending({ names, done })), []);
  const finish = (choice: Collision | null) => {
    pending?.done(choice);
    setPending(null);
  };
  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{pending?.names.length === 1 ? "A file with this name exists" : `${pending?.names.length} files already exist`}</DialogTitle>
          <DialogDescription>Replacing overwrites the stored file; links to it serve the new one.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 overflow-y-auto rounded-md border p-2 font-mono text-[13px]">
          {pending?.names.map((n) => (
            <li key={n} className="truncate" title={n}>
              {n}
            </li>
          ))}
        </ul>
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => finish(null)}>
            Cancel upload
          </Button>
          <Button type="button" variant="outline" onClick={() => finish("skip")}>
            Skip
          </Button>
          <Button type="button" variant="outline" onClick={() => finish("rename")}>
            Keep both
          </Button>
          <Button type="button" variant="destructive" onClick={() => finish("replace")}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { resolve, dialog };
}

/** Upload tray (ST05): each file with byte progress, cancel, retry, and a summary. */
export function UploadTray({ files }: { files: ReturnType<typeof useFiles> }) {
  const { uploads, cancel, retry, clearUploads } = files;
  if (uploads.length === 0) return null;
  const done = uploads.filter((u) => u.status === "done").length;
  const failed = uploads.filter((u) => u.status === "failed" || u.status === "cancelled").length;
  const busy = uploads.some((u) => u.status === "uploading" || u.status === "queued");
  return (
    <section aria-label="Uploads" className="mb-4 rounded-lg border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="font-medium" aria-live="polite">
          {busy ? `Uploading ${Math.min(done + 1, uploads.length)} of ${uploads.length}` : `Uploaded ${done} of ${uploads.length}`}
          {failed > 0 && <span className="text-destructive"> · {failed} not uploaded</span>}
        </p>
        <span className="ml-auto flex gap-1">
          {failed > 0 && (
            <Button variant="ghost" size="sm" onClick={() => retry()}>
              <RotateCw />
              Retry {failed}
            </Button>
          )}
          {!busy && (
            <Button variant="ghost" size="sm" onClick={clearUploads}>
              Clear
            </Button>
          )}
        </span>
      </div>
      <ul className="grid max-h-48 gap-1 overflow-y-auto">
        {uploads.map((u: UploadItem) => (
          <li key={u.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-sm">
            <span className="min-w-0">
              <span className="block truncate font-mono text-[13px]" title={u.key}>
                {u.key}
              </span>
              {u.status === "uploading" && (
                <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={u.file.size} aria-valuenow={u.loaded} aria-label={`Uploading ${baseName(u.key)}`}>
                  <span className="block h-full bg-primary" style={{ width: `${u.file.size ? (u.loaded / u.file.size) * 100 : 100}%` }} />
                </span>
              )}
              {u.error && <span className="block text-xs text-destructive">{u.error}</span>}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              {u.status === "uploading" ? `${formatBytes(u.loaded)} / ${formatBytes(u.file.size)}` : u.status === "queued" ? "Waiting" : u.status === "done" ? <Check className="size-4 text-success" aria-label="Done" /> : u.status === "cancelled" ? "Cancelled" : "Failed"}
              {(u.status === "uploading" || u.status === "queued") && (
                <Button variant="ghost" size="icon-xs" aria-label={`Cancel ${baseName(u.key)}`} onClick={() => cancel(u.id)}>
                  <X />
                </Button>
              )}
              {(u.status === "failed" || u.status === "cancelled") && (
                <Button variant="ghost" size="icon-xs" aria-label={`Retry ${baseName(u.key)}`} onClick={() => retry(u.id)}>
                  <RotateCw />
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Safe previews (ST01): never renders HTML, SVG, or scripts on the admin origin. */
function Preview({ project, file }: { project: string; file: StorageFile }) {
  const kind = kindOf(file.key);
  const url = fileUrl(project, file.key);
  const [text, setText] = useState<{ body: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "text") return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`Couldn't load a preview (${res.status})`);
        // Read only the first 64 KB.
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < 65_536) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        void reader.cancel();
        const all = new Uint8Array(Math.min(size, 65_536));
        let at = 0;
        for (const c of chunks) {
          if (at >= all.length) break;
          const part = c.subarray(0, Math.min(c.length, all.length - at));
          all.set(part, at);
          at += part.length;
        }
        let body = new TextDecoder().decode(all);
        if (ext(file.key) === "json" && file.size <= 65_536) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            // keep as stored
          }
        }
        setText({ body, truncated: file.size > 65_536 });
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      }
    })();
    return () => controller.abort();
  }, [kind, url, file.key, file.size]);

  if (kind === "image") return <img src={url} alt={baseName(file.key)} className="max-h-80 rounded-md border object-contain" />;
  if (kind === "video") return <video src={url} controls preload="metadata" className="max-h-80 w-full rounded-md border" />;
  if (kind === "audio") return <audio src={url} controls preload="metadata" className="w-full" />;
  if (kind === "pdf") return <iframe src={url} title={baseName(file.key)} sandbox="" className="h-96 w-full rounded-md border bg-white" />;
  if (kind === "text") {
    if (error) return <p className="text-muted-foreground">{error}</p>;
    if (!text) return <p className="text-muted-foreground">Loading preview…</p>;
    return (
      <div className="grid gap-1">
        <pre className="code-block max-h-96 overflow-auto rounded-md border bg-surface p-3 whitespace-pre-wrap break-all">{text.body}</pre>
        {text.truncated && <p className="text-xs text-muted-foreground">Showing the first 64 KB of {formatBytes(file.size)}.</p>}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground">
      No preview for this type. {kind === "code" ? "Code and markup are never rendered here, so a stored file can't act as the dashboard." : "Download it to open it."}
    </p>
  );
}

function FileInspector({ project, file, publicUrl, onClose, onDelete }: { project: string; file: StorageFile; publicUrl: string; onClose: () => void; onDelete: (key: string) => Promise<void> }) {
  const pub = isPublic(file.key);
  const kind = kindOf(file.key);
  return (
    <Inspector
      open
      onOpenChange={(o) => !o && onClose()}
      kind={KIND_LABELS[kind]}
      identifier={file.key}
      wide
      actions={
        <>
          <InlineDelete
            className="mr-auto"
            label={`Delete ${baseName(file.key)}`}
            onDelete={async () => {
              await onDelete(file.key);
              toast.success(`Deleted ${baseName(file.key)}`);
              onClose();
            }}
          />
          {pub && (
            <Button variant="outline" onClick={() => void copyText(publicLink(publicUrl, file.key)).then(() => toast.success("Copied public link"))}>
              <Link />
              Copy public URL
            </Button>
          )}
          <Button asChild>
            <a href={fileUrl(project, file.key)} download>
              <Download />
              Download
            </a>
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <Preview project={project} file={file} />
        <Facts
          items={[
            ["Key", <Mono key="k">{file.key}</Mono>],
            ["Size", `${formatBytes(file.size)} (${file.size.toLocaleString()} bytes)`],
            ["Type", `${KIND_LABELS[kind]}${ext(file.key) ? ` (.${ext(file.key)})` : ""}`],
            [
              "Modified",
              file.lastModified ? (
                <span key="m">
                  {formatDate(file.lastModified)} · <TimeAgo iso={file.lastModified} />
                </span>
              ) : (
                "—"
              ),
            ],
            [
              "Access",
              pub ? (
                <span key="a">
                  <Badge tone="info" dot>
                    Public
                  </Badge>{" "}
                  Anyone with the link can read it: <Mono className="break-all">{publicLink(publicUrl, file.key)}</Mono>
                </span>
              ) : (
                <span key="a">
                  <Badge tone="outline">Private</Badge> Only apps with the project's S3 key, and this dashboard. Files under <Mono>{PUBLIC_PREFIX}</Mono> are shared by link.
                </span>
              ),
            ],
          ]}
        />
      </div>
    </Inspector>
  );
}

type Sort = { by: "name" | "size" | "modified"; desc: boolean };
const PAGE = 200;

/** One folder of a project's bucket: navigate, inspect, upload, download, share, delete. */
export function FileBrowser({
  project,
  bucket,
  publicUrl,
  prefix,
  files,
  onNavigate,
  dragging,
}: {
  project: string;
  bucket: string;
  publicUrl: string;
  prefix: string;
  files: ReturnType<typeof useFiles>;
  onNavigate: (prefix: string) => void;
  /** A drop is hovering over the page (the page owns the drop target). */
  dragging: boolean;
}) {
  const { state, refresh, remove, load } = files;
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [open, setOpen] = useState<StorageFile | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ by: "name", desc: false });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkDelete, setBulkDelete] = useState(false);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    setPicked(new Set());
    setFilter("");
    setShown(PAGE);
  }, [prefix]);

  async function copyPublicLink(key: string) {
    const url = publicLink(publicUrl, key);
    try {
      await copyText(url);
      toast.success("Copied public link");
    } catch {
      toast.error(`Couldn't copy. The link is ${url}`);
    }
  }

  const sortButton = (by: Sort["by"], label: string, right = false) => (
    <button type="button" className={cn("group inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", right && "flex-row-reverse")} onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== "name" }))}>
      {label}
      {sort.by === by ? sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : <ArrowDown className="size-3 opacity-0 group-hover:opacity-40" aria-hidden />}
    </button>
  );

  let body;
  if (state.status === "loading") body = <TableSkeleton label="Loading files" rows={4} columns={4} />;
  else if (state.status === "error") body = <ErrorPanel title="Can't list files" message={state.message} onRetry={refresh} />;
  else if (state.listing.folders.length === 0 && state.listing.files.length === 0) {
    body = (
      <EmptyState title={prefix ? "This folder is empty" : "No files yet"} className={cn(dragging && "border-foreground/40 bg-accent")}>
        {prefix ? "It exists only in this view until you upload a file into it. " : ""}Drop files or folders anywhere on this page, or use Upload files. Anything under <Mono>{PUBLIC_PREFIX}</Mono> can be read by anyone with its link.
      </EmptyState>
    );
  } else {
    const needle = filter.trim().toLowerCase();
    const folders = state.listing.folders.filter((f) => !needle || baseName(f).toLowerCase().includes(needle));
    const dir = sort.desc ? -1 : 1;
    const objects = state.listing.files
      .filter((f) => !needle || baseName(f.key).toLowerCase().includes(needle))
      .sort((a, b) => dir * (sort.by === "size" ? a.size - b.size : sort.by === "modified" ? (a.lastModified ?? "").localeCompare(b.lastModified ?? "") : baseName(a.key).localeCompare(baseName(b.key))));
    const allPicked = objects.length > 0 && objects.every((f) => picked.has(f.key));
    const pickedFiles = objects.filter((f) => picked.has(f.key));
    body = (
      <>
        {pickedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border bg-surface px-3 py-1.5" role="region" aria-label="Selected files">
            <span>{plural(pickedFiles.length, "file", "files")} selected</span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={async () => {
                // One at a time, so the browser doesn't block them as a burst.
                for (const f of pickedFiles) {
                  const a = Object.assign(document.createElement("a"), { href: fileUrl(project, f.key), download: baseName(f.key) });
                  a.click();
                  await new Promise((r) => setTimeout(r, 400));
                }
              }}
            >
              <Download />
              Download {pickedFiles.length}
            </Button>
            <Button variant="danger-outline" size="sm" onClick={() => setBulkDelete(true)}>
              <Trash2 />
              Delete {pickedFiles.length}…
            </Button>
          </div>
        )}
        <div className={cn("rounded-lg border border-transparent", dragging && "border-dashed border-foreground/40 bg-accent")}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8">
                  <Checkbox aria-label="Select all files" checked={allPicked ? true : pickedFiles.length ? "indeterminate" : false} onCheckedChange={(v) => setPicked(v === true ? new Set(objects.map((f) => f.key)) : new Set())} />
                </TableHead>
                <TableHead className="w-full">{sortButton("name", "Name")}</TableHead>
                <TableHead className="text-right">{sortButton("size", "Size", true)}</TableHead>
                <TableHead className="text-right">{sortButton("modified", "Modified", true)}</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {folders.map((folder) => (
                <TableRow key={folder} className="relative" data-row="">
                  <TableCell />
                  <TableCell colSpan={3} className="py-0">
                    <a href={href({ page: "storage", name: project, prefix: folder })} className="flex h-10 items-center gap-2 font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
                      {folder === PUBLIC_PREFIX ? <Globe className="size-4 text-muted-foreground" aria-hidden /> : <Folder className="size-4 text-muted-foreground" aria-hidden />}
                      {baseName(folder)}
                      {folder === PUBLIC_PREFIX && (
                        <Badge tone="info" dot>
                          Public
                        </Badge>
                      )}
                    </a>
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
              {objects.slice(0, shown).map((file) => {
                const kind = kindOf(file.key);
                const Icon = KIND_ICONS[kind];
                const on = picked.has(file.key);
                return (
                  <TableRow key={file.key} data-row="" data-state={on ? "selected" : undefined} className="group/row">
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${baseName(file.key)}`}
                        checked={on}
                        onCheckedChange={(v) =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (v === true) n.add(file.key);
                            else n.delete(file.key);
                            return n;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="py-1">
                      <button type="button" onClick={() => setOpen(file)} className="flex max-w-full items-center gap-2 rounded-sm text-left outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                        {kind === "image" ? <img src={fileUrl(project, file.key)} alt="" loading="lazy" decoding="async" className="size-5 shrink-0 rounded-sm border object-cover" /> : <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                        <span className="truncate">{baseName(file.key)}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground tabular-nums">{formatBytes(file.size)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground">{file.lastModified && <TimeAgo iso={file.lastModified} />}</TableCell>
                    <TableCell className="py-1">
                      <span className="flex justify-end">
                        <span className="flex opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                          <IconButton label={`Copy key of ${baseName(file.key)}`} onClick={() => void copyText(file.key).then(() => toast.success("Copied key"))}>
                            <Copy />
                          </IconButton>
                          {isPublic(file.key) && (
                            <IconButton label="Copy public link" onClick={() => copyPublicLink(file.key)}>
                              <Link />
                            </IconButton>
                          )}
                          <InlineDelete label={`Delete ${baseName(file.key)}`} onDelete={() => remove(file.key)} />
                        </span>
                        <IconButton label={`Download ${baseName(file.key)}`} href={fileUrl(project, file.key)}>
                          <Download />
                        </IconButton>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
              {folders.length + objects.length === 0 && <TableEmpty colSpan={5}>Nothing here matches "{filter.trim()}".</TableEmpty>}
            </TableBody>
          </Table>
          {objects.length > shown && (
            <div className="flex items-center gap-3 py-3">
              <span className="text-muted-foreground">
                Showing {shown.toLocaleString()} of {objects.length.toLocaleString()} files
              </span>
              <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            </div>
          )}
        </div>
        <ConfirmDialog
          open={bulkDelete}
          onOpenChange={setBulkDelete}
          title={`Delete ${plural(pickedFiles.length, "file", "files")} from ${prefix || bucket}`}
          description="They're permanently deleted, and links to them stop working. This can't be undone."
          confirm={`Delete ${pickedFiles.length}`}
          pendingLabel="Deleting…"
          onConfirm={async () => {
            let done = 0;
            try {
              for (const f of pickedFiles) {
                await remove(f.key);
                done++;
              }
            } finally {
              if (done) toast.success(`Deleted ${plural(done, "file", "files")}`);
              setPicked(new Set());
            }
          }}
        />
      </>
    );
  }

  const count = state.status === "ready" ? state.listing.folders.length + state.listing.files.length : null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Breadcrumb project={project} bucket={bucket} prefix={prefix} />
        <div className="flex flex-wrap items-center gap-2">
          {count !== null && count > 0 && (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" data-filter="" aria-label="Filter this folder" placeholder={`Filter ${plural(count, "item", "items")}`} value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 w-52 pl-8" />
            </div>
          )}
          <LiveIndicator load={load} />
          <Button variant="outline" size="sm" onClick={() => setNewFolderOpen(true)}>
            <FolderPlus />
            New folder
          </Button>
        </div>
      </div>
      {body}
      <NewFolderDialog open={newFolderOpen} onOpenChange={setNewFolderOpen} onCreate={(name) => onNavigate(`${prefix}${name}/`)} />
      {open && <FileInspector project={project} file={open} publicUrl={publicUrl} onClose={() => setOpen(null)} onDelete={remove} />}
    </div>
  );
}

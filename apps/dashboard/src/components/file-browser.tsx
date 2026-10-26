import { Download, File as FileIcon, Folder, FolderPlus, Link, RotateCw, Trash2 } from "lucide-react";
import { useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { PUBLIC_PREFIX, type StorageFile } from "@mybase/shared";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, fileUrl } from "@/lib/api";
import type { useFiles } from "@/lib/files";
import { formatBytes, formatDate, timeAgo } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

/** The last path segment: "a/b/c.txt" → "c.txt", "a/b/" → "b". */
const baseName = (key: string) => key.replace(/\/$/, "").split("/").pop() ?? key;

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

/** Breadcrumb from the bucket root to the current folder; every level is a link. */
function Breadcrumb({ project, bucket, prefix }: { project: string; bucket: string; prefix: string }) {
  const parts = prefix.split("/").filter(Boolean);
  const link = (to: string) => href({ page: "project", name: project, prefix: to });
  return (
    <nav aria-label="Folder" className="min-w-0 truncate font-mono text-xs">
      <a href={link("")} className="text-muted-foreground hover:text-foreground" aria-current={parts.length === 0 ? "page" : undefined}>
        {bucket}
      </a>
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={i}>
            <span className="px-1 text-muted-foreground">/</span>
            <a
              href={link(parts.slice(0, i + 1).join("/") + "/")}
              className={last ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
              aria-current={last ? "page" : undefined}
            >
              {part}
            </a>
          </span>
        );
      })}
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
    if (!name || name.includes("/") || name === "." || name === "..") {
      setError("Use a name without slashes, other than . or ..");
      return;
    }
    close(false);
    onCreate(name);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Folders are part of each file's path. This one appears once you upload a file into it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              name="folder"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "folder-error" : undefined}
            />
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

function DeleteFileDialog({ file, onOpenChange, onDelete }: { file: StorageFile | null; onOpenChange: (open: boolean) => void; onDelete: (key: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const close = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function confirm() {
    if (!file) return;
    setPending(true);
    setError(null);
    try {
      await onDelete(file.key);
      close(false);
      toast.success(`Deleted ${baseName(file.key)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={file !== null} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Delete file</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{file?.key}</span> will be permanently deleted. Links to it stop working.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={confirm}>
            {pending ? "Deleting…" : "Delete file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One folder of a project's bucket: navigate, upload by drop, download, share, delete. */
export function FileBrowser({
  project,
  bucket,
  publicUrl,
  prefix,
  files,
  onNavigate,
}: {
  project: string;
  bucket: string;
  publicUrl: string;
  prefix: string;
  files: ReturnType<typeof useFiles>;
  onNavigate: (prefix: string) => void;
}) {
  const { state, refresh, upload, uploadError, remove } = files;
  const [dragging, setDragging] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [toDelete, setToDelete] = useState<StorageFile | null>(null);

  async function copyPublicLink(key: string) {
    const url = publicUrl + key.slice(PUBLIC_PREFIX.length).split("/").map(encodeURIComponent).join("/");
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied public link");
    } catch {
      toast.error(`Couldn't copy. The link is ${url}`);
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const count = await upload(Array.from(e.dataTransfer.files));
    if (count > 0) toast.success(`Uploaded ${count} ${count === 1 ? "file" : "files"}`);
  }

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop,
  };

  const toolbar = (
    <div className="mb-3 flex items-center justify-between gap-4">
      <Breadcrumb project={project} bucket={bucket} prefix={prefix} />
      <Button variant="outline" size="sm" onClick={() => setNewFolderOpen(true)}>
        <FolderPlus />
        New folder
      </Button>
    </div>
  );

  let body;
  if (state.status === "loading") {
    body = (
      <div className="grid gap-3 py-2" aria-busy="true" aria-label="Loading files">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full max-w-md" />
        ))}
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <div role="alert" className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Can't list files</p>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={refresh}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  } else if (state.listing.folders.length === 0 && state.listing.files.length === 0) {
    body = (
      <div className={cn("rounded-lg border border-dashed p-5", dragging && "border-foreground/40 bg-accent")}>
        <p className="font-medium">{prefix ? "This folder is empty" : "No files yet"}</p>
        <p className="mt-1 max-w-prose text-muted-foreground">
          Drop files here or use Upload files. Anything in the <span className="font-mono">public</span> folder can be read by anyone with its link.
        </p>
      </div>
    );
  } else {
    const { folders, files: objects } = state.listing;
    body = (
      <div className={cn("rounded-lg border border-transparent", dragging && "border-dashed border-foreground/40 bg-accent")}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-full text-muted-foreground">Name</TableHead>
              <TableHead className="text-right text-muted-foreground">Size</TableHead>
              <TableHead className="text-right text-muted-foreground">Modified</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folders.map((folder) => (
              <TableRow key={folder}>
                <TableCell colSpan={4} className="py-0">
                  <a
                    href={href({ page: "project", name: project, prefix: folder })}
                    className="flex h-10 items-center gap-2 font-medium outline-none focus-visible:underline"
                  >
                    <Folder className="size-4 text-muted-foreground" />
                    {baseName(folder)}
                  </a>
                </TableCell>
              </TableRow>
            ))}
            {objects.map((file) => (
              <TableRow key={file.key}>
                <TableCell className="py-1">
                  <span className="flex items-center gap-2">
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{baseName(file.key)}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground">{formatBytes(file.size)}</TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                  {file.lastModified && (
                    <time dateTime={file.lastModified} title={formatDate(file.lastModified)}>
                      {timeAgo(file.lastModified)}
                    </time>
                  )}
                </TableCell>
                <TableCell className="py-1">
                  <span className="flex justify-end">
                    {file.key.startsWith(PUBLIC_PREFIX) && (
                      <IconButton label="Copy public link" onClick={() => copyPublicLink(file.key)}>
                        <Link />
                      </IconButton>
                    )}
                    <IconButton label="Download" href={fileUrl(project, file.key)}>
                      <Download />
                    </IconButton>
                    <IconButton label="Delete" onClick={() => setToDelete(file)}>
                      <Trash2 />
                    </IconButton>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div {...dropProps}>
      {toolbar}
      {uploadError && (
        <p role="alert" className="mb-3 text-destructive">
          {uploadError}
        </p>
      )}
      {body}
      <NewFolderDialog open={newFolderOpen} onOpenChange={setNewFolderOpen} onCreate={(name) => onNavigate(`${prefix}${name}/`)} />
      <DeleteFileDialog file={toDelete} onOpenChange={(open) => !open && setToDelete(null)} onDelete={remove} />
    </div>
  );
}

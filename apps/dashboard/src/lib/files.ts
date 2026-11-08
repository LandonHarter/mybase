import { useCallback, useEffect, useRef, useState } from "react";
import type { ListFilesResponse } from "@mybase/shared";
import { api, errorMessage, isAbortError } from "./api";
import { invalidate, useLoad, type LoadState } from "./load";

export type FilesState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; listing: ListFilesResponse };

/** What to do with a file whose name already exists in the destination folder. */
export type Collision = "replace" | "skip" | "rename";

/** Asks the user once for a batch: the names that clash with files already in the folder. */
export type ResolveCollisions = (names: string[]) => Promise<Collision | null>;

/** A file to upload with its path relative to the drop (folder drops keep their structure). */
export interface UploadInput {
  file: File;
  path: string;
}

/** One file in the upload tray (ST05). */
export interface UploadItem {
  id: number;
  /** Full key it's uploaded to. */
  key: string;
  file: File;
  loaded: number;
  status: "queued" | "uploading" | "done" | "failed" | "cancelled";
  error: string | null;
}

const filesKey = (project: string, prefix: string) => `files:${project}:${prefix}`;

/** "photo.png" → "photo (1).png", the first name not in `taken`. */
export function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Files from a drop, walking dropped folders so their structure is kept. */
export async function droppedFiles(data: DataTransfer): Promise<UploadInput[]> {
  const entries = Array.from(data.items)
    .map((i) => (i.kind === "file" ? (i.webkitGetAsEntry?.() ?? null) : null))
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return Array.from(data.files).map((file) => ({ file, path: file.name }));
  const out: UploadInput[] = [];
  async function walk(entry: FileSystemEntry, base: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: base + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches until an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${base}${entry.name}/`);
      }
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}

/** Above this, a request through Cloudflare's free tunnel is refused (100 MB). */
export const PROXY_LIMIT = 100 * 1000 * 1000;

/** One folder of a project's bucket, plus the actions that change it and the upload tray. */
export function useFiles(project: string, prefix: string) {
  const load = useLoad(filesKey(project, prefix), () => api.listFiles(project, prefix));
  const state: FilesState =
    load.state.status === "ready" ? { status: "ready", listing: load.state.data } : (load.state as Exclude<LoadState<ListFilesResponse>, { status: "ready" }>);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const listingRef = useRef<{ prefix: string; listing: ListFilesResponse | undefined }>({ prefix, listing: undefined });
  listingRef.current = { prefix, listing: load.data };
  const controllers = useRef(new Map<number, AbortController>());
  const nextId = useRef(1);
  const running = useRef(false);
  const queue = useRef<UploadItem[]>([]);

  const patch = useCallback((id: number, p: Partial<UploadItem>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...p } : u))), []);

  // One upload at a time per bucket (C13): a queue drained in order.
  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length > 0) {
        const item = queue.current.shift()!;
        const controller = new AbortController();
        controllers.current.set(item.id, controller);
        patch(item.id, { status: "uploading", loaded: 0, error: null });
        try {
          await api.uploadFileWithProgress(project, item.key, item.file, (loaded) => patch(item.id, { loaded }), controller.signal);
          patch(item.id, { status: "done", loaded: item.file.size });
        } catch (err) {
          patch(item.id, isAbortError(err) ? { status: "cancelled" } : { status: "failed", error: errorMessage(err) });
        } finally {
          controllers.current.delete(item.id);
          const folder = item.key.slice(0, item.key.lastIndexOf("/") + 1);
          invalidate(filesKey(project, folder));
          // Parent folders of a dropped folder gain a subfolder.
          invalidate(`files:${project}:`);
        }
      }
    } finally {
      running.current = false;
    }
  }, [project, patch]);

  useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.abort();
    },
    [],
  );

  /**
   * Queues files into `prefix` as it was when called (navigating away doesn't move the batch).
   * Names that clash with the loaded listing go through `resolve` first; no extra requests.
   * Returns how many were queued.
   */
  const upload = useCallback(
    async (inputs: (File | UploadInput)[], resolve?: ResolveCollisions) => {
      const items = inputs.map((x) => ("file" in x && "path" in x ? x : { file: x as File, path: (x as File).name }));
      if (items.length === 0) return 0;
      const target = prefix;
      const listing = listingRef.current.prefix === target ? listingRef.current.listing : undefined;
      const existing = new Set((listing?.files ?? []).map((f) => f.key.slice(target.length)));
      const clashes = items.filter((i) => existing.has(i.path)).map((i) => i.path);
      let choice: Collision = "replace";
      if (clashes.length > 0 && resolve) {
        const picked = await resolve(clashes);
        if (picked === null) return 0;
        choice = picked;
      }
      const taken = new Set(existing);
      const planned: UploadItem[] = [];
      for (const { file, path } of items) {
        let name = path;
        if (existing.has(path)) {
          if (choice === "skip") continue;
          if (choice === "rename") name = freeName(path, taken);
        }
        taken.add(name);
        planned.push({ id: nextId.current++, key: target + name, file, loaded: 0, status: "queued", error: null });
      }
      setUploads((list) => [...list.filter((u) => u.status !== "done"), ...planned]);
      queue.current.push(...planned);
      void drain();
      return planned.length;
    },
    [prefix, drain],
  );

  const cancel = useCallback(
    (id: number) => {
      controllers.current.get(id)?.abort();
      queue.current = queue.current.filter((u) => u.id !== id);
      patch(id, { status: "cancelled" });
    },
    [patch],
  );

  const retry = useCallback(
    (id?: number) => {
      setUploads((list) => {
        const again = list.filter((u) => (id === undefined ? u.status === "failed" || u.status === "cancelled" : u.id === id));
        queue.current.push(...again.map((u) => ({ ...u, status: "queued" as const, error: null, loaded: 0 })));
        void drain();
        return list.map((u) => (again.some((a) => a.id === u.id) ? { ...u, status: "queued", error: null, loaded: 0 } : u));
      });
    },
    [drain],
  );

  const clearUploads = useCallback(() => setUploads((list) => list.filter((u) => u.status === "uploading" || u.status === "queued")), []);

  const remove = useCallback(
    async (key: string) => {
      await api.deleteFile(project, key);
      invalidate(`files:${project}:`);
    },
    [project],
  );

  const active = uploads.filter((u) => u.status === "uploading" || u.status === "queued");
  return { state, refresh: load.refresh, load, upload, uploads, active, cancel, retry, clearUploads, remove };
}

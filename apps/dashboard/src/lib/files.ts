import { useCallback, useRef, useState } from "react";
import type { ListFilesResponse } from "@mybase/shared";
import { api, errorMessage } from "./api";
import { invalidate, useLoad, type LoadState } from "./load";

export type FilesState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; listing: ListFilesResponse };

/** What to do with a file whose name already exists in the destination folder. */
export type Collision = "replace" | "skip" | "rename";

/** Asks the user once for a batch: the names that clash with files already in the folder. */
export type ResolveCollisions = (names: string[]) => Promise<Collision | null>;

export interface UploadProgress {
  done: number;
  total: number;
  /** Folder the batch is going into (captured when the upload started). */
  prefix: string;
}

const filesKey = (project: string, prefix: string) => `files:${project}:${prefix}`;

// One upload at a time per bucket, so two batches can't race on the same names.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(project: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(project) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    project,
    next.catch(() => undefined),
  );
  return next;
}

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

/** One folder of a project's bucket, plus the actions that change it. */
export function useFiles(project: string, prefix: string) {
  const load = useLoad(filesKey(project, prefix), () => api.listFiles(project, prefix));
  const state: FilesState =
    load.state.status === "ready" ? { status: "ready", listing: load.state.data } : (load.state as Exclude<LoadState<ListFilesResponse>, { status: "ready" }>);
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const listingRef = useRef<{ prefix: string; listing: ListFilesResponse | undefined }>({ prefix, listing: undefined });
  listingRef.current = { prefix, listing: load.data };

  const refresh = load.refresh;

  /**
   * Uploads one at a time into `prefix` as it was when called (navigating away doesn't move the
   * batch). Names that clash with the loaded listing go through `resolve` first; no extra requests.
   * Returns how many were uploaded.
   */
  const upload = useCallback(
    (files: File[], resolve?: ResolveCollisions) =>
      serialized(project, async () => {
        if (files.length === 0) return 0;
        const target = prefix;
        setUploadError(null);
        const listing = listingRef.current.prefix === target ? listingRef.current.listing : undefined;
        const existing = new Set((listing?.files ?? []).map((f) => f.key.slice(target.length)));
        const clashes = files.filter((f) => existing.has(f.name)).map((f) => f.name);
        let choice: Collision = "replace";
        if (clashes.length > 0 && resolve) {
          const picked = await resolve(clashes);
          if (picked === null) return 0;
          choice = picked;
        }
        const taken = new Set(existing);
        const plan: { file: File; name: string }[] = [];
        for (const file of files) {
          if (existing.has(file.name)) {
            if (choice === "skip") continue;
            if (choice === "rename") {
              const name = freeName(file.name, taken);
              taken.add(name);
              plan.push({ file, name });
              continue;
            }
          }
          taken.add(file.name);
          plan.push({ file, name: file.name });
        }
        let done = 0;
        try {
          for (const { file, name } of plan) {
            setUploading({ done, total: plan.length, prefix: target });
            await api.uploadFile(project, target + name, file);
            done++;
          }
        } catch (err) {
          setUploadError(`Couldn't upload ${plan[done]!.name} to ${target || "the bucket root"}: ${errorMessage(err)}`);
        } finally {
          setUploading(null);
          invalidate(filesKey(project, target));
        }
        return done;
      }),
    [project, prefix],
  );

  const remove = useCallback(
    async (key: string) => {
      await api.deleteFile(project, key);
      invalidate(`files:${project}:`);
    },
    [project],
  );

  return { state, refresh, upload, uploading, uploadError, remove, updatedAt: load.updatedAt, refreshing: load.refreshing, refreshError: load.refreshError };
}

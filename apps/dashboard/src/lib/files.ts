import { useCallback, useEffect, useState } from "react";
import type { ListFilesResponse } from "@mybase/shared";
import { api, ApiError } from "./api";

export type FilesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: ListFilesResponse };

const message = (err: unknown) => (err instanceof ApiError ? err.message : "Can't reach the API. Check that it's running, then try again.");

/** One folder of a project's bucket, plus the actions that change it. */
export function useFiles(project: string, prefix: string) {
  const [state, setState] = useState<FilesState>({ status: "loading" });
  // "Uploading 2 of 5" while an upload runs.
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState({ status: "ready", listing: await api.listFiles(project, prefix) });
    } catch (err) {
      setState({ status: "error", message: message(err) });
    }
  }, [project, prefix]);

  useEffect(() => {
    setState({ status: "loading" });
    setUploadError(null);
    void refresh();
  }, [refresh]);

  /** Uploads one at a time into the current folder; returns how many succeeded. */
  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return 0;
      setUploadError(null);
      let done = 0;
      try {
        for (const file of files) {
          setUploading({ done, total: files.length });
          await api.uploadFile(project, prefix + file.name, file);
          done++;
        }
      } catch (err) {
        setUploadError(`Couldn't upload ${files[done]!.name}: ${message(err)}`);
      } finally {
        setUploading(null);
        await refresh();
      }
      return done;
    },
    [project, prefix, refresh],
  );

  const remove = useCallback(
    async (key: string) => {
      await api.deleteFile(project, key);
      await refresh();
    },
    [project, refresh],
  );

  return { state, refresh, upload, uploading, uploadError, remove };
}

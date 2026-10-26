import type { CreateProjectRequest, CreateProjectResponse, ListFilesResponse, Project } from "@mybase/shared";

// Same origin: the API serves the dashboard in Docker, and the dev server proxies to it.
const API_URL = "";

/** Thrown when the API answered with an error; `message` is safe to show. */
export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Encodes each segment of an object key, keeping the `/` separators. */
const keyPath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** Where the browser downloads a file from, through the API. */
export const fileUrl = (project: string, key: string) => `${API_URL}/projects/${project}/files/${keyPath(key)}`;

export const api = {
  listProjects: () => request<Project[]>("/projects"),
  createProject: (input: CreateProjectRequest) =>
    request<CreateProjectResponse>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  deleteProject: (name: string) => request<null>(`/projects/${name}`, { method: "DELETE" }),
  listFiles: (project: string, prefix: string) =>
    request<ListFilesResponse>(`/projects/${project}/files?prefix=${encodeURIComponent(prefix)}`),
  uploadFile: (project: string, key: string, file: File) =>
    request<{ key: string; size: number }>(fileUrl(project, key), {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  deleteFile: (project: string, key: string) => request<null>(fileUrl(project, key), { method: "DELETE" }),
};

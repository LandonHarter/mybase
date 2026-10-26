import { DEFAULT_API_URL, type CreateProjectRequest, type Project } from "@mybase/shared";

export const API_URL = DEFAULT_API_URL;

/** Thrown when the API answered with an error; `message` is safe to show. */
export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  listProjects: () => request<Project[]>("/projects"),
  createProject: (input: CreateProjectRequest) =>
    request<Project>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
};

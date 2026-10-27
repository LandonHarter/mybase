import { DEFAULT_API_URL } from "@mybase/shared";

const API_URL = process.env.MYBASE_API_URL ?? DEFAULT_API_URL;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}

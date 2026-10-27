import { DEFAULT_API_URL } from "@mybase/shared";
import { loadConfig } from "./config";

// Env vars win over the saved login, so CI can run `mybase cron sync` without one.
const config = await loadConfig();
export const API_URL = (process.env.MYBASE_API_URL || config.url || DEFAULT_API_URL).replace(/\/$/, "");
const TOKEN = process.env.MYBASE_TOKEN || config.token;

/** `url` and `token` override the configured ones (`mybase login` revoking an older login). */
export async function api<T>(path: string, init?: RequestInit & { url?: string; token?: string | null }): Promise<T> {
  const token = init?.token === undefined ? TOKEN : init.token;
  const base = init?.url ?? API_URL;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new Error(`can't reach the API at ${base}. Check that it's running, or point MYBASE_API_URL / \`mybase login --url\` at it.`);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    throw new Error(token ? "the API rejected your token. Run `mybase login` again." : "not signed in. Run `mybase login` (or set MYBASE_TOKEN).");
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}

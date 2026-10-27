import { DEFAULT_API_URL } from "@mybase/shared";
import pkg from "../package.json";
import { loadConfig } from "./config";
import { CliError } from "./output";

// Env vars win over the saved login, so CI can run `mybase cron sync` without one.
const config = await loadConfig();
export const API_URL = (process.env.MYBASE_API_URL || config.url || DEFAULT_API_URL).replace(/\/$/, "");
const TOKEN = process.env.MYBASE_TOKEN || config.token;
export const CLI_VERSION = pkg.version;

/** `url` and `token` override the configured ones (`mybase login` revoking an older login). */
export async function api<T>(path: string, init?: RequestInit & { url?: string; token?: string | null; onStatus?: (status: number) => void }): Promise<T> {
  const token = init?.token === undefined ? TOKEN : init.token;
  const base = init?.url ?? API_URL;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "User-Agent": `mybase-cli/${CLI_VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new CliError(`can't reach the API at ${base}. Check that it's running, or point MYBASE_API_URL / \`mybase login --url\` at it.`);
  }
  init?.onStatus?.(res.status);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    const message = token ? "the API rejected your token. Run `mybase login` again." : "not signed in. Run `mybase login` (or set MYBASE_TOKEN).";
    throw new CliError(message, 3, 401);
  }
  if (!res.ok) throw new CliError((body as { error?: string }).error ?? res.statusText, res.status === 404 ? 4 : 1, res.status);
  return body as T;
}

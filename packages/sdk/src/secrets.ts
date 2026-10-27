// Secrets and config per environment, stored encrypted on mybase. Locally and in CI, the
// CLI injects them into your process (`mybase run -- bun start`); this client is for reading
// them at runtime instead, e.g. to pick up a rotated value without a restart.
//
//   const secrets = createSecretsClient({ apiUrl, project: "shop", env: "prod", apiKey: process.env.MYBASE_API_KEY! });
//   await secrets.load();                  // into process.env (existing vars win)
//   const stripe = await secrets.get("STRIPE_KEY");
import { MybaseApiError } from "./cron";

export { MybaseApiError };

/** `dev`, `staging`, `prod`, `prod_eu`, … */
export const SECRETS_ENV_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
export const SECRETS_ENV_RULES = "1–40 characters: lowercase letters, digits, _ or -, starting with a letter";

/** Env var names: `STRIPE_KEY`, `databaseUrl`, … */
export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SECRET_KEY_RULES = "1–128 characters: letters, digits, or _, not starting with a digit";

export const SECRETS_LIMITS = {
  /** Per value, UTF-8. */
  valueBytes: 64 * 1024,
  keysPerEnv: 1000,
  envsPerProject: 50,
  /** Older revisions are pruned. */
  revisionsKept: 200,
  messageLength: 200,
} as const;

/** Every project starts with these (they can be renamed or deleted). */
export const DEFAULT_SECRETS_ENVS = ["dev", "staging", "prod"] as const;

/**
 * Keys `mybase secrets link` writes and keeps up to date. Read-only elsewhere: running link
 * again rotates them.
 */
export const MANAGED_SECRET_KEYS = [
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "REDIS_URL",
  "MYBASE_URL",
  "MYBASE_PROJECT",
] as const;

// ---- wire types -------------------------------------------------------------

export interface SecretsEnv {
  name: string;
  /** Branch envs inherit every key of their parent (a root env) and override some. */
  parent: string | null;
  /** Bumped on every change. */
  revision: number;
  /** Own keys, not counting inherited ones. */
  keys: number;
  /** Holds the project's credentials (`mybase secrets link`). */
  linked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /projects/<project>/secrets`. Only envs the caller's key may read are listed. */
export interface SecretsOverview {
  envs: SecretsEnv[];
  apiUrl: string;
  enabledAt: string;
}

export interface SecretEntry {
  key: string;
  /** Only when values were asked for. */
  value?: string;
  /** Written by `mybase secrets link`. */
  managed: boolean;
  /** From the parent env (a branch env hasn't overridden it). */
  inherited: boolean;
  updatedAt: string;
}

export interface SecretsEnvDetail {
  env: SecretsEnv;
  secrets: SecretEntry[];
}

export interface CreateSecretsEnvRequest {
  name: string;
  /** Makes a branch env of this root env. */
  parent?: string | null;
}

export interface UpdateSecretsRequest {
  set?: Record<string, string>;
  unset?: string[];
  /** Shown in the history. */
  message?: string;
}

export interface UpdateSecretsResponse {
  /** The env's revision after the change (unchanged when nothing changed). */
  revision: number;
  changed: number;
}

export type SecretChangeAction = "added" | "changed" | "removed";

export interface SecretChange {
  key: string;
  action: SecretChangeAction;
  managed: boolean;
  /** Only when values were asked for. */
  oldValue?: string | null;
  newValue?: string | null;
}

export interface SecretsRevision {
  revision: number;
  /** `admin`, `key:<name>`, or `link`. */
  actor: string;
  message: string | null;
  createdAt: string;
  changes: SecretChange[];
}

/** `GET /secrets/<project>/<env>`: every key resolved, branch overrides applied. */
export interface SecretsResponse {
  env: string;
  /** Changes whenever any value (own or inherited) may have changed. Also sent as the ETag. */
  version: string;
  secrets: Record<string, string>;
}

export interface LinkCredentialsRequest {
  envs: string[];
}

export interface LinkCredentialsResponse {
  /** Every env now holding the credentials (earlier links included). */
  envs: string[];
  keys: string[];
}

// ---- client -----------------------------------------------------------------

export interface SecretsClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** `dev`, `prod`, a branch env, … */
  env: string;
  /** A mybase API key (`mb_…`) with `secrets:read` for this project (and env, if it's env-scoped). Server-side only. */
  apiKey: string;
  /** Reuse fetched secrets this long without asking mybase, in ms. Default 0: every read revalidates (a 304 when nothing changed). */
  maxAgeMs?: number;
  /** Default 10000. */
  timeoutMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface SecretsClient {
  /** Every key in the env, inherited ones included. */
  all(): Promise<Record<string, string>>;
  /** One value, or undefined when the key isn't set. */
  get(key: string): Promise<string | undefined>;
  /** Copies the secrets into `process.env`. Existing vars win unless `override`. Returns the keys set. */
  load(options?: { override?: boolean }): Promise<string[]>;
  /** Needs `secrets:write`. One revision in the history. */
  set(values: Record<string, string>, options?: { message?: string }): Promise<UpdateSecretsResponse>;
  unset(keys: string | string[], options?: { message?: string }): Promise<UpdateSecretsResponse>;
}

export function createSecretsClient(options: SecretsClientOptions): SecretsClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/secrets/${encodeURIComponent(options.project)}/${encodeURIComponent(options.env)}`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAgeMs = options.maxAgeMs ?? 0;
  const headers = { Authorization: `Bearer ${options.apiKey}` };
  let cached: { etag: string | null; secrets: Record<string, string>; at: number } | undefined;

  async function fail(res: Response): Promise<never> {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
  }

  async function all(): Promise<Record<string, string>> {
    if (cached && Date.now() - cached.at < maxAgeMs) return { ...cached.secrets };
    const res = await doFetch(url, {
      headers: cached?.etag ? { ...headers, "If-None-Match": cached.etag } : headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 304 && cached) {
      cached.at = Date.now();
      return { ...cached.secrets };
    }
    if (!res.ok) return fail(res);
    const data = (await res.json()) as SecretsResponse;
    cached = { etag: res.headers.get("ETag"), secrets: data.secrets, at: Date.now() };
    return { ...data.secrets };
  }

  async function update(body: UpdateSecretsRequest): Promise<UpdateSecretsResponse> {
    const res = await doFetch(url, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { ...headers, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fail(res);
    cached = undefined;
    return (await res.json()) as UpdateSecretsResponse;
  }

  return {
    all,
    get: async (key) => (await all())[key],
    async load({ override = false } = {}) {
      const secrets = await all();
      const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
      if (!env) throw new Error("load() needs process.env (Node, Bun, Deno); use all() elsewhere");
      const set: string[] = [];
      for (const [key, value] of Object.entries(secrets)) {
        if (!override && env[key] !== undefined) continue;
        env[key] = value;
        set.push(key);
      }
      return set;
    },
    set: (values, opts = {}) => update({ set: values, message: opts.message }),
    unset: (keys, opts = {}) => update({ unset: [keys].flat(), message: opts.message }),
  };
}

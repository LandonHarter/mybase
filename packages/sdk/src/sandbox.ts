// Provider-neutral agent compute. Model keys and agent loops stay in the calling app.
import { MybaseApiError } from "./cron";
export { MybaseApiError };

export type SandboxState = "queued" | "provisioning" | "ready" | "stopping" | "terminated" | "expired" | "failed";
export type ExecutionState = "queued" | "running" | "success" | "failed" | "timed_out" | "cancelled";
export interface CreateSandbox {
  profile?: "browser";
  /** Optional lifetime from admission. Omit or pass null for no expiry. */
  ttlSeconds?: number | null;
  /** Optional idle expiry. Omit or pass null to keep idle sandboxes alive. */
  idleSeconds?: number | null;
  /** Required for safely retrying creation. Unique within project, retained for 7 days. */
  key: string;
}
export interface Sandbox {
  id: string;
  project: string;
  profile: "browser";
  state: SandboxState;
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  resources: { cpus: number; memoryMb: number; workspaceMb: number; pids: number };
  runtimeMs: number;
  executions: number;
  artifactBytes: number;
}
export interface ExecuteSandbox {
  key: string;
  /** ESM JavaScript; playwright is installed. cwd is /workspace. */
  code?: string;
  /** Argument array, never implicitly passed to a shell. Exactly one of code/command. */
  command?: string[];
  /** Optional execution deadline. Omit or pass null for no timeout. */
  timeoutMs?: number | null;
}
export interface SandboxExecution {
  id: string;
  sandboxId: string;
  state: ExecutionState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface SandboxArtifact {
  id: string;
  sandboxId: string;
  project: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  expiresAt: string;
}
export interface SandboxBrowserConnection {
  /** Playwright chromium.connectOverCDP(endpoint, { headers }). Never put headers in URLs. */
  endpoint: string;
  headers: Record<string, string>;
  expiresAt: string;
  maxConnectionSeconds: number | null;
}
export interface SandboxUsage {
  active: number;
  allocatedSecondsToday: number;
  runtimeMsToday: number;
  executionsToday: number;
  artifactBytesToday: number;
  limits: { concurrency: null; dailyAllocatedSeconds: null; dailyArtifactBytes: null };
}
export interface SandboxClientOptions {
  apiUrl: string;
  project: string;
  apiKey: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
export interface SandboxClient {
  create(input: CreateSandbox, signal?: AbortSignal): Promise<Sandbox>;
  list(signal?: AbortSignal): Promise<Sandbox[]>;
  get(id: string, signal?: AbortSignal): Promise<Sandbox>;
  terminate(id: string, signal?: AbortSignal): Promise<Sandbox>;
  execute(id: string, input: ExecuteSandbox, signal?: AbortSignal): Promise<SandboxExecution>;
  execution(id: string, execution: string, signal?: AbortSignal): Promise<SandboxExecution>;
  executions(id: string, signal?: AbortSignal): Promise<SandboxExecution[]>;
  cancel(id: string, execution: string, signal?: AbortSignal): Promise<SandboxExecution>;
  upload(id: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  download(id: string, path: string, signal?: AbortSignal): Promise<Response>;
  exportArtifact(id: string, path: string, type?: string, signal?: AbortSignal): Promise<SandboxArtifact>;
  artifacts(id: string, signal?: AbortSignal): Promise<SandboxArtifact[]>;
  artifact(id: string, artifact: string, signal?: AbortSignal): Promise<Response>;
  browser(id: string, signal?: AbortSignal): Promise<SandboxBrowserConnection>;
  usage(signal?: AbortSignal): Promise<SandboxUsage>;
  wait(id: string, signal?: AbortSignal): Promise<Sandbox>;
  waitExecution(id: string, execution: string, signal?: AbortSignal): Promise<SandboxExecution>;
}

export function createSandboxClient(options: SandboxClientOptions): SandboxClient {
  const base = `${options.apiUrl.replace(/\/+$/, "")}/sandbox/${encodeURIComponent(options.project)}`;
  const enc = encodeURIComponent;
  async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal, binary = false): Promise<any> {
    const res = await (options.fetch ?? globalThis.fetch)(base + path, {
      method,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]) : AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    }
    return binary ? res : res.status === 204 ? undefined : res.json();
  }
  const root = (id: string) => `/${enc(id)}`;
  const execution = (id: string, run: string) => `${root(id)}/executions/${enc(run)}`;
  const client: SandboxClient = {
    create: (input, s) => request("", "POST", input, s),
    list: (s) => request("", "GET", undefined, s),
    get: (id, s) => request(root(id), "GET", undefined, s),
    terminate: (id, s) => request(root(id), "DELETE", undefined, s),
    execute: (id, input, s) => request(`${root(id)}/executions`, "POST", input, s),
    execution: (id, run, s) => request(execution(id, run), "GET", undefined, s),
    executions: (id, s) => request(`${root(id)}/executions`, "GET", undefined, s),
    cancel: (id, run, s) => request(execution(id, run), "DELETE", undefined, s),
    upload: (id, path, bytes, s) => request(`${root(id)}/files?path=${enc(path)}`, "PUT", bytes, s),
    download: (id, path, s) => request(`${root(id)}/files?path=${enc(path)}`, "GET", undefined, s, true),
    exportArtifact: (id, path, type, s) => request(`${root(id)}/artifacts`, "POST", { path, type }, s),
    artifacts: (id, s) => request(`${root(id)}/artifacts`, "GET", undefined, s),
    artifact: (id, artifact, s) => request(`${root(id)}/artifacts/${enc(artifact)}`, "GET", undefined, s, true),
    browser: async (id, s) => {
      const connection = await request(`${root(id)}/browser`, "POST", {}, s) as SandboxBrowserConnection;
      connection.headers.Authorization = `Bearer ${options.apiKey}`;
      return connection;
    },
    usage: (s) => request("/usage", "GET", undefined, s),
    async wait(id, signal) {
      for (;;) {
        const box = await client.get(id, signal);
        if (!["queued", "provisioning"].includes(box.state)) return box;
        await pause(signal);
      }
    },
    async waitExecution(id, run, signal) {
      for (;;) {
        const result = await client.execution(id, run, signal);
        if (!["queued", "running"].includes(result.state)) return result;
        await pause(signal);
      }
    },
  };
  return client;
}
function pause(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 500);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// Verifying and handling the calls mybase makes for cron jobs.
//
// mybase POSTs JSON (a CronRun) to the job's URL with
//   X-Mybase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// using the project's cron secret. Verify it before trusting the body. Uses Web Crypto
// only, so it runs in Bun, Node 20+, Deno, and edge runtimes.
//
// The other direction: `createCronClient` schedules one-off tasks (call this job once, at
// this time) by calling the mybase API, signed with the same secret (`signApiRequest`).
import { DEFAULT_CRON_PATH, type MybaseConfig } from "./config";

/** `schedule`: a cron tick. `manual`: "Run now". `task`: a one-off task scheduled with `createCronClient`. */
export type CronTrigger = "schedule" | "manual" | "task";

/** The body of every cron call. */
export interface CronRun<Job extends string = string> {
  job: Job;
  /** Same across retries of one run, so you can dedupe. */
  runId: string;
  /** 1 for the first try, then 2, 3, … on retries. */
  attempt: number;
  trigger: CronTrigger;
  /** When the schedule said to run (ISO). For manual runs, when it was requested. For tasks, the task's run time. */
  scheduledAt: string;
  /** When this attempt was sent (ISO). */
  firedAt: string;
  payload: unknown;
  /** Tasks only: the key the task was scheduled with, if any. `runId` is the task id. */
  key?: string | null;
}

export const SIGNATURE_HEADER = "X-Mybase-Signature";
export const JOB_HEADER = "X-Mybase-Job";
export const RUN_HEADER = "X-Mybase-Run";

/** Thrown when a request's signature is missing, malformed, stale, or wrong. */
export class CronVerificationError extends Error {
  override name = "CronVerificationError";
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares in time independent of where the strings first differ.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `X-Mybase-Signature` value for `body`. `t` is unix seconds (default: now). */
export async function signCronRequest(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

export interface VerifyOptions {
  /** The raw request body, exactly as received. */
  body: string;
  /** The `X-Mybase-Signature` header. */
  signature: string | null | undefined;
  /** The project's cron secret. Pass several while rotating (new first). */
  secret: string | readonly string[];
  /** Max age of the signature, in seconds. Default 300. */
  toleranceSec?: number;
}

/** Checks a `t=…,v1=…` header against the message for its `t`, with any of the secrets. */
async function verifySigned(
  signature: string | null | undefined,
  secret: string | readonly string[],
  toleranceSec: number,
  message: (t: number) => string,
): Promise<void> {
  if (!signature) throw new CronVerificationError(`missing ${SIGNATURE_HEADER} header`);
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of signature.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === undefined || sigs.length === 0) throw new CronVerificationError(`malformed ${SIGNATURE_HEADER} header`);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new CronVerificationError("signature timestamp outside tolerance");

  const secrets = typeof secret === "string" ? [secret] : secret;
  if (secrets.length === 0 || secrets.some((s) => !s)) throw new CronVerificationError("no cron secret configured");
  for (const s of secrets) {
    const expected = await hmacHex(s, message(t));
    if (sigs.some((sig) => safeEqual(sig, expected))) return;
  }
  throw new CronVerificationError("signature does not match");
}

/** Throws CronVerificationError unless `signature` signs `body` with one of the secrets, recently. */
export async function verifyCronSignature({ body, signature, secret, toleranceSec = 300 }: VerifyOptions): Promise<void> {
  await verifySigned(signature, secret, toleranceSec, (t) => `${t}.${body}`);
}

// ---- app → mybase -----------------------------------------------------------
//
// Calls from your app to the mybase API carry the same header, over a different message,
// so a signed cron call can never be replayed as an API call (or the reverse):
//   v1 = HMAC-SHA256(secret, `${t}.${METHOD} ${path}.${body}`)
// `path` is the API route (e.g. `/cron/shop/tasks`), without the query string.

const apiMessage = (t: number, method: string, path: string, body: string) => `${t}.${method.toUpperCase()} ${path}.${body}`;

/** The `X-Mybase-Signature` value for an API call from your app. */
export async function signApiRequest(secret: string, method: string, path: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, apiMessage(t, method, path, body))}`;
}

/** Server side of `signApiRequest`. Throws CronVerificationError. */
export async function verifyApiSignature(options: { method: string; path: string; body: string; signature: string | null | undefined; secret: string; toleranceSec?: number }): Promise<void> {
  const { method, path, body, signature, secret, toleranceSec = 300 } = options;
  await verifySigned(signature, secret, toleranceSec, (t) => apiMessage(t, method, path, body));
}

/** Verifies a Fetch API request and returns its parsed body. Consumes the body. */
export async function verifyCronRequest(req: Request, secret: string | readonly string[], options: { toleranceSec?: number } = {}): Promise<CronRun> {
  const body = await req.text();
  await verifyCronSignature({ body, signature: req.headers.get(SIGNATURE_HEADER), secret, ...options });
  let run: CronRun;
  try {
    run = JSON.parse(body);
  } catch {
    throw new CronVerificationError("body is not JSON");
  }
  if (typeof run?.job !== "string" || typeof run.runId !== "string") throw new CronVerificationError("body is not a cron run");
  return run;
}

/** Job names from a config type, or any string without one. */
type JobName<C extends MybaseConfig> = C extends { cron: { jobs: infer J } } ? Extract<keyof J, string> : string;

export type CronJobHandler<Job extends string = string> = (run: CronRun<Job>) => unknown | Promise<unknown>;

export interface CronHandlerOptions<C extends MybaseConfig> {
  /** The project's cron secret. Pass several while rotating (new first). */
  secret: string | readonly string[];
  /** A function per job name. */
  jobs: { [J in JobName<C>]: CronJobHandler<J> };
  /** Called when a job throws, before the 500 goes back (mybase then retries). */
  onError?: (err: unknown, run: CronRun) => void;
  toleranceSec?: number;
}

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A Fetch API handler (Bun.serve, Next.js route handlers, Hono, Deno, Workers) that verifies
 * the call and runs the named job. 401 bad signature, 404 unknown job, 500 job threw, 200 done.
 * Pass your config type for typed job names: `cronHandler<typeof config>({ ... })`.
 */
export function cronHandler<C extends MybaseConfig = MybaseConfig>(options: CronHandlerOptions<C>): (req: Request) => Promise<Response> {
  const jobs = options.jobs as unknown as Record<string, CronJobHandler>;
  return async (req) => {
    if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
    let run: CronRun;
    try {
      run = await verifyCronRequest(req, options.secret, { toleranceSec: options.toleranceSec });
    } catch (err) {
      if (err instanceof CronVerificationError) return reply({ error: err.message }, 401);
      throw err;
    }
    const job = Object.hasOwn(jobs, run.job) ? jobs[run.job] : undefined;
    if (!job) return reply({ error: `no handler for job "${run.job}"` }, 404);
    try {
      await job(run);
    } catch (err) {
      if (options.onError) options.onError(err, run);
      else console.error(`mybase cron job "${run.job}" failed`, err);
      return reply({ error: "job failed" }, 500);
    }
    return reply({ ok: true }, 200);
  };
}

// ---- one-off tasks ----------------------------------------------------------

export type CronTaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

/** A one-off call: mybase POSTs a CronRun (trigger `task`) to `url` once, at `runAt`. */
export interface CronTask {
  id: string;
  /** The handler name sent as `run.job`. */
  job: string;
  key: string | null;
  url: string;
  payload: unknown;
  runAt: string;
  timeoutMs: number;
  retries: number;
  status: CronTaskStatus;
  attempts: number;
  /** Last attempt's status; `null` before the call or when it got no response. */
  httpStatus: number | null;
  durationMs: number | null;
  error: string | null;
  /** Start of the last response body, truncated. */
  response: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What the API takes to create a task. Give `runAt` or `delayMs`, or neither to run as soon as possible. */
export interface CreateCronTaskRequest {
  job: string;
  url: string;
  runAt?: string;
  delayMs?: number;
  key?: string;
  payload?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export interface CronClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  /** The mybase project. */
  project: string;
  /** The project's cron secret (`MYBASE_CRON_SECRET`). */
  secret: string;
  /** Your app, as reachable from the mybase server. Tasks POST to `baseUrl` + `path` unless they set `url`. */
  baseUrl?: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface ScheduleOptions {
  /** When to run. */
  at?: Date | string;
  /** Or how long from now: milliseconds, or `"30s"`, `"15m"`, `"2h"`, `"7d"`. Neither `at` nor `in`: as soon as possible. */
  in?: number | string;
  /** JSON sent to your handler as `run.payload` (up to 16 KB). */
  payload?: unknown;
  /**
   * Dedupe key. While a task with this key is pending or running, scheduling the key again
   * returns that task instead of making a new one. Also lets you `get`/`cancel` by key.
   */
  key?: string;
  /** Appended to the client's `baseUrl`. Default `/api/cron`. */
  path?: string;
  /** Full URL to call instead of `baseUrl` + `path`. */
  url?: string;
  /** Extra tries after a failed call. 0–5, default 2. */
  retries?: number;
  /** 1000–120000, default 30000. */
  timeoutMs?: number;
}

/** A non-2xx answer from the mybase API. */
export class MybaseApiError extends Error {
  override name = "MybaseApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `1500`, `"30s"`, `"15m"`, `"2h"`, `"7d"` → milliseconds. */
export function parseDelay(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("delay must be a non-negative number of ms");
    return Math.round(value);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(value);
  if (!m) throw new RangeError(`invalid delay "${value}". Use ms, or a number with ms, s, m, h, or d (e.g. "15m")`);
  return Math.round(Number(m[1]) * UNITS[m[2]!]!);
}

export interface CronClient {
  /** Schedules `job` to be called once. Resolves to the new task (or the pending one with the same `key`). */
  schedule(job: string, options?: ScheduleOptions): Promise<CronTask>;
  /** A task by id, or `null` once it's gone (finished tasks are kept 7 days). */
  get(id: string): Promise<CronTask | null>;
  /** The newest task with this key, or `null`. */
  getByKey(key: string): Promise<CronTask | null>;
  /** Cancels a pending task. Resolves to the task, or `null` when there's no such task. Throws 409 if it already ran. */
  cancel(id: string): Promise<CronTask | null>;
  /** Cancels the pending task with this key. */
  cancelByKey(key: string): Promise<CronTask | null>;
}

/**
 * Schedules one-off calls to your cron handler from app code:
 *
 *   const cron = createCronClient({ apiUrl, project: "shop", secret, baseUrl: "https://shop.example.com" });
 *   await cron.schedule("send-reminder", { in: "24h", payload: { orderId }, key: `reminder-${orderId}` });
 *
 * Requests are signed with the cron secret; keep this server-side.
 */
export function createCronClient(options: CronClientOptions): CronClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const base = `/cron/${encodeURIComponent(options.project)}/tasks`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await doFetch(`${apiUrl}${path}`, {
      method,
      body: body === undefined ? undefined : raw,
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: await signApiRequest(options.secret, method, path, raw),
      },
    });
    if (res.status === 404 && method !== "POST") return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data as T;
  }

  const byId = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const byKey = (key: string) => `${base}/by-key/${encodeURIComponent(key)}`;

  return {
    async schedule(job, opts = {}) {
      if (opts.at !== undefined && opts.in !== undefined) throw new TypeError("give `at` or `in`, not both");
      let url = opts.url;
      if (!url) {
        if (!options.baseUrl) throw new TypeError("set `baseUrl` on the client, or `url` on the task");
        // Concatenated, not new URL(path, base), so a base path like https://x.dev/app is kept.
        url = `${options.baseUrl.replace(/\/+$/, "")}/${(opts.path ?? DEFAULT_CRON_PATH).replace(/^\/+/, "")}`;
      }
      const at = opts.at === undefined ? undefined : new Date(opts.at);
      if (at && Number.isNaN(at.getTime())) throw new RangeError(`invalid date "${String(opts.at)}"`);
      const req: CreateCronTaskRequest = {
        job,
        url,
        runAt: at?.toISOString(),
        // Sent as a delay so the server's clock decides when "in 15m" is.
        delayMs: opts.in === undefined ? undefined : parseDelay(opts.in),
        key: opts.key,
        payload: opts.payload,
        retries: opts.retries,
        timeoutMs: opts.timeoutMs,
      };
      return (await call<CronTask>("POST", base, req))!;
    },
    get: (id) => call<CronTask>("GET", byId(id)),
    getByKey: (key) => call<CronTask>("GET", byKey(key)),
    cancel: (id) => call<CronTask>("DELETE", byId(id)),
    cancelByKey: (key) => call<CronTask>("DELETE", byKey(key)),
  };
}

// Verifying and handling the calls mybase makes for cron jobs.
//
// mybase POSTs JSON (a CronRun) to the job's URL with
//   X-Mybase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// using the project's cron secret. Verify it before trusting the body. Uses Web Crypto
// only, so it runs in Bun, Node 20+, Deno, and edge runtimes.
import type { MybaseConfig } from "./config";

export type CronTrigger = "schedule" | "manual";

/** The body of every cron call. */
export interface CronRun<Job extends string = string> {
  job: Job;
  /** Same across retries of one run, so you can dedupe. */
  runId: string;
  /** 1 for the first try, then 2, 3, … on retries. */
  attempt: number;
  trigger: CronTrigger;
  /** When the schedule said to run (ISO). For manual runs, when it was requested. */
  scheduledAt: string;
  /** When this attempt was sent (ISO). */
  firedAt: string;
  payload: unknown;
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

/** Throws CronVerificationError unless `signature` signs `body` with one of the secrets, recently. */
export async function verifyCronSignature({ body, signature, secret, toleranceSec = 300 }: VerifyOptions): Promise<void> {
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
    const expected = await hmacHex(s, `${t}.${body}`);
    if (sigs.some((sig) => safeEqual(sig, expected))) return;
  }
  throw new CronVerificationError("signature does not match");
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

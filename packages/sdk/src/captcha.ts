// mybase's self-hosted captcha: proof of work instead of puzzles. The browser gets a signed
// challenge from the project, finds the number whose SHA-256 matches (a fraction of a second),
// and sends the answer with the form; your server checks it once with mybase.
//
//   // Browser (or use the script tag: <script src="https://mybase.example.com/captcha.js" data-project="shop">)
//   const token = await solveCaptcha({ apiUrl, project: "shop" });
//   await fetch("/signup", { method: "POST", headers: { "x-captcha-response": token }, body });
//
//   // Server
//   const captcha = createCaptchaClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   const { success } = await captcha.verify(token);
//
// With Better Auth, use `mybaseCaptcha()` from @mybase-dev/sdk/better-auth instead of verify().
// No cookies, no third party, nothing to see or click. Tokens work once and expire after 5 minutes.
import { MybaseApiError } from "./cron";

export { MybaseApiError };

export const CAPTCHA_LIMITS = {
  /** How long a challenge (and so its token) stays valid. */
  expiresMs: 5 * 60_000,
  /** The work: the browser tries up to this many numbers (half on average). */
  maxNumber: { min: 1_000, max: 1_000_000, default: 50_000 },
  tokenLength: 2_000,
} as const;

/** `GET /captcha/:project/challenge`. `salt` carries its expiry (`…?expires=<unix seconds>`). */
export interface CaptchaChallenge {
  algorithm: "SHA-256";
  challenge: string;
  salt: string;
  maxnumber: number;
  signature: string;
}

/** What `verify` answers. `error` says why a token was refused. */
export interface CaptchaVerifyResponse {
  success: boolean;
  error?: "invalid" | "expired" | "used" | "unavailable";
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The token for a solved challenge: base64 of the challenge plus the number found. */
export function encodeToken(c: CaptchaChallenge, number: number): string {
  const json = JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number, salt: c.salt, signature: c.signature });
  return btoa(json);
}

/** Finds the number. Rejects if none up to `maxnumber` matches, or when `signal` aborts. */
export async function solveChallenge(c: CaptchaChallenge, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
  if (c.algorithm !== "SHA-256") throw new Error(`mybase captcha: unknown algorithm ${c.algorithm}`);
  for (let n = 0; n <= c.maxnumber; n++) {
    if ((await sha256Hex(c.salt + n)) === c.challenge) return encodeToken(c, n);
    if (n % 1000 === 0 && signal?.aborted) throw signal.reason ?? new Error("aborted");
  }
  throw new Error("mybase captcha: challenge has no solution");
}

export interface SolveOptions {
  /** Where the mybase API is reachable from the browser. */
  apiUrl: string;
  project: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Fetches a challenge and solves it. Returns the token to send with the form. */
export async function solveCaptcha(options: SolveOptions): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(`${options.apiUrl.replace(/\/+$/, "")}/captcha/${encodeURIComponent(options.project)}/challenge`, { signal: options.signal });
  const body = (await res.json().catch(() => ({}))) as CaptchaChallenge & { error?: string };
  if (!res.ok) throw new MybaseApiError(body.error ?? `mybase API answered ${res.status}`, res.status);
  return solveChallenge(body, { signal: options.signal });
}

export interface CaptchaClientOptions {
  apiUrl: string;
  project: string;
  /** A mybase API key with `captcha:write` for this project. Server-side only. */
  apiKey: string;
  fetch?: typeof fetch;
}

export interface CaptchaClient {
  /** Checks a token once. A second check of the same token fails with `used`. */
  verify(token: string): Promise<CaptchaVerifyResponse>;
}

export function createCaptchaClient(options: CaptchaClientOptions): CaptchaClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/captcha/${encodeURIComponent(options.project)}/verify`;
  return {
    async verify(token) {
      if (typeof token !== "string" || !token || token.length > CAPTCHA_LIMITS.tokenLength) return { success: false, error: "invalid" };
      const res = await doFetch(url, {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      });
      const body = (await res.json().catch(() => ({}))) as CaptchaVerifyResponse & { error?: string };
      if (!res.ok) throw new MybaseApiError((body as { error?: string }).error ?? `mybase API answered ${res.status}`, res.status);
      return body;
    },
  };
}

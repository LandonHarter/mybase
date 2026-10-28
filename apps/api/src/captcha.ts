// The captcha service: proof-of-work bot checks for a project's forms (ALTCHA-style).
// A challenge is stateless: salt (with its expiry) + sha256(salt + secret number) + an HMAC of
// that hash under the project's key, so only this server could have issued it. The browser finds
// the number; verifying checks the HMAC, the expiry, and the hash, then marks the challenge used
// in Valkey (`SET NX`) so a token works once. Valkey down → tokens are refused (fail closed).
//
// Two ways to verify: `POST /captcha/:project/verify` with an API key (SDK), and
// `POST /captcha/:project/siteverify` with the project's captcha secret in Cloudflare Turnstile's
// format, which is what Better Auth's captcha plugin calls (`mybaseCaptcha()` in the SDK).
// The secret only lets a server check tokens (it can't make them), so it's stored and shown
// like the cron secret.
import type { CaptchaChallenge, CaptchaSettings, CaptchaVerifyResponse } from "@mybase/shared";
import { CAPTCHA_LIMITS, sha256Hex } from "@mybase-dev/sdk/captcha";
import type { Logger } from "@mybase/shared/logger";
import { BadRequestError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";
import { send } from "./valkey";

const publicApiUrl = () => (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");
const newSecret = () => `mbcap_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
const usedKey = (project: string, signature: string) => `mybase:captcha:${project}:${signature}`;

interface ProjectRow {
  hmacKey: CryptoKey;
  secret: string;
  maxNumber: number;
}

// Per-project settings, cached: every challenge and check needs them.
const cache = new Map<string, ProjectRow>();

export const captchaService: ServiceModule = {
  id: "captcha",
  async enable(project, log) {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    await sql`
      insert into mybase.captcha_projects (project, hmac_key, secret, max_number)
      values (${project}, ${key}, ${newSecret()}, ${CAPTCHA_LIMITS.maxNumber.default}) on conflict do nothing`;
    log.info("captcha enabled");
  },
  async disable(project, log) {
    await sql`delete from mybase.captcha_projects where project = ${project}`;
    cache.delete(project);
    log.info("captcha disabled");
  },
};

async function projectRow(project: string): Promise<ProjectRow> {
  const cached = cache.get(project);
  if (cached) return cached;
  const [row]: { hmac_key: Buffer; secret: string; max_number: number }[] = await sql`
    select hmac_key, secret, max_number from mybase.captcha_projects where project = ${project}`;
  if (!row) throw new NotFoundError("captcha is not enabled for this project");
  const hmacKey = await crypto.subtle.importKey("raw", new Uint8Array(row.hmac_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const loaded = { hmacKey, secret: row.secret, maxNumber: row.max_number };
  cache.set(project, loaded);
  return loaded;
}

export const requireEnabled = (project: string) => projectRow(project);

const hmacHex = async (key: CryptoKey, text: string) => Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))).toString("hex");

/** Constant-time string comparison. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh challenge. `now` and `number` are for tests. */
export async function createChallenge(project: string, now = Date.now(), number?: number): Promise<CaptchaChallenge> {
  const { hmacKey, maxNumber } = await projectRow(project);
  const expires = Math.floor((now + CAPTCHA_LIMITS.expiresMs) / 1000);
  const salt = `${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}?expires=${expires}`;
  const secretNumber = number ?? crypto.getRandomValues(new Uint32Array(1))[0]! % (maxNumber + 1);
  const challenge = await sha256Hex(salt + secretNumber);
  return { algorithm: "SHA-256", challenge, salt, maxnumber: maxNumber, signature: await hmacHex(hmacKey, challenge) };
}

interface Payload {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

function decode(token: unknown): Payload | null {
  if (typeof token !== "string" || !token || token.length > CAPTCHA_LIMITS.tokenLength) return null;
  try {
    const p = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as Payload;
    const ok =
      p.algorithm === "SHA-256" &&
      typeof p.challenge === "string" &&
      /^[0-9a-f]{64}$/.test(p.challenge) &&
      typeof p.signature === "string" &&
      /^[0-9a-f]{64}$/.test(p.signature) &&
      typeof p.salt === "string" &&
      p.salt.length <= 100 &&
      Number.isSafeInteger(p.number) &&
      p.number >= 0;
    return ok ? p : null;
  } catch {
    return null;
  }
}

/** Checks a token and uses it up. Never throws for a bad token; `unavailable` when Valkey is down. */
export async function verifyToken(project: string, token: unknown, now = Date.now()): Promise<CaptchaVerifyResponse> {
  const { hmacKey } = await projectRow(project);
  const p = decode(token);
  if (!p) return { success: false, error: "invalid" };
  if (!same(await hmacHex(hmacKey, p.challenge), p.signature)) return { success: false, error: "invalid" };
  const expires = Number(/[?&]expires=(\d+)/.exec(p.salt)?.[1]);
  if (!expires || expires * 1000 < now) return { success: false, error: "expired" };
  if ((await sha256Hex(p.salt + p.number)) !== p.challenge) return { success: false, error: "invalid" };
  try {
    const ttl = Math.max(1, Math.ceil((expires * 1000 - now) / 1000) + 60);
    const set = await send<string | null>("SET", [usedKey(project, p.signature), "1", "EX", ttl, "NX"]);
    if (set !== "OK") return { success: false, error: "used" };
  } catch {
    return { success: false, error: "unavailable" };
  }
  return { success: true };
}

/** Turnstile's siteverify: `{ secret, response, remoteip }` as JSON or a form. */
export async function siteVerify(project: string, req: Request): Promise<Response> {
  let secret: unknown;
  let response: unknown;
  const type = req.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    secret = body?.secret;
    response = body?.response;
  } else {
    const form = new URLSearchParams(await req.text());
    secret = form.get("secret");
    response = form.get("response");
  }
  const row = await projectRow(project).catch(() => null);
  if (!row || typeof secret !== "string" || !same(secret, row.secret)) {
    return Response.json({ success: false, "error-codes": ["invalid-input-secret"] }, { status: 401 });
  }
  const result = await verifyToken(project, response);
  const codes = result.success ? [] : [result.error === "used" ? "timeout-or-duplicate" : result.error === "expired" ? "timeout-or-duplicate" : result.error === "unavailable" ? "internal-error" : "invalid-input-response"];
  return Response.json({ success: result.success, "error-codes": codes, challenge_ts: new Date().toISOString() });
}

export async function getSettings(project: string): Promise<CaptchaSettings> {
  const { secret, maxNumber } = await projectRow(project);
  const base = `${publicApiUrl()}/captcha/${project}`;
  return { secretKey: secret, maxNumber, challengeUrl: `${base}/challenge`, siteVerifyUrl: `${base}/siteverify`, scriptUrl: `${publicApiUrl()}/captcha.js` };
}

export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<CaptchaSettings> {
  await projectRow(project);
  const { min, max } = CAPTCHA_LIMITS.maxNumber;
  const n = body.maxNumber;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new BadRequestError(`maxNumber must be a whole number from ${min} to ${max}`);
  await sql`update mybase.captcha_projects set max_number = ${n} where project = ${project}`;
  cache.delete(project);
  log.info("captcha settings changed", { maxNumber: n });
  return getSettings(project);
}

export async function rotateSecret(project: string, log: Logger): Promise<CaptchaSettings> {
  await projectRow(project);
  await sql`update mybase.captcha_projects set secret = ${newSecret()} where project = ${project}`;
  cache.delete(project);
  log.info("captcha secret rotated");
  return getSettings(project);
}

// Built like /analytics.js: prebuilt in the image (CAPTCHA_SCRIPT), built on first request in dev.
let script: Promise<string> | null = null;

export function captchaScript(): Promise<string> {
  script ??= (async () => {
    if (process.env.CAPTCHA_SCRIPT) return Bun.file(process.env.CAPTCHA_SCRIPT).text();
    const result = await Bun.build({
      entrypoints: [new URL("../../../packages/sdk/src/captcha-widget.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
      minify: true,
    });
    if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "captcha.js build failed");
    return result.outputs[0].text();
  })().catch((err) => {
    script = null;
    throw err;
  });
  return script;
}

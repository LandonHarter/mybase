// Two-factor sign-in for the admin: TOTP codes from an authenticator app (totp.ts) plus ten
// one-time recovery codes. Optional; with it on, a correct password only earns a short-lived
// challenge, and `/auth/login/mfa` trades the challenge and a code for a session or token.
// API tokens don't need a code: they're issued by a signed-in admin and revoked separately.
import type { MfaStatus, RecoveryCodesResponse, TotpSetupResponse } from "@mybase/shared";
import type { TransactionSQL } from "bun";
import type { Logger } from "@mybase/shared/logger";
import { adminUsername, verifyAdmin } from "./auth";
import { hashToken, newToken } from "./auth-http";
import { ConflictError, ServiceUnavailableError, UnauthorizedError } from "./errors";
import { sql } from "./postgres";
import { audit } from "./audit";
import { secretsMaster } from "./secrets";
import { decodeKey, importMaster, openBlob, sameId, sealBlob, type MasterKey } from "./secrets-crypto";
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "./totp";

const SECRET_AAD = "mybase-admin-totp";
const RECOVERY_CODES = 10;
// Recovery codes: 12 characters from 32 (60 bits), no 0/O or 1/I/L to misread.
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CHALLENGE_PREFIX = "mbm_";
const CHALLENGE_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;

interface TotpRow {
  secret: Uint8Array;
  secret_master: Uint8Array | null;
  enabled_at: Date | null;
  last_step: string;
}

async function totpRow(): Promise<TotpRow | null> {
  const [row]: TotpRow[] = await sql`select secret, secret_master, enabled_at, last_step from mybase.admin_totp where id = 1`;
  return row ?? null;
}

/** Seals a new secret under MYBASE_SECRETS_KEY when it's set. */
async function storeForm(secret: Uint8Array): Promise<{ secret: Buffer; master: Buffer | null }> {
  const master = secretsMaster();
  if (!master) return { secret: Buffer.from(secret), master: null };
  return { secret: Buffer.from(await sealBlob(master, secret, SECRET_AAD)), master: Buffer.from(master.id) };
}

async function readSecret(row: TotpRow): Promise<Uint8Array> {
  if (!row.secret_master) return new Uint8Array(row.secret);
  const master = secretsMaster();
  if (!master || !sameId(master.id, row.secret_master)) {
    throw new ServiceUnavailableError(
      "2FA codes can't be checked: MYBASE_SECRETS_KEY is missing or isn't the key 2FA was set up with. Use a recovery code, or restart with MYBASE_ADMIN_RESET_MFA=1.",
    );
  }
  return openBlob(master, row.secret, SECRET_AAD);
}

// Cached like `adminKnown` in auth.ts: checked on every sign-in, changed only here.
let enabledCache: boolean | null = null;

export async function mfaEnabled(): Promise<boolean> {
  enabledCache ??= (await totpRow())?.enabled_at != null;
  return enabledCache;
}

export async function mfaStatus(): Promise<MfaStatus> {
  const [row]: { left: number }[] = await sql`select count(*)::int as left from mybase.admin_recovery_codes where used_at is null`;
  return { totp: await mfaEnabled(), recoveryCodesLeft: row?.left ?? 0 };
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Replaces every recovery code. Returns the new ones: the only time they're shown. */
async function replaceRecoveryCodes(tx: TransactionSQL): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await tx`delete from mybase.admin_recovery_codes`;
  for (const code of codes) await tx`insert into mybase.admin_recovery_codes (code_hash) values (${hashToken(normalizeRecovery(code))})`;
  return codes;
}

/**
 * Checks a TOTP code (6 digits) or a recovery code (anything else). A TOTP code works once: the
 * step it matched is saved, and the update only wins if the step is newer. A recovery code is
 * marked used in the same statement that checks it.
 */
export async function verifySecondFactor(code: unknown, log: Logger): Promise<boolean> {
  if (typeof code !== "string" || code.length > 64) return false;
  if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    const row = await totpRow();
    if (!row?.enabled_at) return false;
    const step = verifyTotp(await readSecret(row), code, Number(row.last_step));
    if (step === null) return false;
    const won = await sql`update mybase.admin_totp set last_step = ${step} where id = 1 and last_step < ${step} returning id`;
    return won.length > 0;
  }
  const used = await sql`
    update mybase.admin_recovery_codes set used_at = now()
    where code_hash = ${hashToken(normalizeRecovery(code))} and used_at is null returning code_hash`;
  if (used.length === 0) return false;
  const left = (await mfaStatus()).recoveryCodesLeft;
  log.warn("recovery code used", { left });
  audit({ action: "mfa.recovery_used", meta: { left } });
  return true;
}

/**
 * Starts setup: a new secret, saved as pending until a code confirms it (so a half-finished
 * setup never locks anyone out). Needs the password, so a borrowed session isn't enough.
 */
export async function startTotpSetup(password: unknown, host: string): Promise<TotpSetupResponse> {
  const username = (await adminUsername()) ?? "admin";
  await verifyAdmin(username, password).catch((err) => {
    throw err instanceof UnauthorizedError ? new UnauthorizedError("password is wrong") : err;
  });
  const secret = newTotpSecret();
  const stored = await storeForm(secret);
  const rows = await sql`
    insert into mybase.admin_totp (secret, secret_master) values (${stored.secret}, ${stored.master})
    on conflict (id) do update set secret = excluded.secret, secret_master = excluded.secret_master, last_step = 0
    where mybase.admin_totp.enabled_at is null
    returning id`;
  if (rows.length === 0) throw new ConflictError("2FA is already on; turn it off first");
  return { secret: base32Encode(secret), uri: otpauthUri("mybase", `${username}@${host}`, secret) };
}

/** Confirms setup with a code from the app, turns 2FA on, and signs out every other session. */
export async function confirmTotpSetup(code: unknown, keepSession: string | null, log: Logger): Promise<RecoveryCodesResponse> {
  const row = await totpRow();
  if (!row) throw new ConflictError("start 2FA setup first");
  if (row.enabled_at) throw new ConflictError("2FA is already on");
  const step = typeof code === "string" ? verifyTotp(await readSecret(row), code, 0) : null;
  if (step === null) throw new UnauthorizedError("wrong code: check the time on this server and your phone");
  const codes = await sql.begin(async (tx) => {
    const won = await tx`update mybase.admin_totp set enabled_at = now(), last_step = ${step} where id = 1 and enabled_at is null returning id`;
    if (won.length === 0) throw new ConflictError("2FA is already on");
    await tx`delete from mybase.sessions where token_hash <> ${keepSession ?? ""}`;
    return replaceRecoveryCodes(tx);
  });
  enabledCache = true;
  log.info("2fa enabled");
  return { codes };
}

/** Turns 2FA off. Needs the password and a code (or recovery code). */
export async function disableTotp(password: unknown, code: unknown, log: Logger) {
  await verifyAdmin(await adminUsername(), password).catch((err) => {
    throw err instanceof UnauthorizedError ? new UnauthorizedError("password is wrong") : err;
  });
  if (!(await verifySecondFactor(code, log))) throw new UnauthorizedError("wrong code");
  await clearMfa();
  log.info("2fa disabled");
}

export async function regenerateRecoveryCodes(code: unknown, log: Logger): Promise<RecoveryCodesResponse> {
  if (!(await mfaEnabled())) throw new ConflictError("2FA is off");
  if (!(await verifySecondFactor(code, log))) throw new UnauthorizedError("wrong code");
  const codes = await sql.begin((tx) => replaceRecoveryCodes(tx));
  log.info("recovery codes replaced");
  return { codes };
}

async function clearMfa() {
  await sql.begin(async (tx) => {
    await tx`delete from mybase.admin_totp`;
    await tx`delete from mybase.admin_recovery_codes`;
  });
  enabledCache = false;
}

// ---- login challenges ------------------------------------------------------

/** Password checked, code still owed. In memory: a restart just means signing in again. */
const challenges = new Map<string, { tokenName: string | undefined; expires: number; attempts: number }>();

export function createChallenge(tokenName: string | undefined, now = Date.now()): string {
  if (challenges.size >= 1000) {
    for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
    // Still full: drop the oldest. Only someone who knows the password gets this far.
    if (challenges.size >= 1000) challenges.delete(challenges.keys().next().value!);
  }
  const challenge = newToken(CHALLENGE_PREFIX);
  challenges.set(hashToken(challenge), { tokenName, expires: now + CHALLENGE_MS, attempts: 0 });
  return challenge;
}

/**
 * Checks a code against a challenge. On success the challenge is used up and its `tokenName`
 * returned (undefined = a browser sign-in). Throws UnauthorizedError otherwise; a challenge
 * dies after 5 wrong codes, so the password has to be entered again.
 */
export async function completeChallenge(challenge: unknown, code: unknown, log: Logger): Promise<{ tokenName: string | undefined }> {
  const key = typeof challenge === "string" && challenge.startsWith(CHALLENGE_PREFIX) ? hashToken(challenge) : null;
  const entry = key ? challenges.get(key) : undefined;
  if (!key || !entry || entry.expires < Date.now()) {
    if (key) challenges.delete(key);
    throw new UnauthorizedError("sign-in expired; enter your password again");
  }
  if (!(await verifySecondFactor(code, log))) {
    if (++entry.attempts >= CHALLENGE_ATTEMPTS) challenges.delete(key);
    throw new UnauthorizedError("wrong code");
  }
  challenges.delete(key);
  return { tokenName: entry.tokenName };
}

// ---- boot ------------------------------------------------------------------

/**
 * After `startSecrets`: `MYBASE_ADMIN_RESET_MFA=1` turns 2FA off (the way back in without the
 * phone or the codes). Otherwise keeps the stored secret readable: seals a plain one once
 * MYBASE_SECRETS_KEY is set, and moves it to a new key when MYBASE_SECRETS_KEY_OLD is the old one.
 */
export async function startMfa(bootLog: Logger) {
  if (process.env.MYBASE_ADMIN_RESET_MFA === "1") {
    await clearMfa();
    bootLog.warn("2FA turned off by MYBASE_ADMIN_RESET_MFA; unset it and turn 2FA back on in Settings");
    return;
  }
  const row = await totpRow();
  const master = secretsMaster();
  if (!row || !master) {
    if (row?.secret_master && row.enabled_at) bootLog.error("MYBASE_SECRETS_KEY is not set: 2FA codes can't be checked (recovery codes still work)");
    return;
  }
  if (row.secret_master && sameId(row.secret_master, master.id)) return;
  let plain: Uint8Array;
  if (!row.secret_master) plain = new Uint8Array(row.secret);
  else {
    const oldRaw = process.env.MYBASE_SECRETS_KEY_OLD;
    const old: MasterKey | null = oldRaw ? await importMaster(decodeKey(oldRaw, "MYBASE_SECRETS_KEY_OLD")) : null;
    if (!old || !sameId(row.secret_master, old.id)) {
      bootLog.error("the 2FA secret was stored with a different MYBASE_SECRETS_KEY: use a recovery code, or MYBASE_ADMIN_RESET_MFA=1");
      return;
    }
    plain = await openBlob(old, row.secret, SECRET_AAD);
  }
  const sealed = Buffer.from(await sealBlob(master, plain, SECRET_AAD));
  plain.fill(0);
  await sql`update mybase.admin_totp set secret = ${sealed}, secret_master = ${Buffer.from(master.id)} where id = 1`;
  bootLog.info("2FA secret re-encrypted with MYBASE_SECRETS_KEY");
}

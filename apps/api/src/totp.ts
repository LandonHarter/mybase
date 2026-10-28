// TOTP (RFC 6238) for the admin's second factor: HMAC-SHA1, 6 digits, 30 s steps, which is what
// every authenticator app expects. No database access, so it's easy to test (totp.test.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding: how authenticator apps take secrets. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Ignores case, spaces, and padding. Throws on other characters. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new random secret: 20 bytes, the HMAC-SHA1 block size RFC 4226 recommends. */
export const newTotpSecret = () => crypto.getRandomValues(new Uint8Array(20));

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

/** The code for one time step. `digits` is only there for the RFC test vectors (8 digits). */
export function totpCode(secret: Uint8Array, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * The step a code matches, or null. Accepts one step either side for clock drift, and never a
 * step at or before `lastStep`, so a code that already signed in can't be replayed.
 */
export function verifyTotp(secret: Uint8Array, code: string, lastStep: number, now = Date.now()): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(now);
  let matched: number | null = null;
  // Checks every candidate, so timing doesn't say which one matched.
  for (const step of [current - 1, current, current + 1]) {
    const ok = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given));
    if (ok && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

/** What the QR code holds: `otpauth://totp/<issuer>:<account>?secret=…`. */
export function otpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

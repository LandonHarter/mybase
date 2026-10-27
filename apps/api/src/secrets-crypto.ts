// Encryption for the secrets service. Envelope scheme: MYBASE_SECRETS_KEY (the master key,
// never stored) wraps one random data key per project, and the data key encrypts values.
// Both layers are AES-256-GCM with a fresh 12-byte IV, stored as `iv || ciphertext+tag`.
// A value's additional data binds it to its project, env, and key, so a ciphertext copied to
// another row fails to decrypt instead of showing up under the wrong name.
import { ServiceUnavailableError } from "./errors";

const IV_BYTES = 12;

/** Web Crypto wants bytes backed by a plain ArrayBuffer; Postgres hands back Buffers. */
const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const WRAP_AAD = new TextEncoder().encode("mybase-secrets-data-key");

export interface MasterKey {
  key: CryptoKey;
  /** First 8 bytes of sha256(master): tells which master wrapped a data key. Not secret. */
  id: Uint8Array;
}

/** Decodes a 32-byte key from base64 (standard or url-safe) or 64 hex characters. Throws on anything else. */
export function decodeKey(raw: string, name: string): Uint8Array {
  const value = raw.trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
      ? Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64")
      : null;
  if (decoded?.length !== 32) throw new Error(`${name} must be 32 random bytes as base64 (openssl rand -base64 32)`);
  return new Uint8Array(decoded);
}

export async function importMaster(raw: Uint8Array): Promise<MasterKey> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(raw)));
  const key = await crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, id: digest.slice(0, 8) };
}

async function seal(key: CryptoKey, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(aad) }, key, bytes(plain)));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return out;
}

async function open(key: CryptoKey, blob: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const all = bytes(blob);
  const iv = all.subarray(0, IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: bytes(aad) }, key, all.subarray(IV_BYTES)));
}

/** A new data key, wrapped with the master. Returns the wrapped bytes (to store) and the usable key. */
export async function newDataKey(master: MasterKey): Promise<{ wrapped: Uint8Array; key: CryptoKey }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(master.key, raw, WRAP_AAD);
  const key = await crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return { wrapped, key };
}

export async function unwrapDataKey(master: MasterKey, wrapped: Uint8Array): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = await open(master.key, wrapped, WRAP_AAD);
  } catch {
    throw new ServiceUnavailableError("this project's secrets can't be decrypted: MYBASE_SECRETS_KEY doesn't match the key they were stored with");
  }
  const key = await crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

/** Re-wraps a data key under a new master (master key rotation). Values stay as they are. */
export async function rewrapDataKey(from: MasterKey, to: MasterKey, wrapped: Uint8Array): Promise<Uint8Array> {
  const raw = await open(from.key, wrapped, WRAP_AAD);
  const out = await seal(to.key, raw, WRAP_AAD);
  raw.fill(0);
  return out;
}

const valueAad = (project: string, envId: string, key: string) => new TextEncoder().encode(`${project}\0${envId}\0${key}`);

export const encryptValue = async (dataKey: CryptoKey, project: string, envId: string, key: string, value: string) =>
  seal(dataKey, new TextEncoder().encode(value), valueAad(project, envId, key));

export async function decryptValue(dataKey: CryptoKey, project: string, envId: string, key: string, blob: Uint8Array): Promise<string> {
  try {
    return new TextDecoder().decode(await open(dataKey, blob, valueAad(project, envId, key)));
  } catch {
    throw new Error(`secret ${key} failed to decrypt (tampered or moved row)`);
  }
}

export const sameId = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

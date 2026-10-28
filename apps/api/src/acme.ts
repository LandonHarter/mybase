// A small ACME (RFC 8555) client for Let's Encrypt: one hostname, dns-01 challenges only.
// Used by db-public.ts to get Postgres a real certificate without opening port 80.
// WebCrypto for keys and signatures, and a few lines of DER for the CSR, so no dependencies.
import { X509Certificate } from "node:crypto";

export const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export class AcmeError extends Error {}

// ---- encoding --------------------------------------------------------------

export const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

const sha256 = async (data: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** One DER TLV. */
export const der = (tag: number, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  return new Uint8Array([tag, ...derLength(body.length), ...body]);
};

const seq = (...parts: Uint8Array[]) => der(0x30, ...parts);

export function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, new Uint8Array(out));
}

/** A positive DER INTEGER from big-endian bytes. */
function derInt(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return der(0x02, trimmed[0]! & 0x80 ? new Uint8Array([0, ...trimmed]) : trimmed);
}

/** WebCrypto signs ECDSA as r‖s; X.509 wants SEQUENCE { INTEGER r, INTEGER s }. */
export const ecdsaDer = (raw: Uint8Array) => seq(derInt(raw.subarray(0, raw.length / 2)), derInt(raw.subarray(raw.length / 2)));

const pem = (label: string, data: Uint8Array) =>
  `-----BEGIN ${label}-----\n${Buffer.from(data).toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;

/** A PKCS#10 request for `host` (CN + SAN), signed with `key`. Returns DER. */
export async function csr(host: string, key: CryptoKeyPair): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));
  const subject = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, new TextEncoder().encode(host)))));
  const san = seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, new TextEncoder().encode(host)))));
  const extensionRequest = seq(oid("1.2.840.113549.1.9.14"), der(0x31, seq(san)));
  const info = seq(der(0x02, new Uint8Array([0])), subject, spki, der(0xa0, extensionRequest));
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, key.privateKey, info));
  return seq(info, seq(oid("1.2.840.10045.4.3.2")), der(0x03, new Uint8Array([0]), ecdsaDer(signature)));
}

// ---- account key -----------------------------------------------------------

export interface AccountKey {
  /** Private JWK, for storing. */
  jwk: JsonWebKey;
  key: CryptoKey;
  publicJwk: { crv: string; kty: string; x: string; y: string };
}

export async function newAccountKey(): Promise<AccountKey> {
  const pair = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  return importAccountKey((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey);
}

export async function importAccountKey(jwk: JsonWebKey): Promise<AccountKey> {
  const key = await crypto.subtle.importKey("jwk", jwk, EC, false, ["sign"]);
  return { jwk, key, publicJwk: { crv: jwk.crv!, kty: jwk.kty!, x: jwk.x!, y: jwk.y! } };
}

/** RFC 7638: SHA-256 of the public JWK's required members, in lexical order. */
export const thumbprint = async (k: AccountKey) =>
  b64url(await sha256(JSON.stringify({ crv: k.publicJwk.crv, kty: k.publicJwk.kty, x: k.publicJwk.x, y: k.publicJwk.y })));

/** The TXT value for a dns-01 challenge. */
export const dnsChallengeValue = async (token: string, k: AccountKey) => b64url(await sha256(`${token}.${await thumbprint(k)}`));

// ---- protocol --------------------------------------------------------------

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface Order {
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

interface Authorization {
  status: "pending" | "valid" | "invalid" | "deactivated" | "expired" | "revoked";
  identifier: { type: string; value: string };
  challenges: { type: string; url: string; token: string; status: string; error?: { detail?: string } }[];
}

export interface IssueOptions {
  directory: string;
  host: string;
  account: AccountKey;
  /** The account URL from an earlier run, to skip looking it up. */
  accountUrl?: string | null;
  email?: string;
  /** Publishes the TXT record; returns a function that removes it. */
  setTxt(name: string, value: string): Promise<() => Promise<void>>;
  /** How long to give DNS before asking the CA to check. */
  propagationMs?: number;
  pollMs?: number;
  fetcher?: typeof fetch;
}

export interface Issued {
  /** Full chain, leaf first. */
  certPem: string;
  keyPem: string;
  notAfter: Date;
  accountUrl: string;
}

const sleep = (ms: number) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

function client(opts: IssueOptions) {
  const fetcher = opts.fetcher ?? fetch;
  let dir: Directory | null = null;
  let nonce: string | null = null;
  let kid = opts.accountUrl ?? null;

  async function directory(): Promise<Directory> {
    if (dir) return dir;
    const res = await fetcher(opts.directory);
    if (!res.ok) throw new AcmeError(`ACME directory: HTTP ${res.status}`);
    dir = (await res.json()) as Directory;
    return dir;
  }

  async function freshNonce(): Promise<string> {
    const res = await fetcher((await directory()).newNonce, { method: "HEAD" });
    const value = res.headers.get("replay-nonce");
    if (!value) throw new AcmeError("ACME server sent no nonce");
    return value;
  }

  /** A signed POST; `payload` undefined = POST-as-GET. */
  async function post(url: string, payload: unknown, accept?: string, retried = false): Promise<Response> {
    const header: Record<string, unknown> = { alg: "ES256", nonce: nonce ?? (await freshNonce()), url };
    nonce = null;
    if (kid) header.kid = kid;
    else header.jwk = opts.account.publicJwk;
    const protectedB64 = b64url(JSON.stringify(header));
    const payloadB64 = payload === undefined ? "" : b64url(JSON.stringify(payload));
    const sig = new Uint8Array(await crypto.subtle.sign(SIGN, opts.account.key, new TextEncoder().encode(`${protectedB64}.${payloadB64}`)));
    const res = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/jose+json", ...(accept ? { Accept: accept } : {}) },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64url(sig) }),
    });
    nonce = res.headers.get("replay-nonce");
    if (res.ok) return res;
    const problem = (await res.json().catch(() => null)) as { type?: string; detail?: string } | null;
    if (problem?.type === "urn:ietf:params:acme:error:badNonce" && !retried) return post(url, payload, accept, true);
    throw new AcmeError(`ACME: ${problem?.detail ?? `HTTP ${res.status}`}`);
  }

  async function account(): Promise<string> {
    if (kid) return kid;
    const res = await post((await directory()).newAccount, {
      termsOfServiceAgreed: true,
      ...(opts.email ? { contact: [`mailto:${opts.email}`] } : {}),
    });
    kid = res.headers.get("location");
    if (!kid) throw new AcmeError("ACME server sent no account URL");
    return kid;
  }

  /** POST-as-GET until `done` says stop, for up to ~2 minutes. */
  async function poll<T>(url: string, done: (body: T) => boolean): Promise<T> {
    for (let i = 0; ; i++) {
      const body = (await (await post(url, undefined)).json()) as T;
      if (done(body) || i >= 40) return body;
      await sleep(opts.pollMs ?? 3000);
    }
  }

  return { directory, post, account, poll };
}

/** Gets a certificate for `opts.host` with a dns-01 challenge. Always removes the TXT records it made. */
export async function issueCertificate(opts: IssueOptions): Promise<Issued> {
  const c = client(opts);
  const accountUrl = await c.account();
  const orderRes = await c.post((await c.directory()).newOrder, { identifiers: [{ type: "dns", value: opts.host }] });
  const orderUrl = orderRes.headers.get("location");
  let order = (await orderRes.json()) as Order;
  if (!orderUrl) throw new AcmeError("ACME server sent no order URL");

  const cleanups: (() => Promise<void>)[] = [];
  try {
    for (const authzUrl of order.authorizations) {
      const authz = (await (await c.post(authzUrl, undefined)).json()) as Authorization;
      if (authz.status === "valid") continue;
      const challenge = authz.challenges.find((ch) => ch.type === "dns-01");
      if (!challenge) throw new AcmeError("the CA offered no dns-01 challenge");
      cleanups.push(await opts.setTxt(`_acme-challenge.${authz.identifier.value}`, await dnsChallengeValue(challenge.token, opts.account)));
      await sleep(opts.propagationMs ?? 15_000);
      await c.post(challenge.url, {});
      const result = await c.poll<Authorization>(authzUrl, (a) => a.status !== "pending");
      if (result.status !== "valid") {
        const detail = result.challenges.find((ch) => ch.type === "dns-01")?.error?.detail;
        throw new AcmeError(`DNS challenge failed${detail ? `: ${detail}` : ` (${result.status})`}`);
      }
    }
  } finally {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  }

  const certKey = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  order = (await (await c.post(order.finalize, { csr: b64url(await csr(opts.host, certKey)) })).json()) as Order;
  order = await c.poll<Order>(orderUrl, (o) => o.status === "valid" || o.status === "invalid");
  if (order.status !== "valid" || !order.certificate) throw new AcmeError(`order ended ${order.status}`);

  const certPem = await (await c.post(order.certificate, undefined, "application/pem-certificate-chain")).text();
  const keyPem = pem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", certKey.privateKey)));
  return { certPem, keyPem, notAfter: new Date(new X509Certificate(certPem).validTo), accountUrl };
}

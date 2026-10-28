import { expect, test } from "bun:test";
import { csr, der, dnsChallengeValue, ecdsaDer, importAccountKey, issueCertificate, newAccountKey, oid, thumbprint } from "./acme";

test("DER basics", () => {
  expect([...oid("1.2.840.10045.4.3.2")]).toEqual([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
  expect([...oid("2.5.29.17")]).toEqual([0x06, 0x03, 0x55, 0x1d, 0x11]);
  // Long form length.
  expect([...der(0x04, new Uint8Array(200)).subarray(0, 3)]).toEqual([0x04, 0x81, 200]);
  expect([...der(0x04, new Uint8Array(300)).subarray(0, 4)]).toEqual([0x04, 0x82, 0x01, 0x2c]);
  // High bit gets a 0x00 pad, leading zeros go.
  const raw = new Uint8Array(64);
  raw[0] = 0x80;
  raw[63] = 1;
  expect([...ecdsaDer(raw).subarray(0, 4)]).toEqual([0x30, 0x26, 0x02, 0x21]);
  expect([...ecdsaDer(raw).slice(-3)]).toEqual([0x02, 0x01, 0x01]);
});

test.skipIf(!Bun.which("openssl"))("the CSR verifies and names the host", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const request = await csr("db.example.com", key);
  const proc = Bun.spawnSync(["openssl", "req", "-inform", "DER", "-noout", "-verify", "-text"], { stdin: request });
  const out = proc.stdout.toString() + proc.stderr.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toMatch(/verify OK/i);
  expect(out).toContain("CN=db.example.com");
  expect(out).toContain("DNS:db.example.com");
});

test("account keys round-trip and thumbprint is stable", async () => {
  const k = await newAccountKey();
  const again = await importAccountKey(k.jwk);
  expect(await thumbprint(again)).toBe(await thumbprint(k));
  expect(await dnsChallengeValue("tok", k)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

/** A fake CA that walks one order through pending → valid and records what it saw. */
function fakeCa() {
  const base = "https://ca.test";
  const seen: { url: string; header: Record<string, unknown>; payload: unknown }[] = [];
  let authzStatus = "pending";
  let n = 0;
  const reply = (body: unknown, extra: Record<string, string> = {}, status = 200) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Replay-Nonce": `n${++n}`, ...extra } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${base}/dir`) return Response.json({ newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` });
    if (url === `${base}/nonce`) return reply("");
    const jws = JSON.parse(String(init!.body)) as { protected: string; payload: string };
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString());
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, "base64url").toString()) : undefined;
    seen.push({ url, header, payload });
    if (url === `${base}/acct`) return reply({}, { Location: `${base}/acct/1` }, 201);
    if (url === `${base}/order`) return reply({ status: "pending", authorizations: [`${base}/authz/1`], finalize: `${base}/finalize` }, { Location: `${base}/order/1` }, 201);
    if (url === `${base}/authz/1`)
      return reply({ status: authzStatus, identifier: { type: "dns", value: "db.example.com" }, challenges: [{ type: "dns-01", url: `${base}/chall/1`, token: "tok", status: authzStatus }] });
    if (url === `${base}/chall/1`) {
      authzStatus = "valid";
      return reply({});
    }
    if (url === `${base}/finalize`) return reply({ status: "processing", authorizations: [], finalize: "" });
    if (url === `${base}/order/1`) return reply({ status: "valid", authorizations: [], finalize: "", certificate: `${base}/cert/1` });
    if (url === `${base}/cert/1`) return reply(CERT);
    return reply({ detail: "unknown" }, {}, 404);
  }) as typeof fetch;
  return { fetcher, seen, directory: `${base}/dir` };
}

// Any certificate works; the client only reads its expiry.
const CERT = Bun.spawnSync(["sh", "-c", "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /dev/null -days 90 -subj /CN=db.example.com 2>/dev/null"]).stdout.toString();

test.skipIf(!CERT)("issueCertificate runs the dns-01 flow and cleans up", async () => {
  const ca = fakeCa();
  const account = await newAccountKey();
  const txt: string[] = [];
  const removed: string[] = [];
  const issued = await issueCertificate({
    directory: ca.directory,
    host: "db.example.com",
    account,
    email: "me@example.com",
    propagationMs: 0,
    pollMs: 0,
    fetcher: ca.fetcher,
    async setTxt(name, value) {
      txt.push(`${name}=${value}`);
      return async () => void removed.push(name);
    },
  });
  expect(txt).toEqual([`_acme-challenge.db.example.com=${await dnsChallengeValue("tok", account)}`]);
  expect(removed).toEqual(["_acme-challenge.db.example.com"]);
  expect(issued.accountUrl).toBe("https://ca.test/acct/1");
  expect(issued.keyPem).toContain("BEGIN PRIVATE KEY");
  expect(issued.notAfter.getTime()).toBeGreaterThan(Date.now());
  // First request carries the JWK, the rest the account URL.
  expect(ca.seen[0]!.header.jwk).toBeDefined();
  expect(ca.seen[1]!.header.kid).toBe("https://ca.test/acct/1");
  expect(ca.seen[0]!.payload).toEqual({ termsOfServiceAgreed: true, contact: ["mailto:me@example.com"] });
  expect(ca.seen.find((s) => s.url.endsWith("/finalize"))!.payload).toHaveProperty("csr");
});

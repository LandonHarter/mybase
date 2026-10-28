import { describe, expect, test } from "bun:test";
import { base32Decode, base32Encode, otpauthUri, totpCode, totpStep, verifyTotp } from "./totp";

// RFC 6238 appendix B, SHA-1 rows: secret "12345678901234567890", 8 digits.
const rfcSecret = new TextEncoder().encode("12345678901234567890");
const rfcVectors: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totpCode", () => {
  test("RFC 6238 vectors", () => {
    for (const [seconds, code] of rfcVectors) expect(totpCode(rfcSecret, totpStep(seconds * 1000), 8)).toBe(code);
  });
  test("6 digits by default: the last 6 of the 8-digit value", () => {
    expect(totpCode(rfcSecret, totpStep(59_000))).toBe("287082");
  });
});

describe("base32", () => {
  test("RFC 4648 vectors", () => {
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("mzxw6ytboi======"))).toBe("foobar");
  });
  test("round trip", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
  test("rejects junk", () => {
    expect(() => base32Decode("not base32!")).toThrow();
  });
});

describe("verifyTotp", () => {
  const now = 1_700_000_000_000;
  const step = totpStep(now);

  test("accepts the current step and one either side", () => {
    for (const s of [step - 1, step, step + 1]) expect(verifyTotp(rfcSecret, totpCode(rfcSecret, s), 0, now)).toBe(s);
  });
  test("rejects codes outside the window", () => {
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step - 2), 0, now)).toBeNull();
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step + 2), 0, now)).toBeNull();
  });
  test("rejects a replayed or older code", () => {
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step), step, now)).toBeNull();
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step - 1), step, now)).toBeNull();
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, step + 1), step, now)).toBe(step + 1);
  });
  test("ignores spaces, rejects non-codes", () => {
    const code = totpCode(rfcSecret, step);
    expect(verifyTotp(rfcSecret, `${code.slice(0, 3)} ${code.slice(3)}`, 0, now)).toBe(step);
    expect(verifyTotp(rfcSecret, "12345", 0, now)).toBeNull();
    expect(verifyTotp(rfcSecret, "abcdef", 0, now)).toBeNull();
  });
});

test("otpauthUri", () => {
  const uri = new URL(otpauthUri("mybase", "admin", rfcSecret));
  expect(uri.protocol).toBe("otpauth:");
  expect(uri.host).toBe("totp");
  expect(decodeURIComponent(uri.pathname)).toBe("/mybase:admin");
  expect(uri.searchParams.get("secret")).toBe(base32Encode(rfcSecret));
  expect(uri.searchParams.get("issuer")).toBe("mybase");
});

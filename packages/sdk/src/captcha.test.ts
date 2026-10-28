import { describe, expect, test } from "bun:test";
import { createCaptchaClient, encodeToken, sha256Hex, solveCaptcha, solveChallenge, type CaptchaChallenge } from "./captcha";

async function challengeFor(number: number, maxnumber = 1000): Promise<CaptchaChallenge> {
  const salt = "abc123?expires=9999999999";
  return { algorithm: "SHA-256", challenge: await sha256Hex(salt + number), salt, maxnumber, signature: "sig" };
}

describe("solveChallenge", () => {
  test("finds the number and encodes the token", async () => {
    const c = await challengeFor(417);
    const token = await solveChallenge(c);
    expect(token).toBe(encodeToken(c, 417));
    expect(JSON.parse(atob(token))).toMatchObject({ number: 417, salt: c.salt, signature: "sig" });
  });

  test("rejects an unsolvable challenge", async () => {
    const c = { ...(await challengeFor(5, 10)), challenge: "0".repeat(64) };
    await expect(solveChallenge(c)).rejects.toThrow("no solution");
  });
});

test("solveCaptcha fetches the project's challenge", async () => {
  const c = await challengeFor(3);
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return Response.json(c);
  }) as unknown as typeof globalThis.fetch;
  expect(await solveCaptcha({ apiUrl: "https://mb.test/", project: "shop", fetch })).toBe(encodeToken(c, 3));
  expect(urls).toEqual(["https://mb.test/captcha/shop/challenge"]);
});

test("verify sends the token with the API key", async () => {
  const calls: unknown[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), auth: new Headers(init.headers).get("Authorization") });
    return Response.json({ success: false, error: "used" });
  }) as unknown as typeof globalThis.fetch;
  const client = createCaptchaClient({ apiUrl: "https://mb.test", project: "shop", apiKey: "mb_x", fetch });
  expect(await client.verify("tok")).toEqual({ success: false, error: "used" });
  expect(await client.verify("")).toEqual({ success: false, error: "invalid" });
  expect(calls).toEqual([{ url: "https://mb.test/captcha/shop/verify", body: { token: "tok" }, auth: "Bearer mb_x" }]);
});

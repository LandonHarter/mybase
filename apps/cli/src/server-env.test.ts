import { expect, test } from "bun:test";
import { generateSecrets, maskSecret, mergeEnv, parseEnv, renderEnv, SECRET_KEYS, tunnelEnv, tunnelIdFromToken, versionAtLeast } from "./server-env";

test("parseEnv reads plain, quoted, and commented values", () => {
  const env = parseEnv(["# comment", "A=1", 'B="two words"', "C='x$y'", "D=plain # trailing", "export E=e", "not a line"].join("\n"));
  expect(env).toEqual({ A: "1", B: "two words", C: "x$y", D: "plain", E: "e" });
});

test("renderEnv groups keys and round-trips", () => {
  const values = { POSTGRES_PASSWORD: "abc", MYBASE_PUBLIC_HOST: "pi.local", CLOUDFLARE_TUNNEL_TOKEN: "t+k=", CUSTOM: "has space" };
  const text = renderEnv(values);
  expect(text.indexOf("POSTGRES_PASSWORD")).toBeLessThan(text.indexOf("MYBASE_PUBLIC_HOST"));
  expect(text).toContain("# Other\nCUSTOM='has space'");
  expect(parseEnv(text)).toEqual(values);
});

test("mergeEnv replaces in place, removes nulls, appends new keys, keeps the rest", () => {
  const before = "# mine\nPOSTGRES_PASSWORD=keep\nMYBASE_PUBLIC_HOST=old\nMYBASE_TRUST_PROXY=cloudflare\nUNKNOWN=1\n";
  const after = mergeEnv(before, { MYBASE_PUBLIC_HOST: "new", MYBASE_TRUST_PROXY: null, LOG_LEVEL: "debug", NEVER_SET: null });
  expect(after).toBe("# mine\nPOSTGRES_PASSWORD=keep\nMYBASE_PUBLIC_HOST=new\nUNKNOWN=1\n\n# Added by `mybase server setup`\nLOG_LEVEL=debug\n");
});

test("generateSecrets only fills missing keys", () => {
  const fresh = generateSecrets();
  expect(Object.keys(fresh).sort()).toEqual(Object.keys(SECRET_KEYS).sort());
  expect(fresh.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
  expect(Buffer.from(fresh.MYBASE_SECRETS_KEY!, "base64")).toHaveLength(32);
  const some = generateSecrets({ POSTGRES_PASSWORD: "x", MYBASE_SECRETS_KEY: "y" });
  expect(some.POSTGRES_PASSWORD).toBeUndefined();
  expect(some.MYBASE_SECRETS_KEY).toBeUndefined();
  expect(some.VALKEY_PASSWORD).toBeDefined();
});

test("tunnel tokens", () => {
  const token = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-id", s: "secret" })).toString("base64");
  expect(tunnelIdFromToken(token)).toBe("tunnel-id");
  expect(tunnelIdFromToken("nope")).toBeNull();
  expect(tunnelEnv(token, "mybase.example.com", "s3.example.com")).toMatchObject({
    COMPOSE_PROFILES: "tunnel",
    MYBASE_PUBLIC_URL: "https://mybase.example.com",
    MYBASE_S3_PUBLIC_URL: "https://s3.example.com",
    MYBASE_TRUST_PROXY: "cloudflare",
  });
});

test("versionAtLeast and maskSecret", () => {
  expect(versionAtLeast("2.29.1", "2.23.1")).toBe(true);
  expect(versionAtLeast("v2.23.1", "2.23.1")).toBe(true);
  expect(versionAtLeast("2.21.0", "2.23.1")).toBe(false);
  expect(versionAtLeast("2.40.0-desktop.1", "2.23.1")).toBe(true);
  expect(maskSecret("abcdef0123456789")).toBe("abcd…6789");
  expect(maskSecret("short")).toBe("••••");
});

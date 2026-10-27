import { describe, expect, test } from "bun:test";
import { decodeKey, decryptValue, encryptValue, importMaster, newDataKey, rewrapDataKey, sameId, unwrapDataKey } from "./secrets-crypto";

const randomMaster = () => importMaster(crypto.getRandomValues(new Uint8Array(32)));

describe("decodeKey", () => {
  test("base64, url-safe base64, and hex", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const b64 = Buffer.from(bytes).toString("base64");
    expect(decodeKey(b64, "K")).toEqual(bytes);
    expect(decodeKey(b64.replaceAll("+", "-").replaceAll("/", "_"), "K")).toEqual(bytes);
    expect(decodeKey(Buffer.from(bytes).toString("hex"), "K")).toEqual(bytes);
  });
  test("rejects other lengths and junk", () => {
    expect(() => decodeKey(Buffer.alloc(16).toString("base64"), "K")).toThrow("K must be 32");
    expect(() => decodeKey("not a key!", "K")).toThrow();
  });
});

describe("values", () => {
  test("round trip through a wrapped data key", async () => {
    const master = await randomMaster();
    const { wrapped, key } = await newDataKey(master);
    const blob = await encryptValue(key, "shop", "1", "STRIPE_KEY", "sk_live_é");
    const unwrapped = await unwrapDataKey(master, wrapped);
    expect(await decryptValue(unwrapped, "shop", "1", "STRIPE_KEY", blob)).toBe("sk_live_é");
  });

  test("same value encrypts differently each time", async () => {
    const { key } = await newDataKey(await randomMaster());
    const a = await encryptValue(key, "shop", "1", "A", "x");
    const b = await encryptValue(key, "shop", "1", "A", "x");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("a ciphertext moved to another key, env, or project fails", async () => {
    const { key } = await newDataKey(await randomMaster());
    const blob = await encryptValue(key, "shop", "1", "A", "x");
    await expect(decryptValue(key, "shop", "1", "B", blob)).rejects.toThrow("B");
    await expect(decryptValue(key, "shop", "2", "A", blob)).rejects.toThrow();
    await expect(decryptValue(key, "blog", "1", "A", blob)).rejects.toThrow();
  });

  test("a wrong master key says so", async () => {
    const { wrapped } = await newDataKey(await randomMaster());
    await expect(unwrapDataKey(await randomMaster(), wrapped)).rejects.toThrow("MYBASE_SECRETS_KEY");
  });

  test("rewrapping keeps values readable under the new master", async () => {
    const [oldMaster, newMaster] = [await randomMaster(), await randomMaster()];
    const { wrapped, key } = await newDataKey(oldMaster);
    const blob = await encryptValue(key, "shop", "1", "A", "x");
    const rewrapped = await rewrapDataKey(oldMaster, newMaster, wrapped);
    expect(await decryptValue(await unwrapDataKey(newMaster, rewrapped), "shop", "1", "A", blob)).toBe("x");
    expect(sameId(oldMaster.id, newMaster.id)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { outboundBlocked, outboundMode } from "./outbound";

const before = { mode: process.env.MYBASE_OUTBOUND, nodeEnv: process.env.NODE_ENV };
afterEach(() => {
  process.env.MYBASE_OUTBOUND = before.mode;
  if (before.mode === undefined) delete process.env.MYBASE_OUTBOUND;
});

describe("outboundBlocked", () => {
  test.each(["http://127.0.0.1:4000/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://0.0.0.0/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/"])(
    "%s is always refused",
    async (url) => {
      process.env.MYBASE_OUTBOUND = "lan";
      expect(await outboundBlocked(url)).toContain("local or internal");
    },
  );
  test("lan allows private addresses; public doesn't", async () => {
    process.env.MYBASE_OUTBOUND = "lan";
    expect(await outboundBlocked("http://192.168.1.20:3000/cron")).toBeNull();
    process.env.MYBASE_OUTBOUND = "public";
    expect(await outboundBlocked("http://192.168.1.20:3000/cron")).toContain("isn't a public address");
    expect(await outboundBlocked("https://1.1.1.1/")).toBeNull();
  });
  test("any turns the checks off", async () => {
    process.env.MYBASE_OUTBOUND = "any";
    expect(await outboundBlocked("http://127.0.0.1:3000/")).toBeNull();
  });
  test("non-http schemes are refused", async () => expect(await outboundBlocked("file:///etc/passwd")).toContain("http"));
  test("default depends on NODE_ENV", () => {
    delete process.env.MYBASE_OUTBOUND;
    expect(outboundMode()).toBe(before.nodeEnv === "production" ? "lan" : "any");
  });
});

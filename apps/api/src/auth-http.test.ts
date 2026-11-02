import { describe, expect, test } from "bun:test";
import { bearerToken, clientIp, crossOrigin, inNets, isHttps, isPrivateIp, LoginThrottle, parseCidr, RateLimit, readCookie, sessionCookie, trustedCountry } from "./auth-http";

const req = (headers: Record<string, string>, method = "POST", url = "http://localhost:4000/projects") => new Request(url, { method, headers });

describe("isPrivateIp", () => {
  test.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "100.64.0.1", "100.127.1.1", "::1", "fd7a:115c::1", "fe80::1", "::ffff:192.168.0.2"])(
    "%s is private",
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );
  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700::1111", "unknown", "::ffff:8.8.8.8"])("%s is public", (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("crossOrigin", () => {
  test("safe methods always pass", () => expect(crossOrigin(req({ "Sec-Fetch-Site": "cross-site" }, "GET"))).toBe(false));
  test("same-origin fetch passes", () => expect(crossOrigin(req({ "Sec-Fetch-Site": "same-origin" }))).toBe(false));
  test("cross-site and same-site are blocked", () => {
    expect(crossOrigin(req({ "Sec-Fetch-Site": "cross-site" }))).toBe(true);
    expect(crossOrigin(req({ "Sec-Fetch-Site": "same-site" }))).toBe(true);
  });
  test("falls back to Origin vs Host", () => {
    expect(crossOrigin(req({ Origin: "http://localhost:4000", Host: "localhost:4000" }))).toBe(false);
    expect(crossOrigin(req({ Origin: "https://evil.example", Host: "localhost:4000" }))).toBe(true);
  });
  test("no browser headers (CLI) passes", () => expect(crossOrigin(req({}))).toBe(false));
});

test("readCookie finds the named cookie", () => {
  expect(readCookie(req({ Cookie: "a=1; mybase_session=mbs_x; b=2" }), "mybase_session")).toBe("mbs_x");
  expect(readCookie(req({ Cookie: "a=1" }), "mybase_session")).toBeNull();
});

test("bearerToken", () => {
  expect(bearerToken(req({ Authorization: "Bearer mb_abc" }))).toBe("mb_abc");
  expect(bearerToken(req({ Authorization: "Basic xyz" }))).toBeNull();
  // docker login: Basic with the API key as the password.
  const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  expect(bearerToken(req({ Authorization: basic("mybase:mb_abc") }))).toBe("mb_abc");
  expect(bearerToken(req({ Authorization: basic("mybase:hunter2") }))).toBeNull();
  expect(bearerToken(req({ Authorization: basic("mb_abc") }))).toBeNull();
});

test("session cookie is Secure only over https", () => {
  expect(sessionCookie(req({}, "GET", "http://localhost/"), "t")).not.toContain("Secure");
  expect(sessionCookie(req({}, "GET", "https://mybase.example.com/"), "t")).toContain("Secure");
  expect(sessionCookie(req({}), null)).toContain("Max-Age=0");
});

describe("LoginThrottle", () => {
  test("locks out after the free attempts and doubles", () => {
    const t = new LoginThrottle(3, 1000, 10_000);
    for (let i = 0; i < 2; i++) t.fail("ip", 0);
    expect(t.retryAfter("ip", 0)).toBe(0);
    t.fail("ip", 0);
    expect(t.retryAfter("ip", 0)).toBe(1);
    t.fail("ip", 0);
    expect(t.retryAfter("ip", 0)).toBe(2);
    expect(t.retryAfter("other", 0)).toBe(0);
    t.succeed("ip");
    expect(t.retryAfter("ip", 0)).toBe(0);
  });
  test("caps the lockout", () => {
    const t = new LoginThrottle(1, 1000, 5000);
    for (let i = 0; i < 20; i++) t.fail("ip", 0);
    expect(t.retryAfter("ip", 0)).toBe(5);
  });
});

describe("RateLimit", () => {
  test("allows up to the limit per window, then resets", () => {
    const limit = new RateLimit(10, 1000);
    expect(limit.take("a", 6, 0)).toBe(true);
    expect(limit.take("a", 5, 10)).toBe(false);
    expect(limit.take("a", 4, 20)).toBe(true);
    expect(limit.take("a", 1, 30)).toBe(false);
    expect(limit.take("b", 10, 30)).toBe(true);
    expect(limit.take("a", 10, 1000)).toBe(true);
  });
});

describe("CIDRs", () => {
  const nets = ["10.0.0.0/8", "192.168.1.7", "2001:db8::/32"].map((n) => parseCidr(n)!);
  test.each(["10.9.8.7", "192.168.1.7", "::ffff:10.0.0.1", "2001:db8::1"])("%s is inside", (ip) => expect(inNets(ip, nets)).toBe(true));
  test.each(["11.0.0.1", "192.168.1.8", "2001:db9::1", "nope"])("%s is outside", (ip) => expect(inNets(ip, nets)).toBe(false));
  test("bad CIDRs don't parse", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("300.1.1.1")).toBeNull();
    expect(parseCidr("cloudflare")).toBeNull();
  });
});

describe("clientIp and proxy trust", () => {
  const server = (address: string) => ({ requestIP: () => ({ address }) }) as unknown as Parameters<typeof clientIp>[1];
  const withTrust = (value: string | undefined, fn: () => void) => {
    const before = process.env.MYBASE_TRUST_PROXY;
    if (value === undefined) delete process.env.MYBASE_TRUST_PROXY;
    else process.env.MYBASE_TRUST_PROXY = value;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env.MYBASE_TRUST_PROXY;
      else process.env.MYBASE_TRUST_PROXY = before;
    }
  };
  const cf = () => req({ "CF-Connecting-IP": "9.9.9.9", "CF-IPCountry": "DE", "X-Forwarded-Proto": "https" }, "GET");

  test("headers are ignored without MYBASE_TRUST_PROXY", () =>
    withTrust(undefined, () => {
      const r = cf();
      expect(clientIp(r, server("172.18.0.5"))).toBe("172.18.0.5");
      expect(isHttps(r)).toBe(false);
    }));
  test("cloudflare: believed from the tunnel container", () =>
    withTrust("cloudflare", () => {
      const r = cf();
      expect(clientIp(r, server("172.18.0.5"))).toBe("9.9.9.9");
      expect(trustedCountry(r)).toBe("DE");
      expect(isHttps(r)).toBe(true);
    }));
  test("cloudflare: ignored when sent straight to an exposed port", () =>
    withTrust("cloudflare", () => {
      const r = cf();
      expect(clientIp(r, server("203.0.113.50"))).toBe("203.0.113.50");
      expect(trustedCountry(r)).toBeNull();
      expect(isHttps(r)).toBe(false);
    }));
  test("cloudflare: believed from Cloudflare's own ranges", () => withTrust("cloudflare", () => expect(clientIp(cf(), server("104.16.1.1"))).toBe("9.9.9.9")));
  test("CIDR list: X-Forwarded-For from a listed proxy, skipping proxy hops", () =>
    withTrust("10.0.0.0/8", () => {
      const r = req({ "X-Forwarded-For": "6.6.6.6, 8.8.4.4, 10.0.0.3", "X-Forwarded-Proto": "https" }, "GET");
      expect(clientIp(r, server("10.0.0.2"))).toBe("8.8.4.4");
      expect(isHttps(r)).toBe(true);
    }));
  test("CIDR list: ignored from anyone else", () =>
    withTrust("10.0.0.0/8", () => expect(clientIp(req({ "X-Forwarded-For": "1.2.3.4" }, "GET"), server("198.51.100.1"))).toBe("198.51.100.1")));
});

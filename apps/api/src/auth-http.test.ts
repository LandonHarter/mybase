import { describe, expect, test } from "bun:test";
import { bearerToken, crossOrigin, isPrivateIp, LoginThrottle, RateLimit, readCookie, sessionCookie } from "./auth-http";

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

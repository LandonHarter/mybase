import { describe, expect, test } from "bun:test";
import { activeType, dashboardCsp, dashboardHeaders, inlineScriptHashes, objectHeaders, setMissing } from "./security-headers";

describe("activeType", () => {
  test.each(["text/html", "text/html; charset=utf-8", "image/svg+xml", "application/xhtml+xml", "application/rss+xml", "text/javascript", "application/wasm", "", "nonsense"])(
    "%p is active",
    (type) => expect(activeType(type)).toBe(true),
  );
  test.each(["image/png", "image/jpeg", "video/mp4", "application/pdf", "text/plain", "application/json", "font/woff2", "text/css"])("%p is passive", (type) =>
    expect(activeType(type)).toBe(false),
  );
  test("missing type is active", () => expect(activeType(undefined)).toBe(true));
});

describe("objectHeaders", () => {
  test("passive types stay inline but sandboxed", () => {
    const headers = objectHeaders("image/png", "a.png");
    expect(headers["Content-Disposition"]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toContain("sandbox");
  });
  test("active types download as octet-stream", () => {
    const headers = objectHeaders("text/html", "x y.html");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toBe("attachment; filename*=UTF-8''x%20y.html");
  });
});

describe("dashboard CSP", () => {
  test("hashes inline scripts only", async () => {
    const html = `<script>alert(1)</script><script type="module" src="./a.js"></script><script data-x="1">b()</script>`;
    const hashes = await inlineScriptHashes(html);
    expect(hashes).toHaveLength(2);
    // echo -n 'alert(1)' | openssl dgst -sha256 -binary | base64
    expect(hashes[0]).toBe("'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
  });
  test("policy blocks framing and other inline script", () => {
    const csp = dashboardCsp(["'sha256-abc'"]);
    expect(csp).toContain("script-src 'self' 'sha256-abc'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });
  test("HSTS only over https; CSP only when built", () => {
    expect(dashboardHeaders(null, false)["Strict-Transport-Security"]).toBeUndefined();
    expect(dashboardHeaders(null, false)["Content-Security-Policy"]).toBeUndefined();
    expect(dashboardHeaders("default-src 'self'", true)["Strict-Transport-Security"]).toContain("max-age");
  });
});

test("setMissing keeps headers the handler set", () => {
  const res = new Response("", { headers: { "Referrer-Policy": "origin" } });
  setMissing(res, { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
  expect(res.headers.get("Referrer-Policy")).toBe("origin");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
});

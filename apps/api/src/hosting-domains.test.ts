import { describe, expect, test } from "bun:test";
import { cloudflare } from "@mybase/shared/cloudflare";
import { ConflictError } from "./errors";
import { certNote, checkHostname, hostsOf, normalizeHostname, routeDomain, unrouteDomain, type DnsConfig } from "./hosting-domains";

const rules = { hostingDomain: "hangdong.lol", ownHosts: ["mybase.hangdong.lol", "s3.hangdong.lol"] };

describe("checkHostname", () => {
  const ok = (h: string) => expect(() => checkHostname(normalizeHostname(h), rules)).not.toThrow();
  const bad = (h: string, msg: string) => expect(() => checkHostname(normalizeHostname(h), rules)).toThrow(msg);

  test("accepts apex and subdomains of other zones", () => {
    ok("shop.com");
    ok("WWW.Shop.com.");
    ok("blog.other.dev");
  });
  test("accepts the base domain's apex and deeper names", () => {
    ok("hangdong.lol");
    ok("a.b.hangdong.lol");
  });
  test("refuses one label under the base domain (site space)", () => {
    bad("web.hangdong.lol", 'site named "web"');
  });
  test("refuses mybase's own hosts, wildcards, localhost, junk", () => {
    bad("mybase.hangdong.lol", "mybase's own");
    bad("*.shop.com", "wildcard");
    bad("web.localhost", "localhost");
    bad("not a host", "isn't a hostname");
    bad("shop", "isn't a hostname");
  });
});

test("hostsOf reads URLs and bare hosts", () => {
  expect(hostsOf(["https://Mybase.example.com", "db.example.com", "s3.example.com:3900", undefined])).toEqual(["mybase.example.com", "db.example.com", "s3.example.com"]);
});

test("certNote only for names two levels under the zone", () => {
  expect(certNote("shop.com", "shop.com")).toBeNull();
  expect(certNote("www.shop.com", "shop.com")).toBeNull();
  expect(certNote("a.b.shop.com", "shop.com")).toContain("Advanced Certificate Manager");
});

type Call = { method: string; path: string; body?: unknown };

/** A fake Cloudflare: `records` are what's at the name; creates and deletes are recorded. */
function fakeDns(records: { id: string; type: string; name: string; content: string }[], zones = [{ id: "z1", name: "shop.com", account: { id: "a", name: "a" } }]) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let result: unknown = {};
    if (method === "GET" && path === "/zones") result = zones;
    else if (method === "GET" && path.endsWith("/dns_records")) result = records;
    else if (method === "POST" && path.endsWith("/dns_records")) result = { id: "new", ...(JSON.parse(String(init!.body)) as object) };
    return Response.json({ success: true, errors: [], result });
  }) as typeof fetch;
  const dns: DnsConfig = { tunnelId: "tun", cf: cloudflare("tok", fetcher), hostingPort: 80 };
  return { calls, dns };
}

describe("routeDomain", () => {
  const opts = { replace: false, throwOnConflict: true };

  test("manual without a token or tunnel", async () => {
    const r = await routeDomain("shop.com", "web", { tunnelId: "tun", cf: null, hostingPort: 80 }, opts);
    expect(r.status).toBe("manual");
    expect(r.instructions).toContain("tun.cfargotunnel.com");
    const noTunnel = await routeDomain("shop.com", "web", { tunnelId: null, cf: null, hostingPort: 8080 }, opts);
    expect(noTunnel.instructions).toContain("port 8080");
  });

  test("creates a proxied CNAME to the tunnel", async () => {
    const { calls, dns } = fakeDns([]);
    const r = await routeDomain("shop.com", "web", dns, opts);
    expect(r).toMatchObject({ status: "active", zoneId: "z1", recordId: "new" });
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ type: "CNAME", name: "shop.com", content: "tun.cfargotunnel.com", proxied: true, comment: "mybase hosting web" });
  });

  test("reuses a CNAME already pointing at the tunnel, ignores MX/TXT", async () => {
    const { calls, dns } = fakeDns([
      { id: "r1", type: "CNAME", name: "shop.com", content: "tun.cfargotunnel.com" },
      { id: "r2", type: "MX", name: "shop.com", content: "mx.mail.com" },
    ]);
    expect(await routeDomain("shop.com", "web", dns, opts)).toMatchObject({ status: "active", recordId: "r1" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("an existing A record conflicts unless replaced", async () => {
    const records = [{ id: "r1", type: "A", name: "shop.com", content: "1.2.3.4" }];
    expect(routeDomain("shop.com", "web", fakeDns(records).dns, opts)).rejects.toBeInstanceOf(ConflictError);
    expect(await routeDomain("shop.com", "web", fakeDns(records).dns, { replace: false, throwOnConflict: false })).toMatchObject({ status: "error" });
    const { calls, dns } = fakeDns(records);
    expect(await routeDomain("shop.com", "web", dns, { replace: true, throwOnConflict: true })).toMatchObject({ status: "active" });
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /zones/z1/dns_records/r1", "POST /zones/z1/dns_records"]);
  });

  test("an error when no zone matches", async () => {
    const { dns } = fakeDns([], []);
    expect(await routeDomain("shop.com", "web", dns, opts)).toMatchObject({ status: "error" });
  });
});

test("unrouteDomain deletes only mybase's record", async () => {
  const mine = fakeDns([{ id: "r1", type: "CNAME", name: "shop.com", content: "tun.cfargotunnel.com" }]);
  await unrouteDomain("shop.com", "z1", "r1", mine.dns);
  expect(mine.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/zones/z1/dns_records/r1" });

  const changed = fakeDns([{ id: "r1", type: "CNAME", name: "shop.com", content: "elsewhere.example.net" }]);
  await unrouteDomain("shop.com", "z1", "r1", changed.dns);
  expect(changed.calls.some((c) => c.method === "DELETE")).toBe(false);
});

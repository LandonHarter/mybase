import { expect, test } from "bun:test";
import { cloudflare, CloudflareError, zoneOf } from "./cloudflare";

type Call = { method: string; path: string; body?: unknown };

/** A fake Cloudflare API: `routes` maps "METHOD /path" (no query) to a result. */
function fake(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path: `${path}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return Response.json({ success: false, errors: [{ code: 1, message: `no route ${key}` }] }, { status: 404 });
    return Response.json({ success: true, errors: [], result: routes[key] });
  }) as typeof fetch;
  return { calls, cf: cloudflare("tok", fetcher) };
}

test("ensureTunnel reuses a tunnel with the same name", async () => {
  const { cf, calls } = fake({ "GET /accounts/a/cfd_tunnel": [{ id: "t1", name: "mybase-pi" }] });
  expect(await cf.ensureTunnel("a", "mybase-pi")).toEqual({ id: "t1", name: "mybase-pi", created: false });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
});

test("ensureTunnel creates a remotely managed tunnel", async () => {
  const { cf, calls } = fake({ "GET /accounts/a/cfd_tunnel": [], "POST /accounts/a/cfd_tunnel": { id: "t2", name: "mybase-pi" } });
  expect(await cf.ensureTunnel("a", "mybase-pi")).toMatchObject({ id: "t2", created: true });
  expect(calls[1]!.body).toEqual({ name: "mybase-pi", config_src: "cloudflare" });
});

test("putIngress ends with a catch-all 404", async () => {
  const { cf, calls } = fake({ "PUT /accounts/a/cfd_tunnel/t/configurations": {} });
  await cf.putIngress("a", "t", [{ hostname: "mybase.x.com", service: "http://mybase:4000" }]);
  expect(calls[0]!.body).toEqual({ config: { ingress: [{ hostname: "mybase.x.com", service: "http://mybase:4000" }, { service: "http_status:404" }] } });
});

test("upsertCname updates an existing record, creates a missing one", async () => {
  const existing = fake({ "GET /zones/z/dns_records": [{ id: "r1", type: "A", name: "s3.x.com", content: "1.2.3.4" }], "PUT /zones/z/dns_records/r1": {} });
  await existing.cf.upsertCname("z", "s3.x.com", "t");
  expect(existing.calls[1]).toMatchObject({ method: "PUT", body: { type: "CNAME", content: "t.cfargotunnel.com", proxied: true } });

  const missing = fake({ "GET /zones/z/dns_records": [], "POST /zones/z/dns_records": {} });
  await missing.cf.upsertCname("z", "s3.x.com", "t");
  expect(missing.calls[1]).toMatchObject({ method: "POST", path: "/zones/z/dns_records" });
});

test("a refused token names the permissions it needs", async () => {
  const fetcher = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })) as unknown as typeof fetch;
  const err = await cloudflare("bad", fetcher).listZones().catch((e) => e);
  expect(err).toBeInstanceOf(CloudflareError);
  expect(err.message).toContain("Cloudflare Tunnel › Edit");
});

test("zoneOf picks the longest zone the host belongs to", () => {
  const zones = [{ name: "example.com" }, { name: "pi.example.com" }, { name: "other.com" }];
  expect(zoneOf(zones, "db.example.com")?.name).toBe("example.com");
  expect(zoneOf(zones, "db.pi.example.com")?.name).toBe("pi.example.com");
  expect(zoneOf(zones, "Example.com.")?.name).toBe("example.com");
  expect(zoneOf(zones, "notexample.com")).toBeNull();
});

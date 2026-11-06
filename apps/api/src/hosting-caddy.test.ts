import { expect, test } from "bun:test";
import { caddyConfig } from "./hosting-caddy";

test("one route per site, then a 404 fallback", () => {
  const config = caddyConfig([{ hosts: ["web.example.com", "web.localhost"], dial: "mybase-site-web-1234abcd:3000" }]);
  const server = config.apps.http.servers.sites;
  expect(server.listen).toEqual([":80"]);
  expect(server.automatic_https.disable).toBe(true);
  expect(server.routes).toHaveLength(2);
  expect(server.routes[0]).toEqual({
    match: [{ host: ["web.example.com", "web.localhost"] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "mybase-site-web-1234abcd:3000" }] }],
    terminal: true,
  });
  expect(server.routes[1]!.handle[0]).toMatchObject({ handler: "static_response", status_code: 404 });
  // The admin API keeps listening where it did (the unix socket in production).
  expect(config.admin.listen).toStartWith("unix//run/caddy/admin.sock");
});

test("custom domains share the site's route", () => {
  const config = caddyConfig([{ hosts: ["web.example.com", "shop.com", "www.shop.com", "web.localhost"], dial: "mybase-site-web-1234abcd:3000" }]);
  expect(config.apps.http.servers.sites.routes[0]).toMatchObject({ match: [{ host: ["web.example.com", "shop.com", "www.shop.com", "web.localhost"] }] });
});

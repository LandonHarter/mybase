import { describe, expect, test } from "bun:test";
import type { ServiceRoute } from "@mybase/shared";
import { onServerHost, pickHint, reachQuery } from "./reach";

const routes: ServiceRoute[] = [
  { route: "internal", on: true, host: "postgres", port: 5432 },
  { route: "localhost", on: true, host: "127.0.0.1", port: 5432 },
  { route: "lan", on: true, host: "192.168.1.20", port: 5432 },
  { route: "tailscale", on: true, host: "box.ts.net", port: 5432 },
  { route: "public", on: false, host: "", port: 5432 },
  { route: "proxy", on: true, host: "127.0.0.1", port: 0 },
];
const only = (...hosts: string[]) => async (host: string) => hosts.includes(host);

describe("pickHint", () => {
  test("localhost only on the server itself", async () => {
    expect(await pickHint("database", routes, true, only("127.0.0.1", "192.168.1.20"))).toBe("localhost");
    // A laptop's own Postgres on 5432 must not win.
    expect(await pickHint("database", routes, false, only("127.0.0.1", "192.168.1.20"))).toBe("lan");
  });
  test("LAN, then Tailscale", async () => {
    expect(await pickHint("database", routes, false, only("box.ts.net"))).toBe("tailscale");
  });
  test("off routes aren't tried; nothing reachable → proxy for the database, none otherwise", async () => {
    expect(await pickHint("database", routes, false, only())).toBe("proxy");
    expect(await pickHint("cache", routes, false, only())).toBe("none");
  });
  test("internal names are never picked from a client", async () => {
    expect(await pickHint("cache", routes, false, only("postgres"))).toBe("none");
  });
});

describe("onServerHost", () => {
  test("loopback API URLs", () => {
    expect(onServerHost("http://localhost:4000", {})).toBe(true);
    expect(onServerHost("http://127.0.0.1:4000", {})).toBe(true);
  });
  test("an address of this machine", () => {
    const ifaces = { eth0: [{ address: "192.168.1.20", family: "IPv4" }] } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(onServerHost("http://192.168.1.20:4000", ifaces)).toBe(true);
    expect(onServerHost("https://mybase.example.com", ifaces)).toBe(false);
  });
});

test("reachQuery", () => {
  expect(reachQuery({ hints: { database: "proxy", cache: "lan" }, needsProxy: true }, 54321)).toBe("?routes=database%3Aproxy%2Ccache%3Alan&proxy=54321");
  expect(reachQuery({ hints: {}, needsProxy: false }, null)).toBe("");
});

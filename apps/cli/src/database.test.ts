import { expect, test } from "bun:test";
import type { DatabaseAccess } from "@mybase/shared";
import { accessTable } from "./database";

test("database access shows each route, on/off, and where", () => {
  const access: DatabaseAccess = {
    project: "lastlayer",
    wsUrl: "wss://mybase.example.com/db",
    public: { enabled: false, tlsActive: false, host: null, problem: null },
    routes: [
      { route: "internal", on: true, host: "postgres", port: 5432, note: "hosted sites (project network)" },
      { route: "lan", on: true, host: "192.168.1.20", port: 5432 },
      { route: "public", on: false, host: "", port: 5432, note: "off" },
      { route: "proxy", on: true, host: "127.0.0.1", port: 0 },
    ],
  };
  const lines = accessTable(access);
  expect(lines[0]).toMatch(/^hosting network\s+on\s+postgres:5432\s+hosted sites/);
  expect(lines[2]).toMatch(/^public\s+off\s+off$/);
  expect(lines[3]).toMatch(/^wss proxy\s+on\s+wss:\/\/mybase\.example\.com\/db$/);
});

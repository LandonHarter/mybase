import { describe, expect, test } from "bun:test";
import type { LinkRef } from "@mybase/shared";
import { findOwnCredentials } from "./secrets-doctor";
import { defaultSslmode, isTailscale, linkKeys, LinkError, maskSecrets, parseHints, pickRoute, resolveRef, topology, type LinkCredentials, type ResolveContext, type TopologyState } from "./secrets-resolve";

// What compose passes the API on a server set up for the LAN (see docker/compose.yml).
const ENV = {
  POSTGRES_HOST: "postgres",
  POSTGRES_PORT: "5432",
  MYBASE_DB_PUBLIC_PORT: "5432",
  VALKEY_HOST: "valkey",
  VALKEY_PORT: "6379",
  MYBASE_CACHE_PUBLIC_PORT: "6379",
  GARAGE_S3_URL: "http://garage:3900",
  MYBASE_S3_PUBLIC_URL: "https://s3.example.com",
  MYBASE_PUBLIC_URL: "https://mybase.example.com",
  MYBASE_LAN_HOST: "192.168.1.20",
  MYBASE_TAILSCALE_HOST: "box.tail1234.ts.net",
  MYBASE_HOST_PORT: "4000",
  MYBASE_S3_HOST_PORT: "3900",
};
const STATE: TopologyState = {
  dbPublic: { enabled: false, tlsActive: false, host: "db.example.com", port: 5432 },
  hostingOn: true,
  wsUrl: "wss://mybase.example.com/db",
};
const PUBLIC_ON: TopologyState = { ...STATE, dbPublic: { ...STATE.dbPublic, enabled: true, tlsActive: true } };

const creds = (password = "s3cret"): LinkCredentials => ({
  database: { password },
  cache: { password: "cachepw" },
  storage: { accessKeyId: "GKabc", secretAccessKey: "storagesecret" },
  apiKey: "mb_key",
});
const storage = { bucket: "lastlayer", region: "garage" };
const db: LinkRef = { service: "database", field: "url", route: "auto" };
const hosting: ResolveContext = { kind: "hosting" };
const client = (hints: Extract<ResolveContext, { kind: "client" }>["hints"] = {}, proxyPort: number | null = null): ResolveContext => ({ kind: "client", hints, proxyPort });
const resolve = (ref: LinkRef, ctx: ResolveContext, state = STATE, c = creds(), env: Record<string, string> = ENV) =>
  resolveRef("lastlayer", ref, c, topology(env, state), ctx, storage);

describe("resolution per reader", () => {
  test("hosted sites get the project network's names, TLS off", () => {
    expect(resolve(db, hosting)).toEqual({ value: "postgres://lastlayer:s3cret@postgres:5432/lastlayer?sslmode=disable", route: "internal" });
    expect(resolve({ service: "cache", field: "url", route: "auto" }, hosting).value).toBe("redis://lastlayer:cachepw@valkey:6379");
    expect(resolve({ service: "storage", field: "endpoint", route: "auto" }, hosting).value).toBe("http://garage:3900");
    expect(resolve({ service: "api", field: "url", route: "auto" }, hosting).value).toBe("http://mybase:4000");
  });

  test("hosted sites stay internal even when public Postgres is on", () => {
    expect(resolve(db, hosting, PUBLIC_ON).value).toContain("@postgres:5432/");
  });

  test("the CLI's probe decides the route", () => {
    expect(resolve(db, client({ database: "lan" })).value).toBe("postgres://lastlayer:s3cret@192.168.1.20:5432/lastlayer?sslmode=disable");
    expect(resolve(db, client({ database: "tailscale" })).value).toContain("@box.tail1234.ts.net:5432/");
    expect(resolve(db, client({ database: "localhost" })).value).toContain("@127.0.0.1:5432/");
    expect(resolve(db, client({ database: "proxy" }, 54321))).toEqual({ value: "postgres://lastlayer:s3cret@127.0.0.1:54321/lastlayer?sslmode=disable", route: "proxy" });
    expect(resolve(db, client({ database: "public" }), PUBLIC_ON).value).toBe("postgres://lastlayer:s3cret@db.example.com:5432/lastlayer?sslmode=require");
  });

  test("readers without hints get public first, then LAN", () => {
    expect(resolve(db, client(), PUBLIC_ON).route).toBe("public");
    expect(resolve(db, client()).route).toBe("lan");
    const noLan = { ...ENV, MYBASE_LAN_HOST: "", MYBASE_TAILSCALE_HOST: "" };
    expect(resolve(db, client(), STATE, creds(), noLan).route).toBe("localhost");
  });

  test("an env's route override beats the reader's hint", () => {
    expect(resolve({ ...db, route: "tailscale" }, client({ database: "lan" })).route).toBe("tailscale");
    expect(resolve({ ...db, route: "public" }, hosting, PUBLIC_ON).value).toContain("@db.example.com:5432/");
  });

  test("no reachable route fails with a fix, not a dead URL", () => {
    expect(() => resolve(db, client({ database: "none" }))).toThrow(/can't reach database from this machine.*mybase database access lastlayer/);
    expect(() => resolve({ ...db, route: "public" }, client())).toThrow(/route "public" is off/);
    expect(() => resolve({ ...db, route: "proxy" }, client())).toThrow(/mybase run/);
    const bound = { ...ENV, MYBASE_DB_HOST_BIND: "127.0.0.1" };
    expect(() => resolve({ ...db, route: "lan" }, client(), STATE, creds(), bound)).toThrow(/bound to 127.0.0.1/);
  });

  test("HTTP services use their public URL when it's https", () => {
    expect(resolve({ service: "storage", field: "endpoint", route: "auto" }, client()).value).toBe("https://s3.example.com");
    expect(resolve({ service: "api", field: "url", route: "auto" }, client({ api: "lan" })).value).toBe("http://192.168.1.20:4000");
    expect(resolve({ service: "storage", field: "secretAccessKey", route: "auto" }, client()).value).toBe("storagesecret");
    expect(resolve({ service: "storage", field: "bucket", route: "auto" }, hosting).value).toBe("lastlayer");
  });

  test("a rotation reaches every link (credentials are read at resolve time)", () => {
    expect(resolve(db, hosting, STATE, creds("old")).value).toContain(":old@");
    expect(resolve(db, hosting, STATE, creds("new")).value).toContain(":new@");
  });

  test("missing credentials ask for link again", () => {
    expect(() => resolve(db, hosting, STATE, {})).toThrow(LinkError);
  });
});

describe("sslmode and params", () => {
  test("defaults by route", () => {
    expect(defaultSslmode("public")).toBe("require");
    for (const r of ["internal", "localhost", "lan", "tailscale", "proxy"] as const) expect(defaultSslmode(r)).toBe("disable");
  });
  test("explicit sslmode and extra params", () => {
    const ref: LinkRef = { ...db, sslmode: "verify-full", params: { connection_limit: "10" } };
    expect(resolve(ref, client({ database: "lan" })).value).toBe("postgres://lastlayer:s3cret@192.168.1.20:5432/lastlayer?sslmode=verify-full&connection_limit=10");
  });
  test("cache params", () => {
    expect(resolve({ service: "cache", field: "url", route: "auto", params: { family: "6" } }, hosting).value).toBe("redis://lastlayer:cachepw@valkey:6379?family=6");
  });
});

describe("topology", () => {
  test("a Tailscale address in MYBASE_PUBLIC_HOST counts as tailscale, not LAN", () => {
    const t = topology({ ...ENV, MYBASE_LAN_HOST: "100.101.102.103", MYBASE_TAILSCALE_HOST: "" }, STATE);
    expect(t.database.find((r) => r.route === "lan")?.on).toBe(false);
    expect(t.database.find((r) => r.route === "tailscale")).toMatchObject({ on: true, host: "100.101.102.103" });
  });
  test("isTailscale", () => {
    expect(isTailscale("100.64.0.1")).toBe(true);
    expect(isTailscale("100.128.0.1")).toBe(false);
    expect(isTailscale("pi.tail-net.ts.net")).toBe(true);
    expect(isTailscale("192.168.1.2")).toBe(false);
  });
  test("internal is off without hosting", () => {
    expect(topology(ENV, { ...STATE, hostingOn: false }).database[0]).toMatchObject({ route: "internal", on: false });
  });
  test("public waits for the certificate", () => {
    const t = topology(ENV, { ...STATE, dbPublic: { ...STATE.dbPublic, enabled: true } });
    expect(t.database.find((r) => r.route === "public")).toMatchObject({ on: false, note: "waiting for the certificate" });
  });
});

describe("helpers", () => {
  test("pickRoute in hosting ignores proxy", () => {
    expect(pickRoute("p", { ...db, route: "proxy" }, topology(ENV, STATE), hosting).route).toBe("internal");
  });
  test("parseHints", () => {
    expect(parseHints("database:lan,cache:none,storage:auto,bogus:x,api:public")).toEqual({ database: "lan", cache: "none", api: "public" });
    expect(parseHints(null)).toEqual({});
  });
  test("linkKeys", () => {
    expect(linkKeys("database", undefined, { includeKey: true })).toEqual([["DATABASE_URL", "url"]]);
    expect(linkKeys("database", "PG_URL", { includeKey: true })).toEqual([["PG_URL", "url"]]);
    expect(linkKeys("storage", undefined, { includeKey: true }).map(([k]) => k)).toEqual(["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(() => linkKeys("storage", "X", { includeKey: true })).toThrow(/--as works for one key/);
  });
  test("maskSecrets", () => {
    expect(maskSecrets("Can't reach postgres://lastlayer:hunter2@db.example.com:5432/lastlayer")).toBe("Can't reach postgres://lastlayer:***@db.example.com:5432/lastlayer");
    expect(maskSecrets("redis://u:p@valkey:6379 and http://x.com/a@b")).toBe("redis://u:***@valkey:6379 and http://x.com/a@b");
  });
});

describe("secrets doctor", () => {
  const facts = { storageKeyIds: ["GK123"], apiUrls: ["https://mybase.example.com", "http://192.168.1.20:4000"] };
  test("finds this project's own credentials", () => {
    const found = findOwnCredentials("lastlayer", "prod", {
      DATABASE_URL: "postgres://lastlayer:pw@db.hangdong.lol:5432/lastlayer?sslmode=require",
      DIRECT_URL: "postgresql://other:pw@x:5432/lastlayer",
      REDIS_URL: "redis://lastlayer:pw@192.168.1.20:6379",
      S3_ACCESS_KEY_ID: "GK123",
      MYBASE_URL: "https://mybase.example.com/",
      STRIPE_KEY: "sk_live_x",
      OTHER_DB: "postgres://someone:pw@elsewhere:5432/theirs",
    }, facts);
    expect(found.map((f) => [f.key, f.service])).toEqual([
      ["DATABASE_URL", "database"],
      ["DIRECT_URL", "database"],
      ["REDIS_URL", "cache"],
      ["S3_ACCESS_KEY_ID", "storage"],
      ["MYBASE_URL", "api"],
    ]);
    expect(found[0]!.host).toBe("db.hangdong.lol");
    expect(JSON.stringify(found)).not.toContain("pw");
  });
});

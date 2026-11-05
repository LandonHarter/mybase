import { describe, expect, test } from "bun:test";
import { envTargets, envWarning } from "./hosting-envcheck";

const internal = { database: "postgres:5432", cache: "valkey:6379", storage: "garage:3900", api: "mybase:4000" };

describe("envTargets", () => {
  test("URLs with a host, default ports by scheme, no passwords kept", () => {
    const t = envTargets({
      DATABASE_URL: "postgres://lastlayer:hunter2@db.hangdong.lol:5432/lastlayer?sslmode=require",
      REDIS_URL: "redis://lastlayer:pw@valkey",
      S3_ENDPOINT: "https://s3.example.com",
      MYBASE_SITE_URL: "https://lastlayer.example.com",
      NEXT_PUBLIC_NAME: "hello",
      FILE: "file:///tmp/x",
    });
    expect(t).toEqual([
      { key: "DATABASE_URL", host: "db.hangdong.lol", port: 5432, loopback: false, service: "database" },
      { key: "REDIS_URL", host: "valkey", port: 6379, loopback: false, service: "cache" },
      { key: "S3_ENDPOINT", host: "s3.example.com", port: 443, loopback: false, service: "storage" },
    ]);
    expect(JSON.stringify(t)).not.toContain("hunter2");
  });
  test("same host:port once; localhost flagged", () => {
    const t = envTargets({ A: "postgres://x@localhost/db", B: "postgres://y@localhost:5432/db" });
    expect(t).toHaveLength(1);
    expect(t[0]!.loopback).toBe(true);
  });
});

describe("envWarning", () => {
  const [db] = envTargets({ DATABASE_URL: "postgres://lastlayer:pw@db.hangdong.lol:5432/lastlayer" });
  test("the message from the deploy, with the fix", () => {
    expect(envWarning(db!, { project: "lastlayer", site: "lastlayer", secretsEnv: "prod", internal })).toBe(
      [
        "DATABASE_URL → db.hangdong.lol:5432 unreachable from site network.",
        "This project's Postgres is reachable here as postgres:5432. Run:",
        "  mybase secrets link -p lastlayer -e prod --database",
        "  mybase hosting redeploy lastlayer lastlayer",
      ].join("\n"),
    );
  });
  test("no secrets env: set one first", () => {
    expect(envWarning(db!, { project: "p", site: "web", secretsEnv: null, internal })).toContain("mybase hosting set p web --secrets-env prod\n  mybase secrets link -p p -e prod --database");
  });
  test("other key names use --as", () => {
    const [t] = envTargets({ DIRECT_URL: "postgresql://p:pw@1.2.3.4/p" });
    expect(envWarning(t!, { project: "p", site: "web", secretsEnv: "prod", internal })).toContain("--database --as DIRECT_URL");
  });
  test("localhost inside a container", () => {
    const [t] = envTargets({ REDIS_URL: "redis://p:pw@127.0.0.1:6379" });
    expect(envWarning(t!, { project: "p", site: "web", secretsEnv: "prod", internal })).toMatch(/^REDIS_URL → 127\.0\.0\.1:6379: inside the container, 127\.0\.0\.1 is the site itself/);
  });
  test("unknown services get a generic hint", () => {
    const [t] = envTargets({ API_BASE: "https://api.other.com" });
    expect(envWarning(t!, { project: "p", site: "web", secretsEnv: "prod", internal })).toContain("Check the address");
  });
});

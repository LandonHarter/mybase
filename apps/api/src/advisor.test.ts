import { describe, expect, test } from "bun:test";
import type { ApiToken, DbPublicStatus } from "@mybase/shared";
import { insecurePublicUrl, instanceFindings, projectFindings, weakSecret, type InstanceFacts, type ProjectFacts } from "./advisor";
import { requirement } from "./permissions";

const now = Date.parse("2026-10-27T00:00:00Z");
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

const token = (over: Partial<ApiToken>): ApiToken => ({
  id: "t",
  name: "ci",
  permissions: ["queue:write"],
  projects: null,
  environments: null,
  createdAt: daysAgo(200),
  lastUsedAt: null,
  ...over,
});

const dbPublic = (over: Partial<DbPublicStatus> = {}): DbPublicStatus => ({
  enabled: false,
  problem: null,
  host: "db.example.com",
  port: 5432,
  tls: { active: false, notAfter: null, issuedAt: null, staging: false, error: null, nextAttemptAt: null },
  dns: { ip: null, checkedAt: null, error: null },
  ...over,
});

const instance = (over: Partial<InstanceFacts> = {}): InstanceFacts => ({
  env: { POSTGRES_PASSWORD: "x".repeat(48), VALKEY_PASSWORD: "y".repeat(64), GARAGE_ADMIN_TOKEN: "z".repeat(64), MYBASE_PUBLIC_URL: "https://mybase.example.com" },
  mfaEnabled: true,
  secretsKeySet: true,
  secretsProjects: 0,
  tokens: [],
  untrustedCloudflare: false,
  controlSchemaPublic: false,
  dbPublic: dbPublic(),
  now,
  ...over,
});

const project = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  project: "shop",
  services: [],
  publicConnect: false,
  privilegedRole: [],
  publicSchemaCreate: false,
  publicGrants: [],
  rlsNotForced: [],
  noRls: [],
  definerNoSearchPath: [],
  publicFiles: false,
  analyticsAnyOrigin: false,
  ...over,
});

const ids = (findings: { id: string }[]) => findings.map((f) => f.id);

describe("instance checks", () => {
  test("a well-set-up instance has no findings", () => expect(instanceFindings(instance())).toEqual([]));

  test("2FA off", () => expect(ids(instanceFindings(instance({ mfaEnabled: false })))).toEqual(["admin-no-2fa"]));

  test("secrets key unset is critical only when secrets are in use", () => {
    expect(instanceFindings(instance({ secretsKeySet: false }))[0]!.severity).toBe("info");
    expect(instanceFindings(instance({ secretsKeySet: false, secretsProjects: 2 }))[0]!.severity).toBe("critical");
  });

  test("weak service secrets name the variables, never the values", () => {
    const [f] = instanceFindings(instance({ env: { ...instance().env, POSTGRES_PASSWORD: "change-me" } }));
    expect(f!.id).toBe("weak-service-secret");
    expect(f!.detail).toContain("POSTGRES_PASSWORD");
    expect(f!.detail).not.toContain("change-me");
  });

  test("stale tokens: admin ones warn, others are info, recent ones are fine", () => {
    const findings = instanceFindings(
      instance({
        tokens: [
          token({ name: "old-admin", permissions: ["admin"] }),
          token({ name: "old-app" }),
          token({ name: "new", createdAt: daysAgo(5) }),
          token({ name: "used", lastUsedAt: daysAgo(1) }),
        ],
      }),
    );
    expect(ids(findings)).toEqual(["admin-token-stale", "token-unused"]);
    expect(findings[0]!.detail).toContain("old-admin");
    expect(findings[1]!.detail).toContain("old-app");
    expect(findings[1]!.detail).not.toContain(`"used"`);
  });

  test("untrusted Cloudflare, leftover env, and an open control schema", () => {
    const findings = instanceFindings(instance({ untrustedCloudflare: true, controlSchemaPublic: true, env: { ...instance().env, MYBASE_ADMIN_PASSWORD: "p", MYBASE_SECRETS_KEY_OLD: "k" } }));
    expect(ids(findings).sort()).toEqual(["admin-password-in-env", "control-schema-public", "secrets-key-old-set", "tunnel-no-trust-proxy"]);
  });

  test("public Postgres", () => {
    const check = (over: Partial<DbPublicStatus>) => instanceFindings(instance({ dbPublic: dbPublic({ enabled: true, ...over }) }));
    const tls = dbPublic().tls;
    expect(check({ problem: "MYBASE_DNS_TOKEN is missing" }).map((f) => f.id)).toEqual(["db-public-off"]);
    // First request still running: nothing to say yet.
    expect(check({})).toEqual([]);
    expect(check({ tls: { ...tls, notAfter: daysAgo(-60) } })).toEqual([]);
    expect(check({ tls: { ...tls, notAfter: daysAgo(-5) } }).map((f) => [f.id, f.severity])).toEqual([["db-public-cert", "warn"]]);
    expect(check({ tls: { ...tls, error: "rate limited" } }).map((f) => [f.id, f.severity])).toEqual([["db-public-cert", "critical"]]);
    expect(check({ dns: { ip: null, checkedAt: null, error: "refused" } }).map((f) => f.id)).toEqual(["db-public-dns"]);
  });
});

describe("weakSecret", () => {
  test.each(["change-me", "short", "PASSWORD"])("%p is weak", (v) => expect(weakSecret(v)).toBe(true));
  test("long random values and unset ones pass", () => {
    expect(weakSecret("a3f9c1d2e4b5a6c7d8e9f0a1")).toBe(false);
    expect(weakSecret(undefined)).toBe(false);
  });
});

describe("insecurePublicUrl", () => {
  test.each(["http://mybase.example.com", "http://8.8.8.8:4000"])("%p is insecure", (u) => expect(insecurePublicUrl(u)).toBe(true));
  test.each(["https://mybase.example.com", "http://localhost:4000", "http://192.168.1.10:4000", "http://pi.local:4000", "http://pi:4000", "http://pi.tail1234.ts.net", "http://100.100.1.2", "nonsense", undefined])(
    "%p is fine",
    (u) => expect(insecurePublicUrl(u)).toBe(false),
  );
});

describe("project checks", () => {
  test("a clean project has no findings", () => expect(projectFindings(project())).toEqual([]));

  test("cross-project access is critical", () => {
    const findings = projectFindings(project({ publicConnect: true, privilegedRole: ["createrole"] }));
    expect(findings.every((f) => f.severity === "critical" && f.project === "shop")).toBe(true);
    expect(findings[1]!.fix).toContain('alter role "shop" nocreaterole');
  });

  test("tables without RLS only matter with app sign-in", () => {
    expect(ids(projectFindings(project({ noRls: ["public.orders"] })))).toEqual([]);
    expect(ids(projectFindings(project({ noRls: ["public.orders"], services: ["users"] })))).toEqual(["tables-no-rls"]);
  });

  test("long lists are cut", () => {
    const tables = Array.from({ length: 8 }, (_, i) => `public.t${i}`);
    expect(projectFindings(project({ rlsNotForced: tables }))[0]!.detail).toContain("and 3 more");
  });
});

test("project advisor needs projects:read; the instance report needs admin", () => {
  expect(requirement("GET", "/projects/shop/advisor")).toEqual({ resource: "projects", level: "read" });
  expect(requirement("GET", "/advisor")).toBe("admin");
});

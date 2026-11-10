import { describe, expect, test } from "bun:test";
import { allows, canSeeEnv, readGrant, requireAllEnvs, requireEnv, requirement, type Grant } from "./permissions";

const grant = (permissions: Grant["permissions"], projects: Grant["projects"] = null, environments: Grant["environments"] = null): Grant => ({
  permissions,
  projects,
  environments,
});

describe("registry back-compat", () => {
  const push = { resource: "registry", level: "write" } as const;
  const pull = { resource: "registry", level: "read" } as const;
  test("hosting grants cover the registry at the same level", () => {
    expect(allows(grant(["hosting:write"]), push, "shop")).toBe(true);
    expect(allows(grant(["hosting:read"]), pull, "shop")).toBe(true);
    expect(allows(grant(["hosting:read"]), push, "shop")).toBe(false);
    expect(allows(grant(["hosting:write"], ["shop"]), push, "other")).toBe(false);
  });
  test("registry grants don't cover hosting", () => {
    expect(allows(grant(["registry:write"]), { resource: "hosting", level: "write" }, "shop")).toBe(false);
    expect(allows(grant(["registry:write"]), push, "shop")).toBe(true);
  });
});

describe("requirement", () => {
  test.each([
    ["GET", "/projects", { resource: "projects", level: "read" }],
    ["POST", "/projects", { resource: "projects", level: "write" }],
    ["DELETE", "/projects/shop", { resource: "projects", level: "write" }],
    ["PUT", "/projects/shop/services/queue", { resource: "projects", level: "write" }],
    ["GET", "/projects/shop/files/a/b.png", { resource: "storage", level: "read" }],
    ["GET", "/projects/shop/hosting", { resource: "hosting", level: "read" }],
    ["POST", "/projects/shop/hosting/sites/web/deploys", { resource: "hosting", level: "write" }],
    ["GET", "/projects/shop/hosting/sites/web/domains", { resource: "hosting", level: "read" }],
    ["POST", "/projects/shop/hosting/sites/web/domains", { resource: "hosting", level: "write" }],
    ["DELETE", "/projects/shop/hosting/sites/web/domains/shop.com", { resource: "hosting", level: "write" }],
    ["POST", "/projects/shop/hosting/sites/web/domains/shop.com/verify", { resource: "hosting", level: "write" }],
    ["GET", "/v2/", "any"],
    ["GET", "/v2/_catalog", "admin"],
    ["HEAD", "/v2/shop/web/blobs/sha256:abc", { resource: "registry", level: "read" }],
    ["PATCH", "/v2/shop/web/blobs/uploads/123", { resource: "registry", level: "write" }],
    ["DELETE", "/v2/shop/tools/cli/manifests/sha256:abc", { resource: "registry", level: "write" }],
    ["GET", "/projects/shop/registry", { resource: "registry", level: "read" }],
    ["GET", "/projects/shop/registry/tags", { resource: "registry", level: "read" }],
    ["DELETE", "/projects/shop/registry/manifests", { resource: "registry", level: "write" }],
    ["GET", "/projects/shop/database/tables", { resource: "database", level: "read" }],
    ["PATCH", "/projects/shop/database/tables/public/t/rows", { resource: "database", level: "write" }],
    ["GET", "/projects/shop/queue/queues", { resource: "queue", level: "read" }],
    ["POST", "/queue/shop/queues/jobs/receive", { resource: "queue", level: "write" }],
    ["POST", "/ratelimit/shop/limit", { resource: "ratelimit", level: "write" }],
    ["POST", "/cache/shop/pipeline", { resource: "cache", level: "write" }],
    ["GET", "/cron/shop/tasks/abc", { resource: "cron", level: "read" }],
    ["GET", "/search/shop", { resource: "search", level: "read" }],
    ["GET", "/search/shop/fetch", { resource: "search", level: "read" }],
    ["GET", "/projects/shop/search/fetch", { resource: "search", level: "read" }],
    ["GET", "/projects/shop/secrets/envs/prod", { resource: "secrets", level: "read" }],
    ["POST", "/projects/shop/secrets/link", { resource: "secrets", level: "write" }],
    ["GET", "/secrets/shop/prod", { resource: "secrets", level: "read" }],
    ["PATCH", "/secrets/shop/prod", { resource: "secrets", level: "write" }],
    ["GET", "/projects/shop/vector", { resource: "vector", level: "read" }],
    ["POST", "/projects/shop/vector/indexes/docs/documents", { resource: "vector", level: "write" }],
    ["POST", "/projects/shop/vector/indexes/docs/query", { resource: "vector", level: "read" }],
    ["POST", "/vector/shop/indexes/docs/query", { resource: "vector", level: "read" }],
    ["POST", "/vector/shop/indexes/docs/documents/delete", { resource: "vector", level: "write" }],
    ["POST", "/email/shop/send", { resource: "email", level: "write" }],
    ["GET", "/email/shop/messages/x", { resource: "email", level: "read" }],
  ] as const)("%s %s", (method, path, want) => expect(requirement(method, path)).toEqual(want));

  test.each([
    ["POST", "/projects/shop/database/query"],
    ["PUT", "/projects/shop/database/extensions/vector"],
    ["PUT", "/projects/shop/vector"],
    ["GET", "/projects/shop/database/extensions"],
    ["GET", "/auth/tokens"],
    ["PUT", "/auth/password"],
    ["GET", "/projects/shop/something-new"],
    ["GET", "/somewhere/else"],
    ["POST", "/queue"],
    ["GET", "/email/status"],
  ])("%s %s needs admin", (method, path) => expect(requirement(method, path)).toBe("admin"));

  test("a project's email:read key can't read the instance's SES status", () => {
    const key: Grant = { permissions: ["email:read"], projects: ["shop"], environments: null };
    expect(allows(key, requirement("GET", "/email/status"), null)).toBe(false);
    expect(allows(key, requirement("GET", "/email/shop/messages/x"), "shop")).toBe(true);
  });

  test("signing out works with any key", () => expect(requirement("POST", "/auth/logout")).toBe("any"));

  test("MCP and project context take any key (checked per tool / per section)", () => {
    expect(requirement("POST", "/mcp")).toBe("any");
    expect(requirement("GET", "/projects/shop/context")).toBe("any");
    expect(requirement("POST", "/projects/shop/context")).toBe("admin");
    expect(requirement("GET", "/projects/shop/context/more")).toBe("admin");
    expect(requirement("POST", "/mcp/other")).toBe("admin");
  });

  test("the schema overview is a database read", () =>
    expect(requirement("GET", "/projects/shop/database/schema")).toEqual({ resource: "database", level: "read" }));
});

describe("allows", () => {
  const queueWrite = { resource: "queue", level: "write" } as const;
  const queueRead = { resource: "queue", level: "read" } as const;

  test("admin allows everything", () => {
    expect(allows(grant(["admin"]), "admin", null)).toBe(true);
    expect(allows(grant(["admin"]), queueWrite, "shop")).toBe(true);
  });
  test("write includes read", () => expect(allows(grant(["queue:write"]), queueRead, "shop")).toBe(true));
  test("read doesn't include write", () => expect(allows(grant(["queue:read"]), queueWrite, "shop")).toBe(false));
  test("other resources are denied", () => expect(allows(grant(["queue:write"]), { resource: "cache", level: "read" }, "shop")).toBe(false));
  test("only admin meets admin", () => expect(allows(grant(["queue:write", "projects:write"]), "admin", null)).toBe(false));
  test("any key meets any", () => expect(allows(grant(["queue:read"]), "any", null)).toBe(true));

  test("project lists", () => {
    const g = grant(["queue:write", "projects:write"], ["shop"]);
    expect(allows(g, queueWrite, "shop")).toBe(true);
    expect(allows(g, queueWrite, "blog")).toBe(false);
    // Lists outside one project are read (and filtered); creating a project is not.
    expect(allows(g, { resource: "projects", level: "read" }, null)).toBe(true);
    expect(allows(g, { resource: "projects", level: "write" }, null)).toBe(false);
  });
});

describe("readGrant", () => {
  test("dedupes and sorts", () => expect(readGrant(["queue:write", "cache:read", "queue:write"], null)).toEqual(grant(["cache:read", "queue:write"])));
  test("projects", () => expect(readGrant(["queue:write"], ["shop", "blog"])).toEqual(grant(["queue:write"], ["blog", "shop"])));
  test.each([[[]], [["queue"]], [["queue:delete"]], [["nope:read"]], [["queue:read:x"]], ["admin"]])("rejects permissions %j", (p) =>
    expect(() => readGrant(p, null)).toThrow(),
  );
  test("rejects bad projects", () => {
    expect(() => readGrant(["queue:read"], [])).toThrow();
    expect(() => readGrant(["queue:read"], ["Bad Name"])).toThrow();
    expect(() => readGrant(["admin"], ["shop"])).toThrow("admin");
  });
  test("environments", () => {
    expect(readGrant(["secrets:read"], ["shop"], ["prod", "dev", "prod"])).toEqual(grant(["secrets:read"], ["shop"], ["dev", "prod"]));
    expect(() => readGrant(["queue:read"], null, ["prod"])).toThrow("secrets");
    expect(() => readGrant(["admin"], null, ["prod"])).toThrow("admin");
    expect(() => readGrant(["secrets:read"], null, ["Prod!"])).toThrow();
    expect(() => readGrant(["secrets:read"], null, [])).toThrow();
  });
});

describe("secrets environments", () => {
  test("exact names only", () => {
    const g = grant(["secrets:read"], null, ["prod"]);
    expect(canSeeEnv(g, "prod")).toBe(true);
    expect(canSeeEnv(g, "prod_eu")).toBe(false);
    expect(canSeeEnv(grant(["secrets:read"]), "anything")).toBe(true);
  });
  test("limited keys can't manage environments", () => {
    expect(() => requireEnv(grant(["secrets:write"], null, ["prod"]), "dev")).toThrow("dev");
    expect(() => requireAllEnvs(grant(["secrets:write"], null, ["prod"]))).toThrow();
    expect(() => requireAllEnvs(grant(["secrets:write"]))).not.toThrow();
  });
});

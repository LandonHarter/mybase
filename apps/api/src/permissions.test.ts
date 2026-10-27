import { describe, expect, test } from "bun:test";
import { allows, readGrant, requirement, type Grant } from "./permissions";

const grant = (permissions: Grant["permissions"], projects: Grant["projects"] = null): Grant => ({ permissions, projects });

describe("requirement", () => {
  test.each([
    ["GET", "/projects", { resource: "projects", level: "read" }],
    ["POST", "/projects", { resource: "projects", level: "write" }],
    ["DELETE", "/projects/shop", { resource: "projects", level: "write" }],
    ["PUT", "/projects/shop/services/queue", { resource: "projects", level: "write" }],
    ["GET", "/projects/shop/files/a/b.png", { resource: "storage", level: "read" }],
    ["GET", "/projects/shop/database/tables", { resource: "database", level: "read" }],
    ["PATCH", "/projects/shop/database/tables/public/t/rows", { resource: "database", level: "write" }],
    ["GET", "/projects/shop/queue/queues", { resource: "queue", level: "read" }],
    ["POST", "/queue/shop/queues/jobs/receive", { resource: "queue", level: "write" }],
    ["POST", "/ratelimit/shop/limit", { resource: "ratelimit", level: "write" }],
    ["POST", "/cache/shop/pipeline", { resource: "cache", level: "write" }],
    ["GET", "/cron/shop/tasks/abc", { resource: "cron", level: "read" }],
  ] as const)("%s %s", (method, path, want) => expect(requirement(method, path)).toEqual(want));

  test.each([
    ["POST", "/projects/shop/database/query"],
    ["PUT", "/projects/shop/database/extensions/vector"],
    ["GET", "/projects/shop/database/extensions"],
    ["GET", "/auth/tokens"],
    ["PUT", "/auth/password"],
    ["GET", "/projects/shop/something-new"],
    ["GET", "/somewhere/else"],
    ["POST", "/queue"],
  ])("%s %s needs admin", (method, path) => expect(requirement(method, path)).toBe("admin"));

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
});

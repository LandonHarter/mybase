import { describe, expect, test } from "bun:test";
import { audit, auditOnce, autoEvent, cleanMeta, finishRequest, onAudit, outcomeFor, setAuditActor, withAuditScope, type AuditEvent } from "./audit";
import { requirement } from "./permissions";

const seen: AuditEvent[] = [];
onAudit((e) => seen.push(e));

describe("autoEvent", () => {
  test("reads aren't recorded", () => expect(autoEvent("GET", "/projects/shop/secrets")).toBeNull());

  test("named routes get named actions with project and target", () => {
    expect(autoEvent("DELETE", "/auth/tokens/abc")).toEqual({ action: "token.deleted", project: null, target: "abc" });
    expect(autoEvent("PUT", "/projects/shop/services/cache")).toEqual({ action: "service.enabled", project: "shop", target: "cache" });
    expect(autoEvent("PATCH", "/projects/shop/secrets/envs/prod/secrets")).toEqual({ action: "secrets.changed", project: "shop", target: "prod" });
    expect(autoEvent("POST", "/projects/shop/queue/sync")).toEqual({ action: "queue.synced", project: "shop", target: null });
    expect(autoEvent("DELETE", "/projects/shop/files/public/a%20b.png")?.target).toBe("public/a b.png");
  });

  test("unknown project routes fall back to <service>.changed", () => {
    expect(autoEvent("POST", "/projects/shop/newthing/x")).toEqual({ action: "newthing.changed", project: "shop", target: "POST /projects/shop/newthing/x" });
  });

  test("app data-plane calls are skipped", () => {
    for (const path of ["/cache/shop", "/cache/shop/pipeline", "/ratelimit/shop/limit", "/queue/shop/queues/jobs/receive", "/analytics/shop/events", "/vector/shop/indexes/docs/query", "/mcp"]) {
      expect(autoEvent("POST", path)).toBeNull();
    }
    // But destructive app calls are kept.
    expect(autoEvent("POST", "/queue/shop/queues/jobs/purge")?.action).toBe("queue.changed");
  });
});

describe("cleanMeta", () => {
  test("drops keys that could hold secrets and non-scalars", () => {
    expect(cleanMeta({ count: 3, password: "x", sql: "select", newValue: "v", nested: {} as never, ok: true })).toEqual({ count: 3, ok: true });
  });
  test("empty is null", () => expect(cleanMeta({ password: "x" })).toBeNull());
});

test("outcomeFor", () => {
  expect([200, 204, 302, 401, 403, 429, 400, 404, 500].map(outcomeFor)).toEqual(["ok", "ok", "ok", "denied", "denied", "denied", "failed", "failed", "failed"]);
});

describe("request scope", () => {
  test("explicit events replace the automatic one and take the response's outcome", () => {
    seen.length = 0;
    withAuditScope({ kind: "anonymous", id: null, name: null }, "10.0.0.1", "req1", () => {
      setAuditActor({ kind: "token", id: "t1", name: "ci" });
      audit({ action: "secrets.read", project: "shop", target: "prod" });
      finishRequest("PATCH", "/projects/shop/database", 403);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "secrets.read", outcome: "denied", ip: "10.0.0.1", requestId: "req1", actor: { kind: "token", id: "t1" } });
  });

  test("without explicit events, the automatic one is recorded", () => {
    seen.length = 0;
    withAuditScope({ kind: "session", id: null, name: "admin" }, "::1", "req2", () => finishRequest("DELETE", "/projects/shop", 204));
    expect(seen.map((e) => [e.action, e.outcome, e.project])).toEqual([["project.deleted", "ok", "shop"]]);
  });

  test("auditOnce dedupes per actor", () => {
    seen.length = 0;
    for (const id of ["a", "a", "b"]) {
      withAuditScope({ kind: "token", id, name: id }, "::1", "r", () => {
        auditOnce("secrets.read:shop:prod", 60_000, { action: "secrets.read" });
        finishRequest("GET", "/secrets/shop/prod", 200);
      });
    }
    expect(seen.map((e) => e.actor.id)).toEqual(["a", "b"]);
  });
});

test("audit permissions", () => {
  expect(requirement("GET", "/audit")).toEqual({ resource: "audit", level: "read" });
  expect(requirement("GET", "/audit/settings")).toEqual({ resource: "audit", level: "read" });
  expect(requirement("PUT", "/audit/settings")).toBe("admin");
});

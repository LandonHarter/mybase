import { describe, expect, test } from "bun:test";
import { createLogger } from "@mybase/shared/logger";
import { handleMcp, visibleTools, type McpContext } from "./mcp";
import type { Grant } from "./permissions";

const ctx = (grant: Grant): McpContext => ({ grant, credentials: new Headers(), port: 0, log: createLogger("mcp") });
const admin: Grant = { permissions: ["admin"], projects: null, environments: null };
const post = (body: unknown) => new Request("http://x/mcp", { method: "POST", body: JSON.stringify(body) });

describe("handleMcp", () => {
  test("initialize echoes a supported protocol version", async () => {
    const res = await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), ctx(admin));
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("mybase");
  });

  test("notifications get 202 and no body", async () => {
    const res = await handleMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), ctx(admin));
    expect(res.status).toBe(202);
  });

  test("unknown methods are JSON-RPC errors", async () => {
    const res = await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "nope" }), ctx(admin));
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  test("bad JSON is a parse error", async () => {
    const res = await handleMcp(new Request("http://x/mcp", { method: "POST", body: "{" }), ctx(admin));
    expect(res.status).toBe(400);
  });

  test("tools the key can't use are hidden and refused", async () => {
    const queueOnly: Grant = { permissions: ["queue:write"], projects: ["shop"], environments: null };
    const res = await handleMcp(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_sql", arguments: { project: "shop", sql: "select 1" } } }), ctx(queueOnly));
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  test("missing required arguments are refused before any call", async () => {
    const res = await handleMcp(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_queues", arguments: {} } }), ctx(admin));
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('missing "project"');
  });
});

describe("visibleTools", () => {
  test("a project-limited queue key sees queue and docs tools, not admin ones", () => {
    const tools = visibleTools({ permissions: ["queue:write"], projects: ["shop"], environments: null });
    expect(tools).toContain("send_message");
    expect(tools).toContain("search_docs");
    expect(tools).toContain("get_project_context");
    expect(tools).not.toContain("run_sql");
    expect(tools).not.toContain("create_project");
    expect(tools).not.toContain("list_cron_jobs");
  });

  test("admin sees everything; nothing destructive beyond run_sql exists", () => {
    const tools = visibleTools({ permissions: ["admin"], projects: null, environments: null });
    expect(tools).toContain("run_sql");
    for (const banned of ["delete_project", "disable_service", "purge_queue", "create_token"]) expect(tools).not.toContain(banned);
  });
});

import { describe, expect, test } from "bun:test";
import { RuleState, Throttle } from "./alerts";
import type { AuditEvent } from "./audit";

const t0 = Date.parse("2026-10-27T12:00:00Z");
const ev = (over: Partial<AuditEvent> & { action: string }, offsetMs = 0): AuditEvent => ({
  at: new Date(t0 + offsetMs),
  actor: { kind: "anonymous", id: null, name: null },
  ip: "203.0.113.5",
  outcome: "ok",
  project: null,
  target: null,
  meta: null,
  requestId: null,
  ...over,
});
const rules = (alerts: { rule: string }[]) => alerts.map((a) => a.rule);

describe("RuleState", () => {
  test("failed sign-ins alert on the 10th within 10 minutes, then start over", () => {
    const s = new RuleState();
    const fails = Array.from({ length: 10 }, (_, i) => rules(s.check(ev({ action: "auth.login", outcome: "failed" }, i * 30_000))));
    expect(fails.slice(0, 9).flat()).toEqual([]);
    expect(fails[9]).toEqual(["login.failed_burst"]);
    expect(rules(s.check(ev({ action: "auth.login", outcome: "failed" }, 300_000)))).toEqual([]);
  });

  test("failures spread over more than 10 minutes don't alert", () => {
    const s = new RuleState();
    const all = Array.from({ length: 12 }, (_, i) => rules(s.check(ev({ action: "auth.login", outcome: "failed" }, i * 120_000)))).flat();
    expect(all).toEqual([]);
  });

  test("new sign-in address: not on the very first sign-in, then for unseen IPs", () => {
    const s = new RuleState();
    expect(rules(s.check(ev({ action: "auth.login" })))).toEqual([]);
    expect(rules(s.check(ev({ action: "auth.login" }, 1000)))).toEqual([]);
    expect(rules(s.check(ev({ action: "auth.login", ip: "198.51.100.7" }, 2000)))).toEqual(["login.new_ip"]);
    // Seen more than 30 days ago counts as new again.
    expect(rules(s.check(ev({ action: "auth.login" }, 31 * 86_400_000)))).toEqual(["login.new_ip"]);
  });

  test("learned history suppresses alerts", () => {
    const s = new RuleState();
    s.learn(ev({ action: "auth.login", ip: "10.0.0.1" }));
    s.learn(ev({ action: "secrets.read", actor: { kind: "token", id: "k1", name: "app" }, project: "shop", target: "prod" }));
    expect(rules(s.check(ev({ action: "auth.login", ip: "10.0.0.1" }, 5000)))).toEqual([]);
    expect(rules(s.check(ev({ action: "secrets.read", actor: { kind: "token", id: "k1", name: "app" }, project: "shop", target: "prod" }, 5000)))).toEqual([]);
    expect(rules(s.check(ev({ action: "secrets.read", actor: { kind: "token", id: "k2", name: "other" }, project: "shop", target: "prod" }, 5000)))).toEqual(["secrets.new_reader"]);
  });

  test("one-shot rules", () => {
    const s = new RuleState();
    expect(rules(s.check(ev({ action: "mfa.disabled", actor: { kind: "session", id: null, name: "admin" } })))).toEqual(["mfa.disabled"]);
    expect(rules(s.check(ev({ action: "mfa.recovery_used", meta: { left: 3 } })))[0]).toBe("mfa.recovery_used");
    expect(rules(s.check(ev({ action: "token.created", meta: { admin: true, name: "x" } })))).toEqual(["token.admin_created"]);
    expect(rules(s.check(ev({ action: "token.created", meta: { admin: false, name: "x" } })))).toEqual([]);
    // Failed attempts at these don't alert.
    expect(rules(s.check(ev({ action: "mfa.disabled", outcome: "denied" })))).toEqual([]);
  });

  test("alert events never raise alerts", () => {
    const s = new RuleState();
    expect(rules(s.check(ev({ action: "alert.failed", outcome: "failed" })))).toEqual([]);
  });
});

test("Throttle holds back repeats for 15 minutes per rule and key", () => {
  const th = new Throttle();
  expect(th.allow("r", "a", t0)).toBe(true);
  expect(th.allow("r", "a", t0 + 60_000)).toBe(false);
  expect(th.allow("r", "b", t0 + 60_000)).toBe(true);
  expect(th.allow("r", "a", t0 + 16 * 60_000)).toBe(true);
});

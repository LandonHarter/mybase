import { describe, expect, test } from "bun:test";
import { overlay, rewind, type StoredChange } from "./secrets-state";

const b = (s: string) => new TextEncoder().encode(s);
const text = (m: Map<string, Uint8Array>) => Object.fromEntries([...m].map(([k, v]) => [k, new TextDecoder().decode(v)]));

describe("overlay", () => {
  test("branch keys override the parent's, sorted by key", () => {
    const parent = new Map([["B", { v: 1 }], ["A", { v: 1 }]]);
    const own = new Map([["B", { v: 2 }], ["C", { v: 2 }]]);
    expect([...overlay(parent, own)]).toEqual([
      ["A", { v: 1, inherited: true }],
      ["B", { v: 2, inherited: false }],
      ["C", { v: 2, inherited: false }],
    ]);
  });
  test("a root env has nothing inherited", () => {
    expect([...overlay(null, new Map([["A", { v: 1 }]]))]).toEqual([["A", { v: 1, inherited: false }]]);
  });
});

describe("rewind", () => {
  // rev 1: add A=1, B=1. rev 2: A→2, remove B. rev 3: add C=3, link writes DATABASE_URL.
  const changes: StoredChange[] = [
    { revision: 1, key: "A", oldValue: null, newValue: b("1"), managed: false },
    { revision: 1, key: "B", oldValue: null, newValue: b("1"), managed: false },
    { revision: 2, key: "A", oldValue: b("1"), newValue: b("2"), managed: false },
    { revision: 2, key: "B", oldValue: b("1"), newValue: null, managed: false },
    { revision: 3, key: "C", oldValue: null, newValue: b("3"), managed: false },
    { revision: 3, key: "DATABASE_URL", oldValue: null, newValue: b("pg"), managed: true },
  ];
  const current = new Map([["A", b("2")], ["C", b("3")], ["DATABASE_URL", b("pg")]]);
  const after = (rev: number) => changes.filter((c) => c.revision > rev);

  test("back to revision 2", () => {
    const { target, skipped } = rewind(current, after(2));
    expect(text(target)).toEqual({ A: "2" });
    expect([...skipped]).toEqual(["DATABASE_URL"]);
  });
  test("back to revision 1", () => expect(text(rewind(current, after(1)).target)).toEqual({ A: "1", B: "1" }));
  test("back to the start", () => expect(rewind(current, after(0)).target.size).toBe(0));
  test("the current revision changes nothing", () => expect(text(rewind(current, after(3)).target)).toEqual(text(current)));
});

import { describe, expect, test } from "bun:test";
import { parseEnvText, toDotenv } from "./dotenv";

describe("parseEnvText", () => {
  test("keeps unquoted values literally", () => {
    const r = parseEnvText("A= spaced value  \nB=x # not a comment\n  C=1");
    expect(r.env).toEqual({ A: " spaced value  ", B: "x # not a comment", C: "1" });
    expect(r.errors).toEqual([]);
  });

  test("handles quotes, escapes and multi-line values", () => {
    const r = parseEnvText(`export KEY="line1\nline2"\nJSON='{"a":1}'\nESC="a\\nb\\"c"`);
    expect(r.env).toEqual({ KEY: "line1\nline2", JSON: '{"a":1}', ESC: 'a\nb"c' });
    expect(r.entries.map((e) => e.line)).toEqual([1, 3, 4]);
  });

  test("reports malformed lines by number", () => {
    const r = parseEnvText("OK=1\nnot a pair\n9BAD=2\nOPEN=\"never");
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(r.env).toEqual({ OK: "1" });
  });

  test("flags duplicates, last wins", () => {
    const r = parseEnvText("A=1\nA=2");
    expect(r.env.A).toBe("2");
    expect(r.duplicates).toEqual(["A"]);
  });

  test("round-trips through toDotenv", () => {
    const env = { PLAIN: "abc", SPACE: " lead", MULTI: "a\nb", QUOTE: 'say "hi"', EMPTY: "", HASH: "#x", BACK: "c:\\path" };
    expect(parseEnvText(toDotenv(env)).env).toEqual(env);
  });
});

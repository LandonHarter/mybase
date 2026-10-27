import { describe, expect, test } from "bun:test";
import { parseDotenv } from "./index";

describe("parseDotenv", () => {
  test("reads plain, quoted, exported, and commented lines", () => {
    const parsed = parseDotenv(
      ['# comment', 'A=1', 'export B = two ', "C='single # kept'", 'D="multi\\nline"', 'E=val # trailing', 'F=', 'G="x\ny"', "bad line"].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "two", C: "single # kept", D: "multi\nline", E: "val", F: "", G: "x\ny" });
  });

  test("handles CRLF", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

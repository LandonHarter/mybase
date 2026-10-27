import { describe, expect, test } from "bun:test";
import { BadRequestError } from "./errors";
import { pickMode } from "./vector";

describe("pickMode", () => {
  test("defaults to hybrid when text and a vector are both possible", () => {
    expect(pickMode(null, true, true)).toBe("hybrid");
    expect(pickMode(null, false, true)).toBe("vector");
    expect(pickMode(null, true, false)).toBe("text");
  });

  test("an explicit mode wins when it can run", () => {
    expect(pickMode("text", true, true)).toBe("text");
    expect(pickMode("vector", true, true)).toBe("vector");
  });

  test("refuses modes the request can't satisfy", () => {
    expect(() => pickMode(null, false, false)).toThrow(BadRequestError);
    expect(() => pickMode("hybrid", true, false)).toThrow(BadRequestError);
    expect(() => pickMode("vector", true, false)).toThrow(BadRequestError);
    expect(() => pickMode("text", false, true)).toThrow(BadRequestError);
  });
});

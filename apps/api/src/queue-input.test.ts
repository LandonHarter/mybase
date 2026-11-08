import { describe, expect, test } from "bun:test";
import { messageCursor, redriveSelection } from "./queue-input";

describe("queue listing cursor", () => {
  test("preserves bigint precision and allows the first page", () => {
    expect(messageCursor(undefined)).toBeUndefined();
    expect(messageCursor("9007199254740993")).toBe("9007199254740993");
    expect(messageCursor("9223372036854775807")).toBe("9223372036854775807");
  });
  test("rejects SQL fragments, negatives, decimals and bigint overflow", () => {
    for (const cursor of ["", "-1", "1.2", "1 or true", "9223372036854775808", "9".repeat(100)])
      expect(() => messageCursor(cursor)).toThrow("invalid message cursor");
  });
});
describe("selected redrive", () => {
  const id = "9ed839bf-af5a-41d3-95a5-d3c54608b6d5";
  test("distinguishes omitted all-mode from an invalid empty selection", () => {
    expect(redriveSelection(undefined)).toBeUndefined();
    expect(() => redriveSelection([])).toThrow();
    expect(() => redriveSelection(null)).toThrow();
  });
  test("validates and bounds selected IDs before a database write", () => {
    expect(redriveSelection([id, id])).toEqual([id]);
    for (const input of [["x".repeat(36)], ["-".repeat(36)], ["' or true"], [1], Array(101).fill(id)]) expect(() => redriveSelection(input)).toThrow();
  });
});

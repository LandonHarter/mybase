import { describe, expect, test } from "bun:test";
import { upsertSection } from "./agent";

describe("upsertSection", () => {
  test("appends to a file without one", () => {
    expect(upsertSection("# App\n", "hi")).toBe("# App\n\n<!-- mybase:start -->\nhi\n<!-- mybase:end -->\n");
  });

  test("replaces only the marked part", () => {
    const once = upsertSection("# App\n\nmine\n", "v1");
    const twice = upsertSection(`${once}\nafter\n`, "v2");
    expect(twice).toBe("# App\n\nmine\n\n<!-- mybase:start -->\nv2\n<!-- mybase:end -->\n\nafter\n");
  });

  test("an empty file gets just the section", () => expect(upsertSection("", "x")).toBe("<!-- mybase:start -->\nx\n<!-- mybase:end -->\n"));
});

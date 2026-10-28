import { expect, test } from "bun:test";
import { assetName, newer } from "./update";

test("assetName matches the release assets", () => {
  expect(assetName("linux", "arm64")).toBe("mybase-linux-arm64");
  expect(assetName("darwin", "x64")).toBe("mybase-darwin-x64");
  expect(assetName("win32", "x64")).toBe("mybase-windows-x64.exe");
  expect(() => assetName("linux", "ia32")).toThrow();
});

test("newer compares versions numerically", () => {
  expect(newer("1.0.10", "1.0.9")).toBe(true);
  expect(newer("1.1.0", "1.0.9")).toBe(true);
  expect(newer("1.0.1", "1.0.1")).toBe(false);
  expect(newer("0.9.0", "1.0.0")).toBe(false);
});

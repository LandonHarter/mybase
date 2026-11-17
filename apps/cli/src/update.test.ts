import { expect, test } from "bun:test";
import { assetName, edgeEnv, newer } from "./update";

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

const SHA = "abc1234def5678abc1234def5678abc1234def56";

test("edgeEnv pins official images to the commit and marks the install", () => {
  expect(edgeEnv({}, SHA)).toEqual({
    MYBASE_IMAGE: "ghcr.io/landonharter/mybase:sha-abc1234",
    MYBASE_HOSTING_WORKER_IMAGE: "ghcr.io/landonharter/mybase-hosting-worker:sha-abc1234",
    MYBASE_EDGE: SHA,
  });
  // Moving to a newer commit, or from an explicit :latest.
  expect(edgeEnv({ MYBASE_IMAGE: "ghcr.io/landonharter/mybase:sha-0000000", MYBASE_HOSTING_WORKER_IMAGE: "ghcr.io/landonharter/mybase-hosting-worker:latest" }, SHA).MYBASE_IMAGE).toBe("ghcr.io/landonharter/mybase:sha-abc1234");
});

test("edgeEnv refuses to replace a custom image", () => {
  expect(() => edgeEnv({ MYBASE_IMAGE: "mybase:local" }, SHA)).toThrow(/MYBASE_IMAGE/);
  expect(() => edgeEnv({ MYBASE_IMAGE: "ghcr.io/landonharter/mybase:1.0.25" }, SHA)).toThrow(/MYBASE_IMAGE/);
});

test("edgeEnv(null) removes only what --edge set", () => {
  expect(edgeEnv({ MYBASE_EDGE: SHA, MYBASE_IMAGE: "ghcr.io/landonharter/mybase:sha-abc1234", MYBASE_HOSTING_WORKER_IMAGE: "ghcr.io/landonharter/mybase-hosting-worker:sha-abc1234" }, null)).toEqual({
    MYBASE_EDGE: null,
    MYBASE_IMAGE: null,
    MYBASE_HOSTING_WORKER_IMAGE: null,
  });
  expect(edgeEnv({ MYBASE_IMAGE: "mybase:local" }, null)).toEqual({});
});

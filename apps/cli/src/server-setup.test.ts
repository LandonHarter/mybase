import { expect, test } from "bun:test";
import composeYml from "../../../docker/compose.yml" with { type: "text" };
import { pullHint } from "./server-setup";

test("pullHint explains private ghcr images", () => {
  const out = " Image ghcr.io/landonharter/mybase-postgres:17 Error error from registry: unauthorized\nunauthorized";
  expect(pullHint(out)).toContain("ghcr.io/landonharter/mybase-postgres:17 is private");
  expect(pullHint("Image foo:1 Error pull access denied for foo")).toContain("refused foo:1");
  expect(pullHint("something else")).toBe("");
});

test("embedded compose.yml caps Garage's LMDB map below the Pi's 512 GiB address space", () => {
  // Garage maps 1 TiB by default, which fails with OutOfMemory on 39-bit VA kernels (Raspberry Pi).
  expect(composeYml).toMatch(/^\s*lmdb_map_size = "\d+G"$/m);
});

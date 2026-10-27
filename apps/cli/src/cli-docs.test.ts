import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("docs/cli.md matches the CLI's usage text", async () => {
  const proc = Bun.spawn(["bun", resolve(import.meta.dir, "../../../scripts/gen-cli-docs.ts"), "--check"], { stderr: "pipe" });
  const code = await proc.exited;
  expect(code === 0 ? "" : await new Response(proc.stderr).text()).toBe("");
});

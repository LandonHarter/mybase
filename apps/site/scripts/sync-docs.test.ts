import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OUT_DIR, rewriteLinks, syncDocs } from "./sync-docs";

const repo = resolve(import.meta.dir, "../../..");

test("rewrites links to other pages relative to the page's folder", () => {
  const slugs = new Set(["queues", "sdk/queues", "sdk/signatures"]);
  expect(rewriteLinks("See [SDK](sdk/queues.md#retries).", "queues", slugs)).toBe("See [SDK](/docs/sdk/queues#retries).");
  expect(rewriteLinks("[sig](signatures.md) [q](../queues.md)", "sdk/queues", slugs)).toBe("[sig](/docs/sdk/signatures) [q](/docs/queues)");
  expect(rewriteLinks("```\n[x](nope.md)\n```", "queues", slugs)).toBe("```\n[x](nope.md)\n```");
  expect(() => rewriteLinks("[x](nope.md)", "queues", slugs)).toThrow("nope.md");
});

test("every doc becomes a site page with no placeholders or .md links left", async () => {
  const pages = await syncDocs();
  const sources = [
    ...(await readdir(join(repo, "docs"))).filter((f) => f.endsWith(".md")),
    ...(await readdir(join(repo, "packages/sdk/docs"))).filter((f) => f.endsWith(".md")),
  ];
  expect(pages.length).toBe(sources.length);
  for (const page of pages) {
    const text = await Bun.file(join(OUT_DIR, `${page.slug}.md`)).text();
    expect(text).not.toContain("{{MYBASE_URL}}");
    expect(text.replace(/```[\s\S]*?```/g, "")).not.toMatch(/\]\([^)\s:]+\.md[)#]/);
  }
});

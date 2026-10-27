import { describe, expect, test } from "bun:test";
import { parseFrontmatter, parsePage, splitSections } from "./docs";

describe("parseFrontmatter", () => {
  test("reads single-line keys and strips the block", () => {
    const { meta, body } = parseFrontmatter("---\ntitle: Queues\nsummary: SQS-style: standard and FIFO\n---\n# Queues\n");
    expect(meta).toEqual({ title: "Queues", summary: "SQS-style: standard and FIFO" });
    expect(body).toBe("# Queues\n");
  });

  test("no frontmatter leaves the page alone", () => expect(parseFrontmatter("# Hi\n").body).toBe("# Hi\n"));
});

describe("splitSections", () => {
  test("splits at ## outside code fences", () => {
    const sections = splitSections("Page", "Intro.\n\n## One\nA\n```sh\n## not a heading\n```\n## Two\nB\n");
    expect(sections.map((s) => s.heading)).toEqual(["Page", "One", "Two"]);
    expect(sections[1]!.body).toContain("## not a heading");
    expect(sections[2]!.anchor).toBe("two");
  });
});

describe("parsePage", () => {
  test("SDK pages take their summary from the first sentence", () => {
    const page = parsePage("sdk/cache", "# Cache\n\nA [Redis](https://redis.io) cache\nper project. More here.\n\n## Use\nx\n", true);
    expect(page.title).toBe("Cache");
    expect(page.summary).toBe("A Redis cache per project.");
    expect(page.section).toBe("SDK (@mybase-dev/sdk)");
  });
});

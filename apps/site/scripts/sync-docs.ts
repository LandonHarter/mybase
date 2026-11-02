// Copies docs/ and packages/sdk/docs/ into content/docs/ for Fumadocs. Those folders stay the
// source of truth (the API serves them too); content/docs/ is generated and gitignored.
// Pages are parsed with the API's own loader, so titles, summaries, sections, and order match
// `/docs` and `/llms.txt` on every instance.
import { readDocs, SDK_SECTION, SECTIONS, type Page } from "../../api/src/docs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
export const OUT_DIR = resolve(import.meta.dir, "../content/docs");

/** What `{{MYBASE_URL}}` becomes. The SDK docs already use this host; readers swap in their own. */
export const EXAMPLE_URL = "https://mybase.example.com";

/** Source file in the repo for a slug, for "Edit on GitHub". */
export const sourcePath = (slug: string) =>
  slug.startsWith("sdk/") ? `packages/sdk/docs/${slug.slice(4)}.md` : `docs/${slug}.md`;

/** Site URL of a slug: `index` is the docs home. */
export const siteUrl = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);

/**
 * Rewrites links to other pages (`foo.md`, `sdk/foo.md`, `../foo.md`, with an optional `#anchor`)
 * to site URLs. Links are relative to the page's folder. Throws on a page that doesn't exist.
 */
export function rewriteLinks(markdown: string, slug: string, slugs: Set<string>): string {
  const dir = slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/") + 1) : "";
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\]\(([^)\s:]+?)\.md(#[^)\s]*)?\)/g, (_match, path: string, anchor = "") => {
        const parts = (dir + path).split("/");
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        const target = resolved.join("/");
        if (!slugs.has(target)) throw new Error(`${slug}.md links to ${path}.md, which doesn't exist`);
        return `](${siteUrl(target)}${anchor})`;
      });
    })
    .join("\n");
}

/** One generated page: frontmatter + body without the `# Title` (Fumadocs renders the title). */
export function renderPage(page: Page, slugs: Set<string>): string {
  const body = rewriteLinks(page.markdown.replace(/^# .*\n+/, ""), page.slug, slugs).replaceAll("{{MYBASE_URL}}", EXAMPLE_URL);
  const front = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.summary)}`,
    `source: ${JSON.stringify(sourcePath(page.slug))}`,
    "---",
  ].join("\n");
  // The hosted docs aren't tied to one instance, so say once what the example URL stands for.
  const note = page.slug === "index" ? `> Examples use \`${EXAMPLE_URL}\`. Replace it with your own instance's URL.\n\n` : "";
  return `${front}\n\n${note}${body}\n`;
}

/** Sidebar: one separator per section, in the API's order. SDK pages live in `sdk/` and are pulled up with `...sdk`. */
export function rootMeta(pages: Page[]) {
  const list: string[] = [];
  for (const section of SECTIONS) {
    const inSection = pages.filter((p) => p.section === section);
    if (!inSection.length) continue;
    list.push(`---${section === SDK_SECTION ? "SDK" : section}---`);
    if (section === SDK_SECTION) list.push("...sdk");
    else list.push(...inSection.map((p) => p.slug));
  }
  const unlisted = pages.filter((p) => !SECTIONS.includes(p.section) && !p.slug.startsWith("sdk/"));
  if (unlisted.length) list.push("---Other---", ...unlisted.map((p) => p.slug));
  return { title: "Docs", root: true, pages: list };
}

export async function syncDocs() {
  const pages = await readDocs([
    { dir: join(repo, "docs"), prefix: "" },
    { dir: join(repo, "packages/sdk/docs"), prefix: "sdk/" },
  ]);
  const slugs = new Set(pages.map((p) => p.slug));
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(join(OUT_DIR, "sdk"), { recursive: true });
  for (const page of pages) await Bun.write(join(OUT_DIR, `${page.slug}.md`), renderPage(page, slugs));
  await Bun.write(join(OUT_DIR, "meta.json"), JSON.stringify(rootMeta(pages), null, 2));
  const sdk = pages.filter((p) => p.slug.startsWith("sdk/")).map((p) => p.slug.slice(4));
  await Bun.write(join(OUT_DIR, "sdk/meta.json"), JSON.stringify({ title: "SDK", pages: sdk }, null, 2));
  return pages;
}

if (import.meta.main) {
  const pages = await syncDocs();
  console.log(`synced ${pages.length} docs pages to ${OUT_DIR}`);
}

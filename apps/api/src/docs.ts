// The docs, served by the instance itself so they always match its version: `/llms.txt` and
// `/llms-full.txt` for agents (llmstxt.org), `/docs` (list), `/docs/<slug>.md` (one page),
// `/docs/search?q=` (best `##` sections). Pages come from `docs/` (platform) and
// `packages/sdk/docs/` (slugs `sdk/<name>`). Everything here is public: no secrets in docs.
import type { DocPage, DocSearchHit } from "@mybase/shared";
import { MYBASE_VERSION } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const log = createLogger("docs");

// The image copies both folders under DOCS_DIR; in dev they're read from the repo.
const roots: { dir: string; prefix: string }[] = process.env.DOCS_DIR
  ? [
      { dir: join(process.env.DOCS_DIR, "platform"), prefix: "" },
      { dir: join(process.env.DOCS_DIR, "sdk"), prefix: "sdk/" },
    ]
  : [
      { dir: resolve(import.meta.dir, "../../../docs"), prefix: "" },
      { dir: resolve(import.meta.dir, "../../../packages/sdk/docs"), prefix: "sdk/" },
    ];

/** Written in docs as the instance's URL; SDK docs use the example host. Both become the real one. */
const URL_PLACEHOLDERS = [/\{\{MYBASE_URL\}\}/g, /https:\/\/mybase\.example\.com/g];

const SDK_SECTION = "SDK (@mybase/sdk)";
/** Order of sections in `/llms.txt` and `/docs`. */
const SECTIONS = ["Start here", "Services", SDK_SECTION, "Reference"];

interface Section {
  heading: string;
  /** Lowercased heading + body, for scoring. */
  text: string;
  body: string;
  anchor: string;
}

export interface Page {
  slug: string;
  title: string;
  summary: string;
  section: string;
  order: number;
  markdown: string;
  sections: Section[];
}

let pages: Page[] = [];

/** `---\nkey: value\n---` at the top of a page. Values are single-line strings. */
export function parseFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

const anchorOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");

/** Splits a page at `##` headings outside code fences. The part before the first one is the intro. */
export function splitSections(title: string, body: string): Section[] {
  const sections: Section[] = [];
  let heading = title;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) sections.push({ heading, body: text, text: `${heading}\n${text}`.toLowerCase(), anchor: heading === title ? "" : anchorOf(heading) });
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      lines = [];
    } else lines.push(line);
  }
  flush();
  return sections;
}

/** The first sentence after the title: SDK pages have no frontmatter summary. */
function firstSentence(body: string): string {
  const para = body
    .replace(/^# .*\n/m, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```"));
  const text = (para ?? "").replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return /^.*?[.:](?=\s|$)/.exec(text)?.[0].replace(/:$/, ".") ?? text;
}

export function parsePage(slug: string, source: string, sdk: boolean): Page {
  const { meta, body } = parseFrontmatter(source);
  const title = meta.title ?? /^# (.+)$/m.exec(body)?.[1]?.trim() ?? slug;
  return {
    slug,
    title,
    summary: meta.summary ?? firstSentence(body),
    section: sdk ? SDK_SECTION : (meta.section ?? "Reference"),
    order: Number(meta.order ?? 100),
    markdown: body.trim(),
    sections: splitSections(title, body.replace(/^# .*\n/m, "")),
  };
}

/** Reads every page. Call once at boot; a missing folder is logged, not fatal. */
export async function loadDocs() {
  const loaded: Page[] = [];
  for (const { dir, prefix } of roots) {
    const files = await readdir(dir).catch(() => null);
    if (!files) {
      log.warn("docs folder missing", { dir });
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
      const slug = prefix + file.slice(0, -3);
      loaded.push(parsePage(slug, await Bun.file(join(dir, file)).text(), prefix !== ""));
    }
  }
  pages = loaded.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.order - b.order || a.slug.localeCompare(b.slug));
  log.info("docs loaded", { pages: pages.length });
}

export const getPage = (slug: string) => pages.find((p) => p.slug === slug) ?? null;
export const allPages = () => pages;

const withUrl = (text: string, baseUrl: string) => URL_PLACEHOLDERS.reduce((t, re) => t.replace(re, baseUrl), text);
const pageUrl = (baseUrl: string, slug: string) => `${baseUrl}/docs/${slug}.md`;

/** A page's markdown with this instance's URL filled in. */
export const renderPage = (page: Page, baseUrl: string) => withUrl(page.markdown, baseUrl);

export function listPages(baseUrl: string): DocPage[] {
  return pages.map((p) => ({ slug: p.slug, title: p.title, summary: p.summary, section: p.section, url: pageUrl(baseUrl, p.slug) }));
}

const terms = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9_.:-]+/).filter((t) => t.length >= 2))];

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** ~240 chars around the first matching term. */
function snippet(body: string, words: string[]): string {
  const lower = body.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), body.length);
  const start = Math.max(0, at === body.length ? 0 : at - 80);
  const text = body.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${start + 240 < body.length ? "…" : ""}`;
}

/**
 * Best sections for `query`: each term scores 4 in the heading, 2 in the page title, and 1 per
 * body hit (capped at 3, so one long section can't drown the rest). Sections matching every
 * term get a bonus.
 */
export function searchDocs(query: string, baseUrl: string, limit = 5): DocSearchHit[] {
  const words = terms(query);
  if (words.length === 0) return [];
  const hits: DocSearchHit[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    for (const s of page.sections) {
      const heading = s.heading.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const w of words) {
        const inBody = Math.min(countOf(s.text, w), 3);
        const points = (heading.includes(w) ? 4 : 0) + (title.includes(w) ? 2 : 0) + inBody;
        if (points > 0) matched++;
        score += points;
      }
      if (score === 0) continue;
      if (matched === words.length && words.length > 1) score *= 1.5;
      const url = `${pageUrl(baseUrl, page.slug)}${s.anchor ? `#${s.anchor}` : ""}`;
      hits.push({ slug: page.slug, title: page.title, heading: s.heading, url, snippet: withUrl(snippet(s.body, words), baseUrl), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** `/llms.txt`: what mybase is, how an agent should act on it, then every page by section. */
export function llmsTxt(baseUrl: string): string {
  const lines = [
    "# mybase",
    "",
    `> Self-hosted backend (Postgres, S3 storage, cron, queues, cache, rate limits, analytics) running at ${baseUrl}. Version ${MYBASE_VERSION}.`,
    "",
    "How to work with this instance:",
    "",
    `- Auth: an API key (\`mb_…\`) as \`Authorization: Bearer\`. Keys hold permissions like \`queue:write\` and can be limited to projects. Ask the user for one; never print it back.`,
    `- MCP: streamable HTTP at ${baseUrl}/mcp with the same key. Tools cover docs, project context, database, cron, queues, cache, rate limits, analytics.`,
    `- CLI: \`mybase\` (install: ${baseUrl}/docs/quickstart.md). Add \`--json\` for machine output and \`--yes\` to skip confirmations.`,
    `- Ground yourself first: \`mybase context <project>\` or the \`get_project_context\` tool (services, tables, jobs, queues, env vars; no secrets).`,
    `- Search docs: ${baseUrl}/docs/search?q=<words> (JSON), or \`mybase docs --search "<words>"\`.`,
    `- Secrets (database password, S3 secret key, cache password, API keys) are shown once at creation and never stored. Put them in the app's env, not in code.`,
    "",
  ];
  for (const section of SECTIONS) {
    const inSection = pages.filter((p) => p.section === section);
    if (inSection.length === 0) continue;
    lines.push(`## ${section}`, "");
    for (const p of inSection) lines.push(`- [${p.title}](${pageUrl(baseUrl, p.slug)}): ${p.summary}`);
    lines.push("");
  }
  lines.push("## Optional", "", `- [Everything in one file](${baseUrl}/llms-full.txt): all pages above, concatenated`, "");
  return lines.join("\n");
}

/** `/llms-full.txt`: every page, for agents that want it all in one read. */
export function llmsFullTxt(baseUrl: string): string {
  return pages.map((p) => `<!-- ${pageUrl(baseUrl, p.slug)} -->\n${renderPage(p, baseUrl)}\n`).join("\n---\n\n");
}

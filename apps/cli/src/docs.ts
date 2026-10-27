// `mybase docs …`: read the instance's docs from the terminal (the same pages as /llms.txt).
import type { DocPage, DocSearchHit } from "@mybase/shared";
import { api, API_URL } from "./api";
import { flagInt, flagString, parseArgs } from "./cron";
import { print } from "./output";

export const docsUsage = `  docs                           List docs pages
  docs <slug>                    Print a page as markdown (e.g. quickstart, queues, sdk/queues)
  docs --search "<words>" [--limit 5]  Best matching sections, with links`;

/** Handles `mybase docs …`. */
export async function docs(args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const query = flagString(flags, "search");
  if (query !== undefined) {
    const hits = await api<DocSearchHit[]>(`/docs/search?q=${encodeURIComponent(query)}&limit=${flagInt(flags, "limit") ?? 5}`);
    print(hits, () => {
      if (hits.length === 0) console.log(`Nothing matched "${query}". All pages: mybase docs`);
      for (const h of hits) console.log(`${h.title} › ${h.heading}\n  ${h.url}\n  ${h.snippet}\n`);
    });
    return true;
  }
  const [slug] = positional;
  if (slug) {
    const res = await fetch(`${API_URL}/docs/${slug.replace(/\.md$/, "")}.md`).catch(() => null);
    if (!res) throw new Error(`can't reach the API at ${API_URL}`);
    const markdown = await res.text();
    if (!res.ok) throw new Error(`no docs page "${slug}". List them with: mybase docs`);
    print({ slug, markdown }, () => console.log(markdown));
    return true;
  }
  const pages = await api<DocPage[]>("/docs");
  print(pages, () => {
    let section = "";
    for (const p of pages) {
      if (p.section !== section) console.log(`${section ? "\n" : ""}${(section = p.section)}`);
      console.log(`  ${p.slug.padEnd(22)} ${p.summary}`);
    }
    console.log(`\nRead one: mybase docs <slug>. For agents: ${API_URL}/llms.txt`);
  });
  return true;
}

import { expect, test } from "bun:test";
import { DOCS, docSections, resolveDocLink } from "./docs";

// Every internal link in a guide the dashboard renders must land on a registered guide, and its
// #fragment on a heading that exists there (or the reader lands at the top of the wrong page).
test("internal doc links and fragments resolve", () => {
  const broken: string[] = [];
  for (const doc of DOCS) {
    const body = doc.markdown.replace(/```[\s\S]*?```/g, "");
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1]!;
      if (/^[a-z]+:/i.test(link) || link.startsWith("/")) continue;
      if (!/\.md(?:#|$)/.test(link) && !link.startsWith("#")) continue;
      const route = resolveDocLink(doc, link);
      if (!route) {
        broken.push(`${doc.service.id}/${doc.slug}: ${link} (no such guide)`);
        continue;
      }
      if (route.section) {
        const target = DOCS.find((d) => d.service.id === route.service && d.slug === route.slug)!;
        if (!docSections(target.markdown).some((s) => s.id === route.section)) broken.push(`${doc.service.id}/${doc.slug}: ${link} (no such section)`);
      }
    }
  }
  expect(broken).toEqual([]);
});

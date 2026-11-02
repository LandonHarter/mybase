import { llms, loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";
import { docsRoute } from "./shared";

// content/docs is generated from docs/ and packages/sdk/docs/ by scripts/sync-docs.ts.
const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // `source`: the page's file in the repo, for "Edit on GitHub".
    schema: pageSchema.extend({ source: z.string() }),
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});

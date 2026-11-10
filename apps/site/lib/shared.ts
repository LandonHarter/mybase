import { createGetUrl } from "fumadocs-core/source";

export const appName = "mybase";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

/** Production domain (.env.production); used for canonical URLs, OG images, llms.txt, sitemap. */
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:4002").replace(/\/$/, "");

/** mybase analytics for the site itself (.env.production). Unset in dev, so local visits aren't counted. */
export const analytics = {
  url: process.env.NEXT_PUBLIC_MYBASE_URL?.replace(/\/$/, ""),
  project: process.env.NEXT_PUBLIC_MYBASE_PROJECT,
  key: process.env.NEXT_PUBLIC_MYBASE_ANALYTICS_KEY,
};

export const gitConfig = { user: "LandonHarter", repo: "mybase", branch: "master" };
export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const installCommand = `curl -fsSL https://usemybase.dev/install.sh | sh -s -- --setup`;

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "image.png"];
  return { segments, url: getImageUrl(segments, page.locale) };
}

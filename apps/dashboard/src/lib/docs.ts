// Docs live with the package they describe. Bun bundles these Markdown files as text,
// so the dashboard can serve them offline without an API or a runtime file server.
import analytics from "../../../../packages/sdk/docs/analytics.md" with { type: "text" };
import analyticsApi from "../../../../packages/sdk/docs/analytics-api.md" with { type: "text" };
import cache from "../../../../packages/sdk/docs/cache.md" with { type: "text" };
import gettingStarted from "../../../../packages/sdk/docs/getting-started.md" with { type: "text" };
import cronHandler from "../../../../packages/sdk/docs/cron-handler.md" with { type: "text" };
import jobsInCode from "../../../../packages/sdk/docs/jobs-in-code.md" with { type: "text" };
import oneOffTasks from "../../../../packages/sdk/docs/one-off-tasks.md" with { type: "text" };
import queues from "../../../../packages/sdk/docs/queues.md" with { type: "text" };
import rateLimits from "../../../../packages/sdk/docs/rate-limits.md" with { type: "text" };
import signatures from "../../../../packages/sdk/docs/signatures.md" with { type: "text" };
import sdkPackage from "../../../../packages/sdk/package.json";

export interface DocDefinition {
  slug: string;
  title: string;
  summary: string;
  markdown: string;
}

export interface DocSection {
  label: string;
  docs: DocDefinition[];
}

export interface DocService {
  id: string;
  name: string;
  packageName?: string;
  version?: string;
  description: string;
  sections: DocSection[];
}

export type DocEntry = DocDefinition & { service: DocService; section: string };

// Add a service here, with its Markdown imported above and its guides grouped into
// sections. Routing, both sidebars, previous/next links, and search derive from this.
export const DOC_SERVICES: DocService[] = [
  {
    id: "sdk",
    name: "TypeScript SDK",
    packageName: "@mybase/sdk",
    version: sdkPackage.version,
    description: "Client helpers for apps running on mybase.",
    sections: [
      {
        label: "Overview",
        docs: [
          { slug: "getting-started", title: "Getting started", summary: "Install the SDK and connect your app to mybase.", markdown: gettingStarted },
        ],
      },
      {
        label: "Cron",
        docs: [
          { slug: "cron-handler", title: "Handling cron calls", summary: "Receive and verify scheduled calls in your app.", markdown: cronHandler },
          { slug: "jobs-in-code", title: "Define jobs in code", summary: "Declare schedules and sync them with the CLI.", markdown: jobsInCode },
          { slug: "one-off-tasks", title: "One-off tasks", summary: "Schedule, inspect, and cancel calls from app code.", markdown: oneOffTasks },
        ],
      },
      {
        label: "Analytics",
        docs: [
          { slug: "analytics", title: "Analytics", summary: "Track page views, custom events, and errors from your app.", markdown: analytics },
          { slug: "analytics-api", title: "Analytics API", summary: "Send events from any language and read reports.", markdown: analyticsApi },
        ],
      },
      {
        label: "Cache and rate limits",
        docs: [
          { slug: "cache", title: "Cache", summary: "Store sessions, cached queries, and counters over TCP or HTTP.", markdown: cache },
          { slug: "rate-limits", title: "Rate limits", summary: "Limit requests per user or IP, shared across every instance.", markdown: rateLimits },
        ],
      },
      {
        label: "Queues",
        docs: [{ slug: "queues", title: "Queues", summary: "Standard and FIFO queues, workers, retries, and dead letters.", markdown: queues }],
      },
      {
        label: "Reference",
        docs: [
          { slug: "signatures", title: "Signatures", summary: "Verify raw requests and understand the signing format.", markdown: signatures },
        ],
      },
    ],
  },
];

export const DOCS: DocEntry[] = DOC_SERVICES.flatMap((service) =>
  service.sections.flatMap((section) => section.docs.map((doc) => ({ ...doc, service, section: section.label }))),
);

export function docSectionId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** h2/h3 headings for the page outline. Fenced code cannot contribute fake headings. */
export function docSections(markdown: string) {
  const sections: { id: string; title: string; level: 2 | 3 }[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const title = match[2]!.replace(/[`*_]/g, "").trim();
    sections.push({ id: docSectionId(title), title, level: match[1]!.length as 2 | 3 });
  }
  return sections;
}

export const docRoute = (doc: Pick<DocEntry, "service" | "slug">) => ({ page: "docs" as const, service: doc.service.id, slug: doc.slug, section: null });

export function resolveDoc(serviceId: string, slug: string) {
  const doc = DOCS.find((item) => item.service.id === serviceId && item.slug === slug);
  if (!doc) return undefined;
  const siblings = DOCS.filter((item) => item.service.id === serviceId);
  const index = siblings.indexOf(doc);
  return { doc, previous: siblings[index - 1], next: siblings[index + 1] };
}

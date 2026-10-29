import { href, type Route } from "@/lib/router";

export type SandboxRoute = Extract<Route, { page: "sandbox" }>;
export const routeFor = (name: string, sandbox: string | null = null): SandboxRoute => ({
  page: "sandbox",
  name,
  sandbox,
  execution: null,
  query: "",
  tab: "runs",
});
export const docLink = (slug: string, sdk = false) => href({ page: "docs", service: sdk ? "sdk" : "mybase", slug, section: null });
export const focus = "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
export const codeClass = "overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs whitespace-pre-wrap break-words";

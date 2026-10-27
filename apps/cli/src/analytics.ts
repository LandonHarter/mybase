// `mybase analytics …`: page views, custom events, and errors sent by a project's apps.
import { ANALYTICS_RANGES, type AnalyticsCount, type AnalyticsOverview, type AnalyticsRange, type AnalyticsSettings } from "@mybase/shared";
import { api } from "./api";

export const analyticsUsage = `  analytics enable <project>     Turn on analytics and print the write key and snippets
  analytics disable <project> [--yes]  Turn it off, deleting every recorded event
  analytics key <project> [--rotate]   Show (or replace) the public write key
  analytics stats <project> [--range 24h|7d|30d|90d]  Totals and top routes, events, errors`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/analytics`;

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}`);
  return value;
}

function printSettings(project: string, s: AnalyticsSettings) {
  console.log(`  write key   ${s.writeKey}  (public; safe in browser code)`);
  console.log(`  ingest URL  ${s.ingestUrl}\n`);
  console.log("Script tag:");
  console.log(`  <script defer src="${s.scriptUrl}" data-project="${project}" data-key="${s.writeKey}"></script>\n`);
  console.log("npm (@mybase/sdk):");
  console.log(`  createAnalytics({ apiUrl: "${s.apiUrl}", project: "${project}", key: "${s.writeKey}" })`);
}

function printTop(title: string, rows: AnalyticsCount[]) {
  console.log(`\n${title}`);
  if (rows.length === 0) console.log("  (none)");
  const width = Math.max(...rows.map((r) => String(r.count).length), 1);
  for (const r of rows) console.log(`  ${String(r.count).padStart(width)}  ${r.value}`);
}

/** Handles `mybase analytics <sub> …`. False when `sub` isn't an analytics command. */
export async function analytics(sub: string, args: string[]): Promise<boolean> {
  const project = args.find((a) => !a.startsWith("--"));
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      await api(`/projects/${encodeURIComponent(p)}/services/analytics`, { method: "PUT" });
      console.log(`Analytics enabled for "${p}"\n`);
      printSettings(p, await api<AnalyticsSettings>(`${base(p)}/settings`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      if (!args.includes("--yes")) {
        console.log(`This deletes every page view, event, and error recorded for "${p}".`);
        if (prompt("Type the project name to confirm:") !== p) throw new Error("confirmation did not match, nothing changed");
      }
      await api(`/projects/${encodeURIComponent(p)}/services/analytics`, { method: "DELETE" });
      console.log(`Analytics disabled for "${p}"`);
      return true;
    }
    case "key": {
      const p = need(project, "project name");
      const s = args.includes("--rotate")
        ? await api<AnalyticsSettings>(`${base(p)}/key/rotate`, { method: "POST" })
        : await api<AnalyticsSettings>(`${base(p)}/settings`);
      if (args.includes("--rotate")) console.log("Rotated. The old key stops working now.\n");
      printSettings(p, s);
      return true;
    }
    case "stats": {
      const p = need(project, "project name");
      const i = args.indexOf("--range");
      const range = (i === -1 ? "7d" : args[i + 1]) as AnalyticsRange;
      if (!ANALYTICS_RANGES.includes(range)) throw new Error(`--range must be one of ${ANALYTICS_RANGES.join(", ")}`);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const o = await api<AnalyticsOverview>(`${base(p)}?range=${range}&tz=${encodeURIComponent(tz)}`);
      const { pageviews, visitors, events, errors } = o.totals;
      console.log(`Last ${range}: ${pageviews} page views, ${visitors} visitors, ${events} custom events, ${errors} errors`);
      printTop("Routes", o.routes);
      printTop("Referrers", o.referrers);
      printTop("Countries", o.countries);
      printTop("Custom events", o.events);
      printTop(
        "Errors",
        o.errors.map((e) => ({ value: e.message, count: e.count, visitors: e.visitors })),
      );
      return true;
    }
  }
  return false;
}

import type { AnalyticsRange } from "@mybase/shared";
import { countryLabel, LoadError, LoadingLines, StatTile, TopList, ViewsChart } from "@/components/analytics-parts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { href } from "@/lib/router";

const DEVICE_LABELS: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };

export function AnalyticsOverviewTab({ project, range }: { project: string; range: AnalyticsRange }) {
  const { state, refresh } = useLoad(`analytics:${project}:${range}`, () => api.analyticsOverview(project, range));

  if (state.status === "loading") return <LoadingLines label="Loading analytics" lines={4} />;
  if (state.status === "error") return <LoadError what="analytics" message={state.message} onRetry={refresh} />;

  const o = state.data;
  const { totals, previous } = o;
  const route = (tab: "events" | "errors") => href({ page: "analytics", name: project, tab, range });

  if (totals.pageviews + totals.events + totals.errors === 0 && previous.pageviews + previous.events + previous.errors === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">Nothing recorded yet</p>
        <p className="mt-1 text-muted-foreground">
          Add the script tag or <code className="font-mono text-[0.85em] text-foreground">@mybase/sdk/analytics</code> to your app. Page views show up here a few
          seconds after they happen.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <a href={href({ page: "analytics", name: project, tab: "setup", range })}>Set up your app</a>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Page views" value={totals.pageviews} previous={previous.pageviews} />
        <StatTile label="Visitors" value={totals.visitors} previous={previous.visitors} />
        <StatTile label="Custom events" value={totals.events} previous={previous.events} href={route("events")} />
        <StatTile label="Errors" value={totals.errors} previous={previous.errors} href={route("errors")} />
      </div>

      <section aria-labelledby="views" className="mb-10">
        <h2 id="views" className="mb-4 text-base font-semibold">
          Page views
        </h2>
        <ViewsChart series={o.series} bucket={o.bucket} />
      </section>

      <div className="mb-10 grid gap-x-8 gap-y-8 md:grid-cols-2">
        <TopList title="Routes" rows={o.routes} empty="No page views yet." label={(v) => <span className="font-mono text-xs">{v}</span>} />
        <TopList title="Referrers" rows={o.referrers} empty="No visits from other sites yet." />
        <TopList title="Countries" rows={o.countries} empty="No countries known yet." label={countryLabel} />
        <TopList title="Devices" rows={o.devices} empty="No page views yet." label={(v) => DEVICE_LABELS[v] ?? v} />
        <TopList title="Browsers" rows={o.browsers} empty="No page views yet." />
        <TopList title="Operating systems" rows={o.os} empty="No page views yet." />
      </div>

      <div className="grid gap-x-8 gap-y-8 md:grid-cols-2">
        <TopList title="Custom events" rows={o.events} unit="Count" empty="No custom events yet. Send them with track(name, props)." />
        <TopList
          title="Errors"
          rows={o.errors.map((e) => ({ value: e.message, count: e.count, visitors: e.visitors }))}
          unit="Count"
          empty="No errors. Uncaught errors are recorded automatically."
          label={(v) => <span className="font-mono text-xs">{v}</span>}
        />
      </div>
    </>
  );
}

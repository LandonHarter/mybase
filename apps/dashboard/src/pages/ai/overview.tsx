import { useState } from "react";
import type { AiUsageGroup } from "@mybase-dev/sdk/ai";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { LiveIndicator } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { POLL, useLoad } from "@/lib/load";
import { href, type AiRange } from "@/lib/router";
import { BarChart, fillBuckets, Tile, tokens, usd } from "./parts";

const GROUPS: { value: AiUsageGroup; label: string }[] = [
  { value: "model", label: "Model" },
  { value: "provider", label: "Provider" },
  { value: "tag", label: "Tag" },
  { value: "key", label: "API key" },
];

type Metric = "cost" | "requests" | "tokens";

export function AiOverview({ project, range }: { project: string; range: AiRange }) {
  const [group, setGroup] = useState<AiUsageGroup>("model");
  const [metric, setMetric] = useState<Metric>("cost");
  const load = useLoad(`ai-usage:${project}:${range}:${group}`, () => api.aiUsage(project, range, group), { interval: POLL.analytics, keepPrevious: true });
  const { state } = load;

  if (state.status === "loading") return <LoadingLines label="Loading AI usage" lines={4} />;
  if (state.status === "error") return <LoadError what="AI usage" message={state.message} onRetry={load.refresh} />;
  const u = state.data;
  const t = u.totals;

  if (t.requests === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No calls in this range</p>
        <p className="mt-1 text-muted-foreground">
          Set a provider key, then point an OpenAI-compatible SDK at this project's base URL (Connect shows how), or try a model in the Playground. Calls show up here with their
          cost a few seconds later.
        </p>
        <div className="mt-4 flex gap-2">
          <Button asChild size="sm">
            <a href={href({ page: "ai", name: project, tab: "providers", range })}>Set a provider key</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={href({ page: "ai", name: project, tab: "playground", range })}>Open the playground</a>
          </Button>
        </div>
      </div>
    );
  }

  const series = fillBuckets(u.series, u.from, u.to, u.bucket, (at) => ({ at, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }));
  const value = (s: (typeof series)[number]) => (metric === "cost" ? s.costUsd : metric === "requests" ? s.requests : s.inputTokens + s.outputTokens);
  const points = series.map((s) => ({
    at: s.at,
    value: value(s),
    detail: (
      <>
        <span className="text-foreground">{usd(s.costUsd)}</span> · {formatCount(s.requests)} calls{s.errors ? ` · ${formatCount(s.errors)} errors` : ""} ·{" "}
        {tokens(s.inputTokens + s.outputTokens)} tokens
      </>
    ),
  }));
  const groupMax = Math.max(1e-9, ...u.groups.map((g) => g.costUsd));

  return (
    <>
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Cost" value={usd(t.costUsd)} hint={t.unpriced ? `${formatCount(t.unpriced)} unpriced calls` : undefined} />
        <Tile label="Calls" value={formatCount(t.requests)} hint={t.errors ? `${formatCount(t.errors)} errors (${((t.errors / t.requests) * 100).toFixed(1)}%)` : "No errors"} />
        <Tile
          label="Tokens"
          value={tokens(t.inputTokens + t.outputTokens)}
          hint={`${tokens(t.inputTokens)} in · ${tokens(t.outputTokens)} out · ${tokens(t.cachedTokens)} cached`}
        />
        <Tile label="Avg latency" value={t.avgLatencyMs === null ? "—" : `${formatCount(t.avgLatencyMs)} ms`} />
      </div>

      <section aria-labelledby="ai-chart" className="mb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="ai-chart" className="text-base font-semibold">
            {metric === "cost" ? "Cost" : metric === "requests" ? "Calls" : "Tokens"} per {u.bucket}
          </h2>
          <div className="flex items-center gap-3">
            <LiveIndicator load={load} />
            <SegmentedControl
              label="Chart"
              value={metric}
              onChange={setMetric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "requests", label: "Calls" },
                { value: "tokens", label: "Tokens" },
              ]}
            />
          </div>
        </div>
        <BarChart points={points} bucket={u.bucket} label={metric} format={metric === "cost" ? usd : tokens} />
      </section>

      <section aria-labelledby="ai-groups">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 id="ai-groups" className="text-base font-semibold">
            By {GROUPS.find((g) => g.value === group)!.label.toLowerCase()}
          </h2>
          <SegmentedControl label="Group by" value={group} onChange={setGroup} options={GROUPS} />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{GROUPS.find((g) => g.value === group)!.label}</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Tokens in / out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {u.groups.map((g) => (
              <TableRow key={g.key} className="relative">
                <TableCell className="relative w-full max-w-0 truncate">
                  <span className="absolute inset-y-1 left-0 rounded-sm bg-accent" style={{ width: `${(g.costUsd / groupMax) * 100}%` }} aria-hidden="true" />
                  {group === "model" || group === "tag" ? (
                    <a
                      className="relative font-mono text-[13px] outline-none after:absolute after:inset-0 focus-visible:underline"
                      href={href({ page: "ai", name: project, tab: "logs", range, ...(group === "model" ? { model: g.key } : { tag: g.key }) })}
                    >
                      {g.key}
                    </a>
                  ) : (
                    <span className="relative font-mono text-[13px]">{g.key}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{formatCount(g.requests)}</TableCell>
                <TableCell className="text-right">{g.errors ? formatCount(g.errors) : "—"}</TableCell>
                <TableCell className="text-right">
                  {tokens(g.inputTokens)} / {tokens(g.outputTokens)}
                </TableCell>
                <TableCell className="text-right">{usd(g.costUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

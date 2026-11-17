import { useEffect, useState, type FormEvent } from "react";
import type { AiLogEntry } from "@mybase-dev/sdk/ai";
import { LoadError } from "@/components/analytics-parts";
import { CodeBlock } from "@/components/code-block";
import { Facts, Inspector } from "@/components/inspector";
import { TableSkeleton } from "@/components/states";
import { Badge, LiveIndicator } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCount, formatDate } from "@/lib/format";
import { POLL, useLoad } from "@/lib/load";
import { navigate, type AiRange } from "@/lib/router";
import { tokens, usd } from "./parts";

const modelOf = (l: AiLogEntry) => (l.provider ? `${l.provider}/${l.model}` : (l.alias ?? "—"));

function StatusBadge({ log }: { log: AiLogEntry }) {
  if (log.cached) return <Badge tone="neutral">cached</Badge>;
  if (log.status < 400) return <Badge tone="success">{log.status}</Badge>;
  if (log.status === 429) return <Badge tone="warning">429</Badge>;
  if (log.status === 499) return <Badge tone="neutral">499</Badge>;
  return <Badge tone="danger">{log.status}</Badge>;
}

const SOURCE_LABELS: Record<string, string> = { provider: "reported by the provider", override: "your price override", catalog: "price catalog", cache: "cache hit" };

/** Pretty JSON when it parses; captured streams are SSE text. */
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function LogDetail({ project, id, onClose }: { project: string; id: string; onClose: () => void }) {
  const load = useLoad(`ai-log:${project}:${id}`, () => api.aiLog(project, id));
  const l = load.state.status === "ready" ? load.state.data : null;
  return (
    <Inspector open onOpenChange={(open) => !open && onClose()} kind="AI call" identifier={id} wide>
      {load.state.status === "error" && <LoadError what="the call" message={load.state.message} onRetry={load.refresh} />}
      {l && (
        <div className="grid gap-6">
          <Facts
            items={[
              ["When", <span title={formatDate(l.at)}>{formatDate(l.at)}</span>],
              [
                "Status",
                <span className="flex items-center gap-2">
                  <StatusBadge log={l} />
                  {l.error && <span className="text-destructive">{l.error}</span>}
                </span>,
              ],
              [
                "Model",
                <span className="font-mono text-[13px]">
                  {modelOf(l)}
                  {l.alias ? ` (alias ${l.alias})` : ""}
                </span>,
              ],
              ["Endpoint", `${l.endpoint}${l.stream ? ", streamed" : ""}`],
              [
                "Tokens",
                `${formatCount(l.inputTokens)} in (${formatCount(l.cacheReadTokens)} cached, ${formatCount(l.cacheWriteTokens)} written) · ${formatCount(l.outputTokens)} out${l.reasoningTokens ? ` (${formatCount(l.reasoningTokens)} reasoning)` : ""}${l.images ? ` · ${l.images} images` : ""}`,
              ],
              ["Cost", l.costUsd === null ? "Unpriced: add a price override on the Models tab" : `${usd(l.costUsd)} (${SOURCE_LABELS[l.costSource ?? ""] ?? l.costSource})`],
              ["Latency", `${formatCount(l.latencyMs)} ms${l.ttfbMs !== null ? ` · first byte ${formatCount(l.ttfbMs)} ms` : ""}`],
              ["API key", l.tokenName ?? "Dashboard"],
              ["End user", l.user ?? "—"],
              ["Tags", l.tags.length ? l.tags.join(", ") : "—"],
              ["Fell back from", l.fallbackFrom ?? "—"],
              ["Request id", l.requestId ? <span className="font-mono text-[13px]">{l.requestId}</span> : "—"],
            ]}
          />
          {l.content ? (
            <>
              <section>
                <h3 className="mb-2 font-medium">Request</h3>
                <CodeBlock code={pretty(l.content.request ?? "(none)")} lang="json" />
              </section>
              <section>
                <h3 className="mb-2 font-medium">Response</h3>
                <CodeBlock code={pretty(l.content.response ?? "(none)")} lang="json" />
              </section>
            </>
          ) : (
            <p className="text-muted-foreground">Content capture was off for this call, so its prompt and response weren't stored. Turn it on in Settings to debug.</p>
          )}
        </div>
      )}
    </Inspector>
  );
}

export function AiLogs({
  project,
  range,
  log,
  model,
  status,
  tag,
}: {
  project: string;
  range: AiRange;
  log: string | null;
  model: string | null;
  status: string | null;
  tag: string | null;
}) {
  const [before, setBefore] = useState<string | null>(null);
  const [extra, setExtra] = useState<AiLogEntry[]>([]);
  const key = `ai-logs:${project}:${model ?? ""}:${status ?? ""}:${tag ?? ""}`;
  const load = useLoad(key, () => api.aiLogs(project, { model, status, tag }), { interval: POLL.list, keepPrevious: true });
  const more = useLoad(`${key}:before:${before ?? ""}`, () => (before ? api.aiLogs(project, { model, status, tag, before }) : Promise.resolve(null)));
  useEffect(() => {
    setExtra([]);
    setBefore(null);
  }, [key]);
  const page = more.state.status === "ready" ? more.state.data : null;
  useEffect(() => {
    if (page) setExtra((e) => [...e, ...page.logs.filter((l) => !e.some((x) => x.id === l.id))]);
  }, [page]);

  const go = (patch: { model?: string | null; status?: string | null; tag?: string | null; log?: string | null }) =>
    navigate({ page: "ai", name: project, tab: "logs", range, model, status, tag, log: null, ...patch }, { replace: true });

  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    go({ model: String(form.get("model") ?? "").trim() || null, tag: String(form.get("tag") ?? "").trim() || null });
  }

  const first = load.state.status === "ready" ? load.state.data : null;
  const logs = first ? [...first.logs, ...extra] : [];
  const next = extra.length && more.state.status === "ready" ? (more.state.data?.next ?? null) : (first?.next ?? null);

  return (
    <>
      <form onSubmit={filter} className="mb-4 flex flex-wrap items-center gap-2">
        <Input name="model" data-filter defaultValue={model ?? ""} placeholder="Model or alias" aria-label="Filter by model" className="w-56 font-mono" key={`m${model}`} />
        <Input name="tag" defaultValue={tag ?? ""} placeholder="Tag" aria-label="Filter by tag" className="w-36" key={`t${tag}`} />
        <Select aria-label="Status" value={status ?? ""} onChange={(e) => go({ status: e.target.value || null })} wrapperClassName="w-36">
          <option value="">Any status</option>
          <option value="ok">Succeeded</option>
          <option value="error">Failed</option>
          <option value="429">Limited (429)</option>
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {(model || tag || status) && (
          <Button type="button" variant="ghost" onClick={() => go({ model: null, tag: null, status: null })}>
            Clear
          </Button>
        )}
        <LiveIndicator load={load} className="ml-auto" />
      </form>

      {load.state.status === "loading" && <TableSkeleton label="Loading calls" columns={7} />}
      {load.state.status === "error" && <LoadError what="AI calls" message={load.state.message} onRetry={load.refresh} />}
      {first && (
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="hidden md:table-cell">Endpoint</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 && (
              <TableEmpty colSpan={7}>
                {model || tag || status ? "No calls match these filters." : "No calls yet. They show up here a few seconds after your app makes them."}
              </TableEmpty>
            )}
            {logs.map((l) => (
              <TableRow key={l.id} data-row className="relative" data-state={l.id === log ? "selected" : undefined}>
                <TableCell className="whitespace-nowrap">
                  <a href="#" onClick={(e) => (e.preventDefault(), go({ log: l.id }))} className="outline-none after:absolute after:inset-0 focus-visible:underline">
                    <TimeAgo iso={l.at} />
                  </a>
                </TableCell>
                <TableCell>
                  <StatusBadge log={l} />
                </TableCell>
                <TableCell className="max-w-0 w-full truncate">
                  <span className="font-mono text-[13px]">{modelOf(l)}</span>
                  {l.tags.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{l.tags.join(", ")}</span>}
                  {l.error && <span className="ml-2 text-xs text-destructive">{l.error}</span>}
                </TableCell>
                <TableCell className="hidden md:table-cell">{l.endpoint}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {tokens(l.inputTokens)} → {tokens(l.outputTokens)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {l.costUsd === null && l.status < 400 && !l.cached ? <span className="text-muted-foreground">unpriced</span> : usd(l.costUsd)}
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap sm:table-cell">{formatCount(l.latencyMs)} ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next && (
        <Button variant="outline" className="mt-4" onClick={() => setBefore(next)} disabled={more.refreshing}>
          {more.refreshing ? "Loading…" : "Load older calls"}
        </Button>
      )}
      {log && <LogDetail project={project} id={log} onClose={() => go({ log: null })} />}
    </>
  );
}

import { useMemo, useState } from "react";
import { Brain, Eye, Scale, Wrench } from "lucide-react";
import type { AiModel, AiPrice } from "@mybase-dev/sdk/ai";
import { LoadError } from "@/components/analytics-parts";
import { Facts, Inspector } from "@/components/inspector";
import { TableSkeleton } from "@/components/states";
import { Badge, Section } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { makerOf, ProviderLogo } from "@/pages/ai/provider-logo";

type Kind = "chat" | "embedding" | "image";
type Sort = "newest" | "name" | "cheapest" | "context";

const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name" },
  { value: "cheapest", label: "Cheapest input" },
  { value: "context", label: "Largest context" },
];

const CAPABILITIES = [
  { key: "reasoning", label: "Reasoning", icon: Brain },
  { key: "toolCall", label: "Tool calls", icon: Wrench },
  { key: "vision", label: "Image input", icon: Eye },
  { key: "openWeights", label: "Open weights", icon: Scale },
] as const;

const LIMIT = 300;

/** USD: "$2.50", "$0.50", "$0.075", "free". At least cents; small prices keep 2 significant digits. */
export function usd(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n === 0) return "free";
  if (n >= 0.1) return `$${n.toFixed(2)}`;
  const s = Number(n.toPrecision(2)).toFixed(10).replace(/0+$/, "");
  return `$${s.length - s.indexOf(".") - 1 < 2 ? Number(s).toFixed(2) : s}`;
}

const tokens = (n: number | null) => (n ? (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${formatCount(Math.round(n / 1000))}k`) : "—");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (d: string | null) => {
  if (!d) return "—";
  const [y, m] = d.split("-");
  return m ? `${MONTHS[Number(m) - 1] ?? m} ${y}` : (y ?? "—");
};

/** The model id without its provider prefix. */
const modelPart = (id: string) => id.slice(id.indexOf("/") + 1);

function Capabilities({ m }: { m: AiModel }) {
  const on = CAPABILITIES.filter((c) => m[c.key]);
  if (on.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      {on.map(({ key, label, icon: Icon }) => (
        <span key={key} title={label} className="inline-flex">
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </span>
      ))}
    </span>
  );
}

function priceRows(p: AiPrice): [string, string][] {
  const rows: [string, number | undefined, string][] = [
    ["Input", p.input, " / 1M tokens"],
    ["Output", p.output, " / 1M tokens"],
    ["Cached input", p.cacheRead, " / 1M tokens"],
    ["Cache write", p.cacheWrite, " / 1M tokens"],
    ["Per image", p.perImage, ""],
    ["Per request", p.perRequest, ""],
  ];
  return rows.filter(([, v]) => v !== undefined).map(([k, v, unit]) => [k, `${usd(v)}${v ? unit : ""}`]);
}

function ModelInspector({ model, onClose }: { model: AiModel; onClose: () => void }) {
  return (
    <Inspector
      open
      onOpenChange={(open) => !open && onClose()}
      kind="Model"
      identifier={model.id}
      description={
        <span className="flex items-center gap-2">
          <ProviderLogo id={makerOf(model.id)} className="size-6 [&>svg]:size-3.5" />
          {model.name}
        </span>
      }
    >
      <div className="grid gap-6">
        <Facts
          items={[
            ["Kind", model.type === "chat" ? "Chat" : model.type === "embedding" ? "Embedding" : "Image"],
            ["Provider", <span key="p">{model.provider}{!model.configured && <Badge className="ml-2">no key</Badge>}</span>],
            ...(model.type === "embedding"
              ? ([["Dimensions", model.dimensions ? formatCount(model.dimensions) : "—"]] as [string, string][])
              : ([
                  ["Context", model.contextWindow ? `${formatCount(model.contextWindow)} tokens` : "—"],
                  ["Max output", model.maxOutput ? `${formatCount(model.maxOutput)} tokens` : "—"],
                ] as [string, string][])),
            ["Released", month(model.releaseDate)],
            ["Knowledge", month(model.knowledge)],
            ["Can do", CAPABILITIES.filter((c) => model[c.key]).map((c) => c.label).join(", ") || "—"],
          ]}
        />
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Price {model.priceSource === "override" && <Badge tone="outline">override</Badge>}
          </h3>
          {model.price ? (
            <Facts items={priceRows(model.price)} />
          ) : (
            <p className="text-muted-foreground">Unpriced: calls are logged without a cost. Add a price override to count them against the budget.</p>
          )}
        </div>
      </div>
    </Inspector>
  );
}

export function Catalog({ project }: { project: string }) {
  // null = not chosen yet: show providers without keys while no provider has a key, so a new
  // gateway shows the catalog and its prices instead of an empty table.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [type, setType] = useState<Kind>("chat");
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [open, setOpen] = useState<AiModel | null>(null);
  const providers = useLoad(`ai-providers:${project}`, () => api.aiProviders(project));
  const all = chosen ?? (providers.data !== undefined && !providers.data.some((p) => p.configured));
  const load = useLoad(`ai-models:${project}:${all ? "all" : "configured"}`, () => api.aiModels(project, { all }), { keepPrevious: true });

  const providerIds = useMemo(() => [...new Set((load.data ?? []).map((m) => m.provider))].sort(), [load.data]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (load.data ?? []).filter(
      (m) => m.type === type && (!provider || m.provider === provider) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
    );
    const cmp: Record<Sort, (a: AiModel, b: AiModel) => number> = {
      newest: (a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.id.localeCompare(b.id),
      name: (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      cheapest: (a, b) => (a.price?.input ?? Infinity) - (b.price?.input ?? Infinity) || a.id.localeCompare(b.id),
      context: (a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || a.id.localeCompare(b.id),
    };
    return list.sort(cmp[sort]);
  }, [load.data, type, provider, filter, sort]);

  const embedding = type === "embedding";
  const image = type === "image";

  return (
    <Section
      id="ai-catalog"
      title="Models"
      count={load.data ? formatCount(rows.length) : undefined}
      actions={
        <label className="flex items-center gap-2 text-muted-foreground">
          <Switch checked={all} onCheckedChange={setChosen} aria-label="Include providers without keys" />
          Providers without keys too
        </label>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input data-filter value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="w-56 font-mono" />
        <SegmentedControl
          label="Kind"
          value={type}
          onChange={setType}
          options={[
            { value: "chat", label: "Chat" },
            { value: "embedding", label: "Embedding" },
            { value: "image", label: "Image" },
          ]}
        />
        <Select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} wrapperClassName="w-40">
          <option value="">All providers</option>
          {providerIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
        <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} wrapperClassName="w-44">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      {load.state.status === "loading" && <TableSkeleton label="Loading models" columns={5} />}
      {load.state.status === "error" && <LoadError what="models" message={load.state.message} onRetry={load.refresh} />}
      {load.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{embedding ? "Dimensions" : "Context"}</TableHead>
              {!embedding && !image && <TableHead className="hidden text-right lg:table-cell">Max output</TableHead>}
              <TableHead className="text-right">{image ? "Price" : "Input / 1M"}</TableHead>
              {!embedding && !image && <TableHead className="hidden text-right md:table-cell">Output / 1M</TableHead>}
              {!embedding && !image && <TableHead className="hidden text-right xl:table-cell">Cached / 1M</TableHead>}
              <TableHead className="hidden text-right lg:table-cell">Released</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableEmpty colSpan={7}>{all ? "No models match." : "No models yet: set a provider key, or show providers without keys."}</TableEmpty>
            )}
            {rows.slice(0, LIMIT).map((m) => (
              <TableRow key={m.id} className="relative">
                <TableCell className="w-full max-w-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderLogo id={makerOf(m.id)} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setOpen(m)}
                          className="focus-ring truncate rounded-sm text-left font-medium after:absolute after:inset-0"
                          aria-label={`${m.name} (${m.id}): details`}
                        >
                          {m.name}
                        </button>
                        <Capabilities m={m} />
                        {m.priceSource === "override" && <Badge tone="outline">override</Badge>}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate font-mono">
                          {m.provider}/{modelPart(m.id)}
                        </span>
                        {!m.configured && <span className="shrink-0">· no key</span>}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                  {embedding ? (m.dimensions ? formatCount(m.dimensions) : "—") : tokens(m.contextWindow)}
                </TableCell>
                {!embedding && !image && <TableCell className="hidden text-right whitespace-nowrap tabular-nums lg:table-cell">{tokens(m.maxOutput)}</TableCell>}
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {!m.price ? (
                    <span className="text-muted-foreground">unpriced</span>
                  ) : image && m.price.input === undefined ? (
                    m.price.perImage !== undefined ? `${usd(m.price.perImage)} / image` : "—"
                  ) : (
                    usd(m.price.input)
                  )}
                </TableCell>
                {!embedding && !image && <TableCell className="hidden text-right whitespace-nowrap tabular-nums md:table-cell">{m.price ? usd(m.price.output) : "—"}</TableCell>}
                {!embedding && !image && (
                  <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums xl:table-cell">{m.price ? usd(m.price.cacheRead) : "—"}</TableCell>
                )}
                <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground lg:table-cell">{month(m.releaseDate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {CAPABILITIES.map(({ key, label, icon: Icon }) => (
            <span key={key} className="inline-flex items-center gap-1">
              <Icon className="size-3.5" aria-hidden />
              {label}
            </span>
          ))}
          <span>Prices in USD</span>
        </span>
        {rows.length > LIMIT && (
          <span>
            Showing {LIMIT} of {formatCount(rows.length)}: filter to narrow it.
          </span>
        )}
      </div>
      {open && <ModelInspector model={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

import { useState, type FormEvent } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AiAlias, AiModel, AiPrice, AiPriceOverride } from "@mybase-dev/sdk/ai";
import { LoadError } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TableSkeleton } from "@/components/states";
import { Badge, Section } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { errorMessage, invalidate, useLoad } from "@/lib/load";

const PRICE_FIELDS: { key: keyof AiPrice; label: string; hint: string }[] = [
  { key: "input", label: "Input", hint: "USD per 1M tokens" },
  { key: "output", label: "Output", hint: "USD per 1M tokens" },
  { key: "cacheRead", label: "Cached input", hint: "USD per 1M tokens" },
  { key: "cacheWrite", label: "Cache write", hint: "USD per 1M tokens" },
  { key: "perImage", label: "Per image", hint: "USD" },
  { key: "perRequest", label: "Per request", hint: "USD" },
];

const priceText = (p: AiPrice | null) => {
  if (!p) return "—";
  const parts = [
    p.input !== undefined && `in $${p.input}`,
    p.output !== undefined && `out $${p.output}`,
    p.cacheRead !== undefined && `cached $${p.cacheRead}`,
    p.perImage !== undefined && `$${p.perImage}/image`,
    p.perRequest !== undefined && `$${p.perRequest}/call`,
  ];
  return parts.filter(Boolean).join(" · ") || "—";
};

function AliasDialog({ project, alias, onClose }: { project: string; alias: AiAlias | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = alias?.name ?? String(f.get("name") ?? "").trim();
    const targets = String(f.get("targets") ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api.putAiAlias(project, name, targets);
      toast.success(`Saved alias ${name}`);
      invalidate(`ai-aliases:${project}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{alias ? `Edit ${alias.name}` : "New alias"}</DialogTitle>
            <DialogDescription>
              Apps call the alias as the model. Models are tried in order: if one fails before answering (no key, network, 429, 5xx), the next one is used.
            </DialogDescription>
          </DialogHeader>
          {!alias && (
            <div className="grid gap-1.5">
              <Label htmlFor="al-name">Name</Label>
              <Input id="al-name" name="name" required pattern="[a-z][a-z0-9_\-]{0,47}" placeholder="fast" className="font-mono" autoFocus />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="al-targets">Models, one per line</Label>
            <Textarea
              id="al-targets"
              name="targets"
              required
              rows={4}
              defaultValue={alias?.targets.join("\n") ?? ""}
              placeholder={"groq/llama-3.3-70b-versatile\nopenai/gpt-5-mini"}
              className="font-mono"
              autoFocus={!!alias}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit">Save alias</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PriceDialog({ project, initial, onClose }: { project: string; initial: AiPriceOverride | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input: AiPriceOverride = { model: initial?.model ?? String(f.get("model") ?? "").trim() };
    for (const { key } of PRICE_FIELDS) {
      const v = String(f.get(key) ?? "").trim();
      if (v !== "") input[key] = Number(v);
    }
    try {
      await api.putAiPrice(project, input);
      toast.success(`Saved the price for ${input.model}`);
      invalidate(`ai-`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{initial ? `Price of ${initial.model}` : "Price override"}</DialogTitle>
            <DialogDescription>Beats the catalog (but not a cost the provider reports). Use a glob for a family, e.g. ollama/* at 0.</DialogDescription>
          </DialogHeader>
          {!initial && (
            <div className="grid gap-1.5">
              <Label htmlFor="pr-model">Model</Label>
              <Input id="pr-model" name="model" required placeholder="openai/gpt-5*" className="font-mono" autoFocus />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {PRICE_FIELDS.map((p) => (
              <div key={p.key} className="grid gap-1.5">
                <Label htmlFor={`pr-${p.key}`}>{p.label}</Label>
                <Input id={`pr-${p.key}`} name={p.key} type="number" step="any" min={0} defaultValue={initial?.[p.key] ?? ""} placeholder={p.hint} />
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit">Save price</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Catalog({ project }: { project: string }) {
  const [all, setAll] = useState(false);
  const [type, setType] = useState<"chat" | "embedding" | "image">("chat");
  const [filter, setFilter] = useState("");
  const load = useLoad(`ai-models:${project}:${all ? "all" : "configured"}`, () => api.aiModels(project, { all }), { keepPrevious: true });
  const rows = (load.data ?? []).filter((m: AiModel) => m.type === type && (!filter || m.id.includes(filter.toLowerCase())));
  return (
    <Section
      id="ai-catalog"
      title="Models"
      count={load.data ? formatCount(rows.length) : undefined}
      actions={
        <label className="flex items-center gap-2 text-muted-foreground">
          <Switch checked={all} onCheckedChange={setAll} aria-label="Include providers without keys" />
          Providers without keys too
        </label>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input data-filter value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="w-64 font-mono" />
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
      </div>
      {load.state.status === "loading" && <TableSkeleton label="Loading models" columns={4} />}
      {load.state.status === "error" && <LoadError what="models" message={load.state.message} onRetry={load.refresh} />}
      {load.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="hidden sm:table-cell">{type === "embedding" ? "Dimensions" : "Context"}</TableHead>
              <TableHead>Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && <TableEmpty colSpan={3}>{all ? "No models match." : "No models yet: set a provider key, or show providers without keys."}</TableEmpty>}
            {rows.slice(0, 300).map((m) => (
              <TableRow key={m.id}>
                <TableCell className="max-w-0 w-full truncate">
                  <span className="font-mono text-[13px]">{m.id}</span>
                  {!m.configured && <span className="ml-2 text-xs text-muted-foreground">no key</span>}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap sm:table-cell">
                  {type === "embedding" ? (m.dimensions ?? "—") : m.contextWindow ? `${formatCount(Math.round(m.contextWindow / 1000))}k` : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {priceText(m.price)} {m.priceSource === "override" && <Badge tone="outline">override</Badge>}
                  {!m.price && <span className="text-muted-foreground">unpriced</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {rows.length > 300 && <p className="mt-2 text-muted-foreground">Showing 300 of {formatCount(rows.length)}: filter to narrow it.</p>}
    </Section>
  );
}

export function AiModels({ project }: { project: string }) {
  const aliases = useLoad(`ai-aliases:${project}`, () => api.aiAliases(project));
  const prices = useLoad(`ai-prices:${project}`, () => api.aiPrices(project));
  const [aliasDialog, setAliasDialog] = useState<AiAlias | "new" | null>(null);
  const [priceDialog, setPriceDialog] = useState<AiPriceOverride | "new" | null>(null);
  const [removing, setRemoving] = useState<{ kind: "alias" | "price"; id: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refreshCatalog() {
    setRefreshing(true);
    try {
      await api.refreshAiPrices(project);
      toast.success("Prices refreshed from models.dev");
      invalidate("ai-");
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    } finally {
      setRefreshing(false);
    }
  }

  async function remove() {
    if (!removing) return;
    if (removing.kind === "alias") await api.deleteAiAlias(project, removing.id);
    else await api.deleteAiPrice(project, removing.id);
    toast.success(`Deleted ${removing.id}`);
    invalidate("ai-");
  }

  return (
    <>
      <Section
        id="ai-aliases"
        title="Aliases"
        count={aliases.data ? formatCount(aliases.data.length) : undefined}
        actions={
          <Button variant="outline" size="sm" onClick={() => setAliasDialog("new")}>
            <Plus />
            New alias
          </Button>
        }
      >
        {aliases.state.status === "error" && <LoadError what="aliases" message={aliases.state.message} onRetry={aliases.refresh} />}
        {aliases.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Models, in order</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.data.length === 0 && (
                <TableEmpty colSpan={3}>No aliases. An alias like fast or smart lets you switch models without touching app code, with fallbacks.</TableEmpty>
              )}
              {aliases.data.map((a) => (
                <TableRow key={a.name} className="group">
                  <TableCell className="font-mono text-[13px]">
                    {a.name} {a.source === "code" && <Badge tone="outline">code</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{a.targets.join(" → ")}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {a.source !== "code" && (
                      <>
                        <Button variant="ghost" size="icon" onClick={() => setAliasDialog(a)} aria-label={`Edit alias ${a.name}`}>
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setRemoving({ kind: "alias", id: a.name })} aria-label={`Delete alias ${a.name}`}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        id="ai-prices"
        title="Price overrides"
        live={
          prices.data && (
            <span className="text-xs text-muted-foreground">
              Catalog from models.dev, <TimeAgo iso={prices.data.catalogFetchedAt} />
            </span>
          )
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={refreshCatalog} disabled={refreshing}>
              <RefreshCw />
              {refreshing ? "Refreshing…" : "Refresh catalog"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPriceDialog("new")}>
              <Plus />
              Override a price
            </Button>
          </>
        }
      >
        {prices.state.status === "error" && <LoadError what="prices" message={prices.state.message} onRetry={prices.refresh} />}
        {prices.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Price</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.data.overrides.length === 0 && <TableEmpty colSpan={3}>No overrides: costs come from the provider or the catalog.</TableEmpty>}
              {prices.data.overrides.map((o) => (
                <TableRow key={o.model}>
                  <TableCell className="font-mono text-[13px]">{o.model}</TableCell>
                  <TableCell>{priceText(o)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" onClick={() => setPriceDialog(o)} aria-label={`Edit price of ${o.model}`}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setRemoving({ kind: "price", id: o.model })} aria-label={`Delete price of ${o.model}`}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Catalog project={project} />

      {aliasDialog && <AliasDialog project={project} alias={aliasDialog === "new" ? null : aliasDialog} onClose={() => setAliasDialog(null)} />}
      {priceDialog && <PriceDialog project={project} initial={priceDialog === "new" ? null : priceDialog} onClose={() => setPriceDialog(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.id}`}
        description={removing?.kind === "alias" ? "Apps calling this alias get 400 until it's added again." : "Calls are priced from the catalog again (or unpriced)."}
        confirm="Delete"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </>
  );
}

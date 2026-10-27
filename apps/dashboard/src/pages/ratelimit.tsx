import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  RATELIMIT_RULE_NAME_RULES,
  RATELIMIT_STATS_RANGES,
  type Project,
  type RateLimitAlgorithm,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitRuleStats,
  type RateLimitStatsRange,
} from "@mybase/shared";
import { formatCount, LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { RateLimitChart } from "@/components/ratelimit-chart";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, formatDuration, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const ALGORITHM_LABELS: Record<RateLimitAlgorithm, { name: string; hint: string }> = {
  sliding: { name: "Sliding window", hint: "Smooth: counts the last window as it moves. A good default." },
  fixed: { name: "Fixed window", hint: "A counter that resets each window. Simplest; allows bursts at the edges." },
  token: { name: "Token bucket", hint: "Allows short bursts up to a capacity, refilled at the limit's rate." },
};

const ALGORITHMS = Object.keys(ALGORITHM_LABELS) as RateLimitAlgorithm[];

const RANGE_LABELS: Record<RateLimitStatsRange, string> = { "24h": "24 hours", "7d": "7 days" };

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const sdkSnippet = (apiUrl: string, project: string, rule: string) => `import { createRateLimiter, rateLimitHeaders } from "@mybase/sdk/ratelimit";

const limiter = createRateLimiter({
  apiUrl: "${apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

const result = await limiter.limit("${rule}", ip); // or { limit: 10, window: "1m" }
if (!result.success) return new Response("Too many requests", { status: 429, headers: rateLimitHeaders(result) });`;

const CONFIG_SNIPPET = `// mybase.config.ts, then: mybase ratelimit sync
import { defineConfig } from "@mybase/sdk/config";

export default defineConfig({
  project: "<project>",
  ratelimit: {
    rules: {
      login: { limit: 5, window: "1m" },
      api: { algorithm: "token", limit: 100, window: "1m", burst: 200 },
    },
  },
});`;

const ruleSummary = (r: { limit: number; windowMs: number; algorithm: RateLimitAlgorithm; burst: number | null }) =>
  `${r.limit.toLocaleString()} per ${formatDuration(r.windowMs)}${r.algorithm === "token" && r.burst ? `, bursts of ${r.burst.toLocaleString()}` : ""}`;

const CodeTag = () => (
  <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground" title="Defined in mybase.config.ts; change it there and run mybase ratelimit sync">
    Code
  </span>
);

/** Create a rule, or edit (and delete) a dashboard one. */
function RuleDialog({
  project,
  rule,
  open,
  onOpenChange,
  onSaved,
}: {
  project: string;
  /** null: a new rule. */
  rule: RateLimitRule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [algorithm, setAlgorithm] = useState<RateLimitAlgorithm>(rule?.algorithm ?? "sliding");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const limit = Number(String(form.get("limit") ?? "").trim());
    const burstRaw = String(form.get("burst") ?? "").trim();
    const input = {
      name: String(form.get("name") ?? "").trim(),
      algorithm,
      limit,
      window: String(form.get("window") ?? "").trim(),
      burst: algorithm === "token" && burstRaw ? Number(burstRaw) : null,
    };
    if (!Number.isInteger(limit) || limit < 1) return setError("Limit is a whole number of requests, at least 1.");
    setPending(true);
    setError(null);
    try {
      const saved = rule ? await api.updateRateLimitRule(project, rule.name, input) : await api.createRateLimitRule(project, input);
      toast.success(rule ? `Saved ${saved.name}` : `Created ${saved.name}`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!rule) return;
    try {
      await api.deleteRateLimitRule(project, rule.name);
      toast.success(`Deleted ${rule.name}`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(`Couldn't delete the rule: ${errorMessage(err)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>{rule ? `Edit ${rule.name}` : "New rule"}</DialogTitle>
            <DialogDescription>Apps check it by name: limiter.limit("{rule?.name ?? "name"}", id). Each id gets its own count.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" name="name" required autoFocus defaultValue={rule?.name} autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
            <p className="text-muted-foreground">{RATELIMIT_RULE_NAME_RULES}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rule-limit">Requests</Label>
              <Input id="rule-limit" name="limit" required inputMode="numeric" defaultValue={rule?.limit} placeholder="10" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rule-window">Per</Label>
              <Input id="rule-window" name="window" required defaultValue={rule ? formatDuration(rule.windowMs).replace(" ", "") : ""} placeholder="1m" className="font-mono text-xs md:text-xs" />
            </div>
          </div>
          <p className="-mt-3 text-muted-foreground">The window: 30s, 1m, 1h, 1d, from 1 second to 30 days.</p>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Algorithm</legend>
            <RadioGroup value={algorithm} onValueChange={(v) => setAlgorithm(v as RateLimitAlgorithm)} className="gap-3">
              {ALGORITHMS.map((a) => (
                <label key={a} className="flex items-start gap-3">
                  <RadioGroupItem value={a} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{ALGORITHM_LABELS[a].name}</span>
                    <span className="block text-muted-foreground">{ALGORITHM_LABELS[a].hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          {algorithm === "token" && (
            <div className="grid gap-2">
              <Label htmlFor="rule-burst">Burst capacity</Label>
              <Input id="rule-burst" name="burst" inputMode="numeric" defaultValue={rule?.burst ?? undefined} placeholder="Same as requests" className="max-w-40" />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            {rule ? (
              <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                Delete rule
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : rule ? "Save rule" : "Create rule"}
              </Button>
            </div>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete ${rule?.name ?? "rule"}`}
          description="Its counters are deleted too. Apps still checking it get a 404, which the SDK throws on."
          confirm="Delete rule"
          pendingLabel="Deleting…"
          onConfirm={remove}
        />
      </DialogContent>
    </Dialog>
  );
}

/** A segmented control for the stats range. */
function RangePicker({ range, onChange }: { range: RateLimitStatsRange; onChange: (r: RateLimitStatsRange) => void }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-md border p-0.5">
      {RATELIMIT_STATS_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={r === range}
          onClick={() => onChange(r)}
          className={cn(
            "h-8 rounded-[5px] px-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            r === range && "bg-accent font-medium text-foreground",
          )}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

function sumSeries(rules: RateLimitRuleStats[]) {
  const first = rules[0]?.series ?? [];
  return first.map((p, i) => ({
    t: p.t,
    allowed: rules.reduce((n, r) => n + (r.series[i]?.allowed ?? 0), 0),
    blocked: rules.reduce((n, r) => n + (r.series[i]?.blocked ?? 0), 0),
  }));
}

/** `version` changes when rules change; `checks` when a check from Try it may have moved the stats. */
function Rules({ project, onCreate, onEdit, version, checks }: { project: string; onCreate: () => void; onEdit: (r: RateLimitRule) => void; version: number; checks: number }) {
  const [range, setRange] = useState<RateLimitStatsRange>("24h");
  const rules = useLoad(`ratelimit-rules:${project}:${version}`, () => api.rateLimitRules(project));
  const stats = useLoad(`ratelimit-stats:${project}:${range}:${version}`, () => api.rateLimitStats(project, range));
  // In place, so the chart doesn't flash back to loading after each check.
  const refreshStats = stats.refresh;
  useEffect(() => {
    if (checks > 0) void refreshStats();
  }, [checks, refreshStats]);

  const byRule = new Map(stats.state.status === "ready" ? stats.state.data.rules.map((r) => [r.rule, r]) : []);
  const inline = byRule.get("_inline");

  return (
    <>
      <section aria-labelledby="checks" className="mb-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="checks" className="text-base font-semibold">
            Checks
          </h2>
          <RangePicker range={range} onChange={setRange} />
        </div>
        {stats.state.status === "loading" && <LoadingLines label="Loading stats" />}
        {stats.state.status === "error" && <LoadError what="stats" message={stats.state.message} onRetry={stats.refresh} />}
        {stats.state.status === "ready" &&
          (stats.state.data.rules.every((r) => r.allowed + r.blocked === 0) ? (
            <p className="text-muted-foreground">No checks in the last {RANGE_LABELS[range]}. Counts show up here as soon as your app calls limit().</p>
          ) : (
            <RateLimitChart series={sumSeries(stats.state.data.rules)} />
          ))}
      </section>

      <section aria-labelledby="rules" className="mb-10">
        <h2 id="rules" className="mb-3 text-base font-semibold">
          Rules
        </h2>
        {rules.state.status === "loading" && <LoadingLines label="Loading rules" />}
        {rules.state.status === "error" && <LoadError what="rules" message={rules.state.message} onRetry={rules.refresh} />}
        {rules.state.status === "ready" && rules.state.data.length === 0 && (
          <div className="max-w-prose rounded-lg border border-dashed p-5">
            <p className="font-medium">No rules yet</p>
            <p className="mt-1 text-muted-foreground">
              A rule is a named limit, like 5 sign-ins a minute per IP. Create one here, or declare them in{" "}
              <code className="font-mono text-[0.85em] text-foreground">mybase.config.ts</code> and run{" "}
              <code className="font-mono text-[0.85em] text-foreground">mybase ratelimit sync</code>. Inline limits work without one.
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={onCreate}>
              <Plus />
              New rule
            </Button>
          </div>
        )}
        {rules.state.status === "ready" && (rules.state.data.length > 0 || inline) && (
          <Table className={rules.state.data.length === 0 ? "mt-4" : undefined}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead className="text-right">Allowed</TableHead>
                <TableHead className="text-right">Blocked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.state.data.map((r) => {
                const s = byRule.get(r.name);
                return (
                  <TableRow key={r.name}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {r.source === "dashboard" ? (
                          <button type="button" className="font-mono text-xs font-medium outline-none hover:underline focus-visible:underline" onClick={() => onEdit(r)}>
                            {r.name}
                          </button>
                        ) : (
                          <span className="font-mono text-xs font-medium">{r.name}</span>
                        )}
                        {r.source === "code" && <CodeTag />}
                      </span>
                    </TableCell>
                    <TableCell>
                      {ruleSummary(r)}
                      <span className="block text-muted-foreground">{ALGORITHM_LABELS[r.algorithm].name}</span>
                    </TableCell>
                    <TableCell className="text-right">{s ? formatCount(s.allowed) : "–"}</TableCell>
                    <TableCell className={cn("text-right", s && s.blocked > 0 && "text-destructive")}>{s ? formatCount(s.blocked) : "–"}</TableCell>
                  </TableRow>
                );
              })}
              {inline && (
                <TableRow>
                  <TableCell className="text-muted-foreground">Inline limits</TableCell>
                  <TableCell className="text-muted-foreground">Set per call</TableCell>
                  <TableCell className="text-right">{formatCount(inline.allowed)}</TableCell>
                  <TableCell className={cn("text-right", inline.blocked > 0 && "text-destructive")}>{formatCount(inline.blocked)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

/** Runs one real check, counted like an app's, to see a rule in action. */
function TryIt({ project, version, onChecked }: { project: string; version: number; onChecked: () => void }) {
  const rules = useLoad(`ratelimit-rules:${project}:try:${version}`, () => api.rateLimitRules(project));
  const [result, setResult] = useState<RateLimitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      setResult(await api.testRateLimit(project, { rule: String(form.get("rule") ?? ""), id: String(form.get("id") ?? "").trim() || "dashboard-test" }));
      onChecked();
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (rules.state.status !== "ready" || rules.state.data.length === 0) {
    return <p className="text-muted-foreground">Create a rule first.</p>;
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="try-rule">Rule</Label>
          <select
            id="try-rule"
            name="rule"
            className="h-9 rounded-md border bg-transparent px-3 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {rules.state.data.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="try-id">Id</Label>
          <Input id="try-id" name="id" placeholder="dashboard-test" className="w-48 font-mono text-xs md:text-xs" />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Checking…" : "Check"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p aria-live="polite">
          <span className={cn("font-medium", !result.success && "text-destructive")}>{result.success ? "Allowed" : "Blocked"}</span>
          <span className="text-muted-foreground">
            {" · "}
            {result.remaining.toLocaleString()} of {result.limit.toLocaleString()} left · resets{" "}
            <time dateTime={new Date(result.reset).toISOString()} title={formatDate(new Date(result.reset).toISOString())}>
              {timeAgo(new Date(result.reset).toISOString())}
            </time>
          </span>
        </p>
      )}
    </form>
  );
}

function RateLimits({ project }: { project: Project }) {
  const name = project.name;
  const settings = useLoad(`ratelimit:${name}`, () => api.rateLimitSettings(name));
  const [editing, setEditing] = useState<{ rule: RateLimitRule | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [checks, setChecks] = useState(0);
  const [dialog, setDialog] = useState<"key" | "off" | null>(null);
  const bump = () => setVersion((v) => v + 1);

  async function turnOff() {
    try {
      await api.disableService(name, "ratelimit");
      await refreshProjects();
      toast.success(`Turned off rate limits for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off rate limits: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Rate limits"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Limits your app checks before doing work, shared by every instance of it."
        action={
          <Button onClick={() => setEditing({ rule: null })}>
            <Plus />
            New rule
          </Button>
        }
      />
      <Rules project={name} version={version} checks={checks} onCreate={() => setEditing({ rule: null })} onEdit={(rule) => setEditing({ rule })} />

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        {settings.state.status === "loading" && <LoadingLines label="Loading settings" />}
        {settings.state.status === "error" && <LoadError what="settings" message={settings.state.message} onRetry={settings.refresh} />}
        {settings.state.status === "ready" && (
          <>
            <Row title="API key" hint="Your server sends an API key with ratelimit:write for this project. Keep it out of browser code.">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground">
                  Pass it as <code className="font-mono text-[0.85em] text-foreground">MYBASE_API_KEY</code>. One key can cover several services.
                </p>
                <Button variant="outline" size="sm" onClick={() => setDialog("key")}>
                  <KeyRound />
                  Create API key
                </Button>
              </div>
            </Row>
            <Row
              title="Check a limit"
              hint={
                <>
                  <code className="font-mono text-[0.85em] text-foreground">npm install @mybase/sdk</code>. If mybase can't be reached, it allows the request unless
                  you set <code className="font-mono text-[0.85em] text-foreground">failClosed: true</code>.
                </>
              }
            >
              {code(sdkSnippet(settings.state.data.apiUrl, name, "login"))}
            </Row>
            <Row title="Rules in code" hint="Code rules show a Code tag and can only be changed by syncing.">
              {code(CONFIG_SNIPPET.replace("<project>", name))}
            </Row>
            <Row title="Endpoint" hint="For other languages: POST JSON { rule, id } with an API key as a Bearer token.">
              <CopyField id="ratelimit-url" label="POST" value={settings.state.data.limitUrl} />
            </Row>
            <Row title="Try it" hint="Runs a real check, counted like your app's.">
              <TryIt project={name} version={version} onChecked={() => setChecks((c) => c + 1)} />
            </Row>
          </>
        )}
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off rate limits
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every rule, counter, and stat. API keys stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off rate limits
          </Button>
        </div>
      </section>

      {editing && <RuleDialog key={editing.rule?.name ?? "new"} project={name} rule={editing.rule} open onOpenChange={(open) => !open && setEditing(null)} onSaved={bump} />}
      <KeyDialog
        open={dialog === "key"}
        onOpenChange={(open) => !open && setDialog(null)}
        preset={{ name: `${name} rate limits`, permissions: ["ratelimit:write"], projects: [name] }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off rate limits for ${name}`}
        description={SERVICE_PAGES.ratelimit.turnOff}
        confirm="Turn off rate limits"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function RateLimitPage({ name }: { name: string }) {
  return (
    <ProjectGate name={name} title="Rate limits" backToProject>
      {(project) => {
        if (!project.services.includes("ratelimit")) {
          return (
            <ServiceOff project={project} id="ratelimit">
              Turn them on to limit how often a user, IP, or API key can do something (sign in, send email, call your API), with one count shared by every
              instance of your app. Rules are set here or in code.
            </ServiceOff>
          );
        }
        return <RateLimits project={project} />;
      }}
    </ProjectGate>
  );
}

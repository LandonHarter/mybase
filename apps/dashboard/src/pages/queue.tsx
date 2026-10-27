import { useState, type FormEvent } from "react";
import { KeyRound, Plus, RefreshCw, Send, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  QUEUE_STATS_RANGES,
  type Project,
  type Queue,
  type QueueMessageRecord,
  type QueueSettingsInput,
  type QueueStatsPoint,
  type QueueStatsRange,
  type QueueStatsSeries,
} from "@mybase/shared";
import { formatCount, LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { QueueChart } from "@/components/queue-chart";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDate, formatDuration, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

// The same names and limits as QUEUE_NAME_RULES / QUEUE_LIMITS in @mybase-dev/sdk/queue (types
// only reach the dashboard's browser build, so the values are repeated here).
const QUEUE_NAME_RULES = "Use 1–80 lowercase letters, digits, `_`, or `-`, starting with a letter or digit.";
const MAX_MESSAGE_BYTES = 256 * 1024;

const RANGE_LABELS: Record<QueueStatsRange, string> = { "24h": "24 hours", "7d": "7 days" };

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const sdkSnippet = (apiUrl: string, project: string) => `import { createQueueClient } from "@mybase-dev/sdk/queue";

const queue = createQueueClient({
  apiUrl: "${apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

// Producer
await queue.send("emails", { to: "ada@example.com", template: "welcome" });

// Worker: deletes each message once the handler resolves
queue.consume("emails", async (message) => {
  await sendEmail(message.json());
});`;

const CONFIG_SNIPPET = `// mybase.config.ts, then: mybase queue sync
import { defineConfig } from "@mybase-dev/sdk/config";

export default defineConfig({
  project: "<project>",
  queue: {
    queues: {
      emails: { visibilityTimeout: "1m", deadLetter: { queue: "emails-failed", maxReceives: 5 } },
      "emails-failed": { retention: "14d" },
      orders: { fifo: true, contentDedup: true },
    },
  },
});`;

/** 60000 → `1m`; a value the API's duration parser reads back. */
function durationInput(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return String(ms);
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground" title={title}>
      {children}
    </span>
  );
}

const SOURCE_TAGS: Record<Queue["source"], { label: string; title: string } | null> = {
  dashboard: null,
  code: { label: "Code", title: "Defined in mybase.config.ts; change it there and run mybase queue sync" },
  api: { label: "App", title: "Created by your app with createQueue()" },
};

function QueueTags({ queue }: { queue: Queue }) {
  const source = SOURCE_TAGS[queue.source];
  return (
    <>
      {queue.fifo && <Tag title="First in, first out per message group, with deduplication">FIFO</Tag>}
      {queue.deadLetterFor.length > 0 && <Tag title={`Dead-letter queue for ${queue.deadLetterFor.join(", ")}`}>Dead letters</Tag>}
      {source && <Tag title={source.title}>{source.label}</Tag>}
    </>
  );
}

function RangePicker({ range, onChange }: { range: QueueStatsRange; onChange: (r: QueueStatsRange) => void }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-md border p-0.5">
      {QUEUE_STATS_RANGES.map((r) => (
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

function sumSeries(queues: QueueStatsSeries[]): QueueStatsPoint[] {
  const first = queues[0]?.series ?? [];
  const sum = (i: number, f: "sent" | "received" | "deleted" | "dead") => queues.reduce((n, q) => n + (q.series[i]?.[f] ?? 0), 0);
  return first.map((p, i) => ({ t: p.t, sent: sum(i, "sent"), received: sum(i, "received"), deleted: sum(i, "deleted"), dead: sum(i, "dead") }));
}

/** Messages per hour for the whole project, or one queue. */
function Activity({ project, queue, version }: { project: string; queue?: string; version: number }) {
  const [range, setRange] = useState<QueueStatsRange>("24h");
  const stats = useLoad(`queue-stats:${project}:${range}:${version}`, () => api.queueStats(project, range));
  const shown = stats.state.status === "ready" ? stats.state.data.queues.filter((q) => !queue || q.queue === queue) : [];
  return (
    <section aria-labelledby="activity" className="mb-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Activity
        </h2>
        <RangePicker range={range} onChange={setRange} />
      </div>
      {stats.state.status === "loading" && <LoadingLines label="Loading activity" />}
      {stats.state.status === "error" && <LoadError what="activity" message={stats.state.message} onRetry={stats.refresh} />}
      {stats.state.status === "ready" &&
        (shown.every((q) => q.sent + q.received + q.deleted + q.dead === 0) ? (
          <p className="text-muted-foreground">No messages in the last {RANGE_LABELS[range]}. Counts show up here as soon as your app sends one.</p>
        ) : (
          <QueueChart series={sumSeries(shown)} />
        ))}
    </section>
  );
}

// ---- create / edit ------------------------------------------------------------

/** Create a queue, or edit a dashboard or app one. */
function QueueDialog({
  project,
  queue,
  queues,
  open,
  onOpenChange,
  onSaved,
}: {
  project: string;
  /** null: a new queue. */
  queue: Queue | null;
  /** Every queue in the project, for the dead-letter picker. */
  queues: Queue[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (queue: Queue) => void;
}) {
  const [fifo, setFifo] = useState(queue?.fifo ?? false);
  const [contentDedup, setContentDedup] = useState(queue?.contentDedup ?? false);
  const [deadLetter, setDeadLetter] = useState(queue?.deadLetter?.queue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const targets = queues.filter((q) => q.fifo === fifo && q.name !== queue?.name);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (field: string) => String(form.get(field) ?? "").trim();
    const maxReceives = Number(text("maxReceives") || "5");
    const maxBytes = text("maxMessageBytes");
    if (deadLetter && (!Number.isInteger(maxReceives) || maxReceives < 1)) return setError("Max receives is a whole number, at least 1.");
    const settings: QueueSettingsInput = {
      visibilityTimeout: text("visibilityTimeout") || undefined,
      delay: text("delay") || undefined,
      retention: text("retention") || undefined,
      receiveWait: text("receiveWait") || undefined,
      maxMessageBytes: maxBytes ? Number(maxBytes) : undefined,
      contentDedup: fifo ? contentDedup : undefined,
      deadLetter: deadLetter ? { queue: deadLetter, maxReceives } : null,
    };
    setPending(true);
    setError(null);
    try {
      const saved = queue ? await api.updateQueue(project, queue.name, settings) : await api.createQueue(project, { ...settings, name: text("name"), fifo });
      toast.success(queue ? `Saved ${saved.name}` : `Created ${saved.name}`);
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const field = (id: string, label: string, value: string, placeholder: string) => (
    <div className="grid gap-2">
      <Label htmlFor={`queue-${id}`}>{label}</Label>
      <Input id={`queue-${id}`} name={id} defaultValue={value} placeholder={placeholder} autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>{queue ? `Edit ${queue.name}` : "New queue"}</DialogTitle>
            <DialogDescription>Durations: 30s, 5m, 1h, 4d. Empty fields keep {queue ? "their current value" : "the default"}.</DialogDescription>
          </DialogHeader>
          {!queue && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="queue-name">Name</Label>
                <Input id="queue-name" name="name" required autoFocus autoComplete="off" spellCheck={false} className="font-mono text-xs md:text-xs" />
                <p className="text-muted-foreground">{QUEUE_NAME_RULES}</p>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Kind</legend>
                <RadioGroup
                  value={fifo ? "fifo" : "standard"}
                  onValueChange={(v) => {
                    setFifo(v === "fifo");
                    setDeadLetter("");
                  }}
                  className="gap-3"
                >
                  <label className="flex items-start gap-3">
                    <RadioGroupItem value="standard" className="mt-0.5" />
                    <span>
                      <span className="font-medium">Standard</span>
                      <span className="block text-muted-foreground">Delivered at least once, roughly in order. Per-message delays.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3">
                    <RadioGroupItem value="fifo" className="mt-0.5" />
                    <span>
                      <span className="font-medium">FIFO</span>
                      <span className="block text-muted-foreground">Strict order per message group, repeats within 5 minutes dropped. Can't be changed later.</span>
                    </span>
                  </label>
                </RadioGroup>
              </fieldset>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            {field("visibilityTimeout", "Visibility timeout", queue ? durationInput(queue.visibilityTimeoutMs) : "", "30s")}
            {field("retention", "Keep messages for", queue ? durationInput(queue.retentionMs) : "", "4d")}
            {field("delay", "Delay new messages", queue ? durationInput(queue.delayMs) : "", "0s")}
            {field("receiveWait", "Long-poll wait", queue ? durationInput(queue.receiveWaitMs) : "", "0s")}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="queue-maxMessageBytes">Max message size (bytes)</Label>
            <Input id="queue-maxMessageBytes" name="maxMessageBytes" inputMode="numeric" defaultValue={queue?.maxMessageBytes} placeholder={String(MAX_MESSAGE_BYTES)} className="max-w-40" />
          </div>
          {fifo && (
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="font-medium">Content-based deduplication</span>
                <span className="block text-muted-foreground">Sends without a dedupId are deduplicated by their body.</span>
              </span>
              <Switch checked={contentDedup} onCheckedChange={setContentDedup} />
            </label>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="queue-dlq">Dead-letter queue</Label>
              <select
                id="queue-dlq"
                value={deadLetter}
                onChange={(e) => setDeadLetter(e.target.value)}
                className="h-9 rounded-md border bg-transparent px-3 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">None</option>
                {targets.map((q) => (
                  <option key={q.name} value={q.name}>
                    {q.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queue-maxReceives">After receives</Label>
              <Input
                id="queue-maxReceives"
                name="maxReceives"
                inputMode="numeric"
                disabled={!deadLetter}
                defaultValue={queue?.deadLetter?.maxReceives ?? 5}
                className="w-28"
              />
            </div>
          </div>
          <p className="-mt-3 text-muted-foreground">
            Messages received that many times without being deleted move there. {fifo ? "Must be a FIFO queue." : "Must be a standard queue."}
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : queue ? "Save queue" : "Create queue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SendDialog({ project, queue, open, onOpenChange, onSent }: { project: string; queue: Queue; open: boolean; onOpenChange: (open: boolean) => void; onSent: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (field: string) => String(form.get(field) ?? "").trim() || undefined;
    const delay = text("delay");
    setPending(true);
    setError(null);
    try {
      const delayMs = delay === undefined ? undefined : parseDurationMs(delay);
      const res = await api.sendQueueMessage(project, queue.name, { body: String(form.get("body") ?? ""), groupId: text("groupId"), dedupId: text("dedupId"), delayMs });
      if (res.failed[0]) throw new Error(res.failed[0].error);
      toast.success(res.successful[0]?.duplicate ? "Already sent in the last 5 minutes; not added again" : `Sent to ${queue.name}`);
      onSent();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Send to {queue.name}</DialogTitle>
            <DialogDescription>A real message: your consumers will receive it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="send-body">Body</Label>
            <Textarea id="send-body" name="body" required autoFocus rows={6} spellCheck={false} placeholder='{"hello": "world"}' className="font-mono text-xs md:text-xs" />
          </div>
          {queue.fifo ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="send-group">Group id</Label>
                <Input id="send-group" name="groupId" required autoComplete="off" className="font-mono text-xs md:text-xs" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="send-dedup">Dedup id</Label>
                <Input id="send-dedup" name="dedupId" required={!queue.contentDedup} placeholder={queue.contentDedup ? "From the body" : undefined} autoComplete="off" className="font-mono text-xs md:text-xs" />
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="send-delay">Delay</Label>
              <Input id="send-delay" name="delay" placeholder={durationInput(queue.delayMs)} className="w-32 font-mono text-xs md:text-xs" />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDurationMs(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value);
  if (!m) throw new Error(`"${value}" isn't a duration. Use ms, or e.g. 30s or 5m.`);
  return Math.round(Number(m[1]) * UNITS[m[2] ?? "ms"]!);
}

// ---- list ---------------------------------------------------------------------

function QueueList({ project, queues, onCreate }: { project: string; queues: Queue[]; onCreate: () => void }) {
  if (queues.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No queues yet</p>
        <p className="mt-1 text-muted-foreground">
          A queue holds messages until a worker handles them: emails to send, images to resize, webhooks to retry. Create one here, declare them in{" "}
          <code className="font-mono text-[0.85em] text-foreground">mybase.config.ts</code>, or call <code className="font-mono text-[0.85em] text-foreground">createQueue()</code> from your
          app.
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onCreate}>
          <Plus />
          New queue
        </Button>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Visible</TableHead>
          <TableHead className="text-right">In flight</TableHead>
          <TableHead className="text-right">Delayed</TableHead>
          <TableHead>Oldest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {queues.map((q) => (
          <TableRow key={q.name}>
            <TableCell>
              <span className="flex flex-wrap items-center gap-2">
                <a href={href({ page: "queue", name: project, queue: q.name })} className="font-mono text-xs font-medium outline-none hover:underline focus-visible:underline">
                  {q.name}
                </a>
                <QueueTags queue={q} />
              </span>
            </TableCell>
            <TableCell className={cn("text-right", q.deadLetterFor.length > 0 && q.counts.visible > 0 && "text-destructive")}>{formatCount(q.counts.visible)}</TableCell>
            <TableCell className="text-right">{formatCount(q.counts.inFlight)}</TableCell>
            <TableCell className="text-right">{formatCount(q.counts.delayed)}</TableCell>
            <TableCell className="text-muted-foreground">
              {q.oldestMessageAt ? (
                <time dateTime={q.oldestMessageAt} title={formatDate(q.oldestMessageAt)}>
                  {timeAgo(q.oldestMessageAt)}
                </time>
              ) : (
                "–"
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Queues({ project }: { project: Project }) {
  const name = project.name;
  const [version, setVersion] = useState(0);
  const queues = useLoad(`queues:${name}:${version}`, () => api.queues(name));
  const settings = useLoad(`queue-settings:${name}`, () => api.queueSettings(name));
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"key" | "off" | null>(null);

  async function turnOff() {
    try {
      await api.disableService(name, "queue");
      await refreshProjects();
      toast.success(`Turned off queues for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off queues: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title="Queues"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="Messages your app hands off to workers, kept until they're handled."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New queue
          </Button>
        }
      />
      <Activity project={name} version={version} />

      <section aria-labelledby="queues" className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="queues" className="text-base font-semibold">
            Queues
          </h2>
          {queues.state.status === "ready" && queues.state.data.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
              <RefreshCw />
              Refresh
            </Button>
          )}
        </div>
        {queues.state.status === "loading" && <LoadingLines label="Loading queues" />}
        {queues.state.status === "error" && <LoadError what="queues" message={queues.state.message} onRetry={queues.refresh} />}
        {queues.state.status === "ready" && <QueueList project={name} queues={queues.state.data} onCreate={() => setCreating(true)} />}
      </section>

      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        {settings.state.status === "loading" && <LoadingLines label="Loading settings" />}
        {settings.state.status === "error" && <LoadError what="settings" message={settings.state.message} onRetry={settings.refresh} />}
        {settings.state.status === "ready" && (
          <>
            <Row title="API key" hint="Your server sends an API key with queue:write for this project. Keep it out of browser code.">
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
              title="Send and consume"
              hint={
                <>
                  <code className="font-mono text-[0.85em] text-foreground">npm install @mybase-dev/sdk</code>. Delivery is at least once: a handler that throws gets the
                  message again, so make handlers safe to repeat.
                </>
              }
            >
              {code(sdkSnippet(settings.state.data.apiUrl, name))}
            </Row>
            <Row title="Queues in code" hint="Code queues show a Code tag and can only be changed by syncing.">
              {code(CONFIG_SNIPPET.replace("<project>", name))}
            </Row>
            <Row title="Endpoint" hint="For other languages: POST JSON to <queue>/messages, /receive, /delete with an API key as a Bearer token.">
              <CopyField id="queue-url" label="Base URL" value={settings.state.data.baseUrl} />
            </Row>
          </>
        )}
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off queues
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every queue and message. API keys stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off queues
          </Button>
        </div>
      </section>

      {creating && (
        <QueueDialog
          project={name}
          queue={null}
          queues={queues.state.status === "ready" ? queues.state.data : []}
          open
          onOpenChange={(open) => !open && setCreating(false)}
          onSaved={() => setVersion((v) => v + 1)}
        />
      )}
      <KeyDialog
        open={dialog === "key"}
        onOpenChange={(open) => !open && setDialog(null)}
        preset={{ name: `${name} queues`, permissions: ["queue:write"], projects: [name] }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off queues for ${name}`}
        description={SERVICE_PAGES.queue.turnOff}
        confirm="Turn off queues"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

// ---- one queue ----------------------------------------------------------------

const STATE_LABELS: Record<QueueMessageRecord["state"], string> = { visible: "Visible", inFlight: "In flight", delayed: "Delayed" };

function Messages({ project, queue, version, onChange }: { project: string; queue: Queue; version: number; onChange: () => void }) {
  const messages = useLoad(`queue-messages:${project}:${queue.name}:${version}`, () => api.queueMessages(project, queue.name));
  const [open, setOpen] = useState<string | null>(null);

  async function remove(id: string) {
    try {
      await api.deleteQueueMessage(project, queue.name, id);
      toast.success("Deleted the message");
      onChange();
    } catch (err) {
      toast.error(`Couldn't delete the message: ${errorMessage(err)}`);
    }
  }

  if (messages.state.status === "loading") return <LoadingLines label="Loading messages" />;
  if (messages.state.status === "error") return <LoadError what="messages" message={messages.state.message} onRetry={messages.refresh} />;
  if (messages.state.data.length === 0) return <p className="text-muted-foreground">Empty. Messages show up here until a consumer deletes them.</p>;
  return (
    <>
      <p className="mb-3 text-muted-foreground">
        Oldest first{messages.state.data.length === 50 ? ", the first 50" : ""}. Looking doesn't receive them or change anything.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Body</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.state.data.map((m) => {
            const expanded = open === m.messageId;
            return (
              <TableRow key={m.messageId} className="align-top">
                <TableCell className="max-w-0 w-full">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : m.messageId)}
                    className={cn("block w-full text-left font-mono text-xs outline-none focus-visible:underline", expanded ? "whitespace-pre-wrap break-all" : "truncate")}
                  >
                    {m.body}
                    {m.truncated && "…"}
                  </button>
                  {expanded && (
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                      <dt>Id</dt>
                      <dd className="font-mono text-xs">{m.messageId}</dd>
                      <dt>Size</dt>
                      <dd>{formatBytes(m.bytes)}</dd>
                      {m.groupId && (
                        <>
                          <dt>Group</dt>
                          <dd className="font-mono text-xs">{m.groupId}</dd>
                        </>
                      )}
                      {m.sequence && (
                        <>
                          <dt>Sequence</dt>
                          <dd>{m.sequence}</dd>
                        </>
                      )}
                      {Object.keys(m.attributes).length > 0 && (
                        <>
                          <dt>Attributes</dt>
                          <dd className="font-mono text-xs">{JSON.stringify(m.attributes)}</dd>
                        </>
                      )}
                      {m.deadLetteredFrom && (
                        <>
                          <dt>Dead-lettered from</dt>
                          <dd className="font-mono text-xs">{m.deadLetteredFrom}</dd>
                        </>
                      )}
                      <dt>Expires</dt>
                      <dd>
                        <time dateTime={m.expiresAt} title={formatDate(m.expiresAt)}>
                          {timeAgo(m.expiresAt)}
                        </time>
                      </dd>
                    </dl>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {STATE_LABELS[m.state]}
                  <span className="block text-muted-foreground">
                    {m.state === "visible" ? (m.receiveCount > 0 ? `Received ${plural(m.receiveCount, "time", "times")}` : "Not received yet") : <>until {timeAgo(m.visibleAt).replace(/^in /, "")}</>}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={m.sentAt} title={formatDate(m.sentAt)}>
                    {timeAgo(m.sentAt)}
                  </time>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label="Delete message" title="Delete message" onClick={() => remove(m.messageId)}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function QueueDetail({ project, name }: { project: string; name: string }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const queue = useLoad(`queue:${project}:${name}:${version}`, () => api.queue(project, name));
  const all = useLoad(`queues:${project}:detail:${version}`, () => api.queues(project));
  const [dialog, setDialog] = useState<"send" | "edit" | "purge" | "delete" | "redrive" | null>(null);
  const breadcrumb = { label: "Queues", href: href({ page: "queue", name: project, queue: null }) };

  if (queue.state.status !== "ready") {
    return (
      <>
        <PageHeader title={name} breadcrumb={breadcrumb} />
        {queue.state.status === "loading" ? <LoadingLines label="Loading queue" /> : <LoadError what="the queue" message={queue.state.message} onRetry={queue.refresh} />}
      </>
    );
  }
  const q = queue.state.data;
  const editable = q.source !== "code";

  async function purge() {
    try {
      await api.purgeQueue(project, name);
      toast.success(`Purged ${name}`);
      bump();
    } catch (err) {
      toast.error(`Couldn't purge the queue: ${errorMessage(err)}`);
    }
  }
  async function remove() {
    try {
      await api.deleteQueue(project, name);
      toast.success(`Deleted ${name}`);
      navigate({ page: "queue", name: project, queue: null });
    } catch (err) {
      toast.error(`Couldn't delete the queue: ${errorMessage(err)}`);
    }
  }
  async function redrive() {
    try {
      const { moved } = await api.redriveQueue(project, name);
      toast.success(`Moved ${plural(moved, "message", "messages")} back`);
      bump();
    } catch (err) {
      toast.error(`Couldn't move the messages: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader
        title={name}
        breadcrumb={breadcrumb}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {q.fifo ? "FIFO queue" : "Standard queue"}
            <QueueTags queue={q} />
          </span>
        }
        action={
          <Button onClick={() => setDialog("send")}>
            <Send />
            Send message
          </Button>
        }
      />

      <dl className="mb-10 grid grid-cols-3 gap-3 sm:max-w-lg">
        {(
          [
            ["Visible", q.counts.visible],
            ["In flight", q.counts.inFlight],
            ["Delayed", q.counts.delayed],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-lg border p-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(n)}</dd>
          </div>
        ))}
      </dl>

      <Activity project={project} queue={name} version={version} />

      <section aria-labelledby="messages" className="mb-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="messages" className="text-base font-semibold">
            Messages
          </h2>
          <div className="flex gap-2">
            {q.deadLetterFor.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setDialog("redrive")}>
                <Undo2 />
                Move back
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={bump}>
              <RefreshCw />
              Refresh
            </Button>
          </div>
        </div>
        <Messages project={project} queue={q} version={version} onChange={bump} />
      </section>

      <section aria-labelledby="settings" className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="settings" className="text-base font-semibold">
            Settings
          </h2>
          {editable && (
            <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
              Edit settings
            </Button>
          )}
        </div>
        {!editable && <p className="mb-3 text-muted-foreground">Defined in mybase.config.ts. Change it there and run mybase queue sync.</p>}
        <Row title="Visibility timeout" hint="How long a received message stays hidden while a consumer works on it.">
          {formatDuration(q.visibilityTimeoutMs)}
        </Row>
        <Row title="Retention" hint="Messages nobody deletes are dropped after this long.">
          {formatDuration(q.retentionMs)}
        </Row>
        <Row title="Delay" hint="New messages wait this long before they can be received.">
          {q.delayMs ? formatDuration(q.delayMs) : "None"}
        </Row>
        <Row title="Long-poll wait" hint="How long a receive waits for a message when it doesn't set its own wait.">
          {q.receiveWaitMs ? formatDuration(q.receiveWaitMs) : "None (answers at once)"}
        </Row>
        <Row title="Max message size" hint="Body plus attributes.">
          {formatBytes(q.maxMessageBytes)}
        </Row>
        {q.fifo && (
          <Row title="Deduplication" hint="Sends repeating a dedup id within 5 minutes are accepted but not added again.">
            {q.contentDedup ? "By dedup id, or the body when there's none" : "By dedup id (required on every send)"}
          </Row>
        )}
        <Row title="Dead-letter queue" hint="Where messages go after too many failed deliveries.">
          {q.deadLetter ? (
            <>
              <a href={href({ page: "queue", name: project, queue: q.deadLetter.queue })} className="font-mono text-xs underline-offset-4 hover:underline">
                {q.deadLetter.queue}
              </a>{" "}
              after {plural(q.deadLetter.maxReceives, "receive", "receives")}
            </>
          ) : (
            "None: failing messages are retried until they expire"
          )}
        </Row>
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Danger zone
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Purge deletes every message and keeps the queue.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("purge")}>
            Purge queue
          </Button>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
            <p className="max-w-prose text-muted-foreground">Deletes the queue and its messages. Queues using it as their dead-letter queue lose that setting.</p>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
              Delete queue
            </Button>
          </div>
        )}
      </section>

      <SendDialog project={project} queue={q} open={dialog === "send"} onOpenChange={(open) => !open && setDialog(null)} onSent={bump} />
      {dialog === "edit" && (
        <QueueDialog
          project={project}
          queue={q}
          queues={all.state.status === "ready" ? all.state.data : []}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onSaved={bump}
        />
      )}
      <ConfirmDialog
        open={dialog === "purge"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Purge ${name}`}
        description={`Deletes all ${plural(q.counts.visible + q.counts.inFlight + q.counts.delayed, "message", "messages")}, including ones being worked on. This can't be undone.`}
        confirm="Purge queue"
        pendingLabel="Purging…"
        onConfirm={purge}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${name}`}
        description="Deletes the queue and every message in it. Apps still using it get 404s."
        confirm="Delete queue"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
      <ConfirmDialog
        open={dialog === "redrive"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Move ${name}'s messages back`}
        description={`Each message goes back to the queue it failed in (${q.deadLetterFor.join(", ")}) with its receive count reset. Fix whatever made them fail first.`}
        confirm="Move back"
        pendingLabel="Moving…"
        onConfirm={redrive}
        destructive={false}
      />
    </>
  );
}

export function QueuePage({ name, queue }: { name: string; queue: string | null }) {
  return (
    <ProjectGate name={name} title="Queues" backToProject>
      {(project) => {
        if (!project.services.includes("queue")) {
          return (
            <ServiceOff project={project} id="queue">
              Turn them on to hand work off to background workers: your app sends a message, a worker receives it, and failed messages are retried or set aside.
              Standard and FIFO queues, like SQS.
            </ServiceOff>
          );
        }
        return queue ? <QueueDetail key={queue} project={name} name={queue} /> : <Queues project={project} />;
      }}
    </ProjectGate>
  );
}

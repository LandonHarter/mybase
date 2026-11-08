import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { ChevronRight, KeyRound, Plus, RefreshCw, Send, Undo2 } from "lucide-react";
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
import { Inspector, Facts } from "@/components/inspector";
import { Sparkline } from "@/components/sparkline";
import { TimeAgo, Countdown } from "@/components/time-ago";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineDelete } from "@/components/inline-delete";
import { SegmentedControl } from "@/components/tabs";
import { ConnectSheet, DangerZone, ServiceViews } from "@/components/service-layout";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { QueueChart } from "@/components/queue-chart";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Select } from "@/components/ui/select";
import { Badge, LiveIndicator } from "@/components/status";
import { CodeBlock } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDate, formatDuration, plural } from "@/lib/format";
import { errorMessage, invalidate, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate, useServiceView } from "@/lib/router";
import { cn } from "@/lib/utils";

// The same names and limits as QUEUE_NAME_RULES / QUEUE_LIMITS in @mybase-dev/sdk/queue (types
// only reach the dashboard's browser build, so the values are repeated here).
const QUEUE_NAME_RULES = "Use 1–80 lowercase letters, digits, `_`, or `-`, starting with a letter or digit.";
const MAX_MESSAGE_BYTES = 256 * 1024;

const RANGE_LABELS: Record<QueueStatsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
};

const code = (text: string, lang = "auto") => <CodeBlock code={text} lang={lang} />;

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
  for (const [unit, size] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return String(ms);
}

function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <Badge tone="outline" title={title}>
      {children}
    </Badge>
  );
}

const SOURCE_TAGS: Record<Queue["source"], { label: string; title: string } | null> = {
  dashboard: null,
  code: {
    label: "Code",
    title: "Defined in mybase.config.ts; change it there and run mybase queue sync",
  },
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
    <SegmentedControl
      label="Time range"
      value={range}
      options={QUEUE_STATS_RANGES.map((r) => ({
        value: r,
        label: RANGE_LABELS[r],
      }))}
      onChange={onChange}
    />
  );
}

function sumSeries(queues: QueueStatsSeries[]): QueueStatsPoint[] {
  const first = queues[0]?.series ?? [];
  const sum = (i: number, f: "sent" | "received" | "deleted" | "dead") => queues.reduce((n, q) => n + (q.series[i]?.[f] ?? 0), 0);
  return first.map((p, i) => ({
    t: p.t,
    sent: sum(i, "sent"),
    received: sum(i, "received"),
    deleted: sum(i, "deleted"),
    dead: sum(i, "dead"),
  }));
}

/** Messages per hour for the whole project, or one queue. */
function Activity({ project, queue, version }: { project: string; queue?: string; version: number }) {
  const [range, setRange] = useState<QueueStatsRange>("24h");
  const stats = useLoad(`queue-stats:${project}:${range}`, () => api.queueStats(project, range), { interval: 60_000 });
  const shown = stats.state.status === "ready" ? stats.state.data.queues.filter((q) => !queue || q.queue === queue) : [];
  return (
    <section aria-labelledby="activity" className="mb-8">
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

function invalidateQueue(project: string) {
  for (const prefix of [`queues:${project}`, `queue:${project}:`, `queue-stats:${project}:`, `queue-messages:${project}:`, `queue-body:${project}:`])
    invalidate(prefix);
}
function QueueMiniChart({ project, name }: { project: string; name: string }) {
  const stats = useLoad(`queue-stats:${project}:24h`, () => api.queueStats(project, "24h"), { interval: 60_000 });
  const series = stats.data?.queues.find((q) => q.queue === name)?.series;
  if (!series) return null;
  return (
    <div className="mb-5 flex flex-wrap gap-5 text-xs text-muted-foreground">
      {(["sent", "deleted"] as const).map((metric) => (
        <div key={metric} className="flex items-center gap-2">
          <span>{metric === "sent" ? "Sent" : "Deleted"} · 24 h</span>
          <Sparkline
            values={series.map((p) => p[metric])}
            label={`${metric} messages in the last 24 hours`}
            className={metric === "deleted" ? "text-chart-3" : undefined}
          />
        </div>
      ))}
    </div>
  );
}

function ActivityDisclosure(props: { project: string; queue?: string; version: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mb-8" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-2 font-medium">Activity · sent vs deleted</summary>
      {open && <Activity {...props} />}
    </details>
  );
}
function ChangedCount({ value }: { value: number }) {
  return (
    <span key={value} className="animate-arrive tabular-nums">
      {formatCount(value)}
    </span>
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
  const [creatingTarget, setCreatingTarget] = useState(false);
  const [createdTargets, setCreatedTargets] = useState<Queue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const targets = [...queues, ...createdTargets].filter((q) => q.fifo === fifo && q.name !== queue?.name);

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
      const saved = queue
        ? await api.updateQueue(project, queue.name, settings)
        : await api.createQueue(project, {
            ...settings,
            name: text("name"),
            fifo,
          });
      toast.success(queue ? `Saved ${saved.name}` : `Created ${saved.name}`);
      invalidateQueue(project);
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const field = (id: string, label: string, value: string, _placeholder: string) => <DurationField id={id} label={label} initial={value} />;

  return (
    <Sheet open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <SheetContent wide className="overflow-y-auto p-5">
        <form onSubmit={onSubmit} className="grid gap-5">
          <SheetHeader className="text-left">
            <SheetTitle>{queue ? `Edit ${queue.name}` : "New queue"}</SheetTitle>
            <SheetDescription>Defaults are filled in. Durations accept ms, s, m, h and d; bare numbers mean milliseconds.</SheetDescription>
          </SheetHeader>
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
                      <span className="block text-muted-foreground">
                        Strict order per message group, repeats within 5 minutes dropped. Can't be changed later.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </fieldset>
            </>
          )}
          {field("visibilityTimeout", "Visibility timeout", durationInput(queue?.visibilityTimeoutMs ?? 30_000), "30s")}
          <details className="grid gap-3">
            <summary className="cursor-pointer py-2 font-medium">Advanced: retention, delay, polling and size</summary>
            <div className="grid grid-cols-2 gap-3">
              {field("retention", "Keep messages for", durationInput(queue?.retentionMs ?? 345_600_000), "4d")}
              {field("delay", "Delay new messages", durationInput(queue?.delayMs ?? 0), "0s")}
              {field("receiveWait", "Long-poll wait", durationInput(queue?.receiveWaitMs ?? 0), "0s")}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queue-maxMessageBytes">Max message size (bytes)</Label>
              <Input
                id="queue-maxMessageBytes"
                name="maxMessageBytes"
                inputMode="numeric"
                defaultValue={queue?.maxMessageBytes ?? MAX_MESSAGE_BYTES}
                placeholder={String(MAX_MESSAGE_BYTES)}
                className="max-w-40"
              />
            </div>
          </details>
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
              <Select id="queue-dlq" value={deadLetter} onChange={(e) => setDeadLetter(e.target.value)} className="font-mono md:text-[13px]">
                <option value="">None</option>
                {targets.map((q) => (
                  <option key={q.name} value={q.name}>
                    {q.name}
                  </option>
                ))}
              </Select>
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
          <Button type="button" variant="outline" onClick={() => setCreatingTarget(true)}>
            Create dead-letter target…
          </Button>
          <p className="text-muted-foreground">
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
        {creatingTarget && (
          <QueueDialog
            project={project}
            queue={null}
            queues={queues}
            open
            onOpenChange={setCreatingTarget}
            onSaved={(target) => {
              setCreatedTargets((old) => [...old, target]);
              if (target.fifo === fifo) setDeadLetter(target.name);
              else toast.info("Target created. Choose a queue with the same kind.");
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type SendDraft = {
  body: string;
  groupId?: string;
  attributes?: QueueMessageRecord["attributes"];
};
const draftKey = (project: string, queue: string) => `mybase.queue-draft:${project}:${queue}`;
function readDraft(project: string, queue: string): SendDraft {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey(project, queue)) ?? "null") ?? { body: "" };
  } catch {
    return { body: "" };
  }
}
function saveDraft(project: string, queue: string, draft: SendDraft) {
  try {
    const keys: string[] = JSON.parse(sessionStorage.getItem("mybase.queue-drafts") ?? "[]");
    const ordered = [...keys.filter((k) => k !== draftKey(project, queue)), draftKey(project, queue)];
    for (const key of ordered.slice(0, -20)) sessionStorage.removeItem(key);
    sessionStorage.setItem("mybase.queue-drafts", JSON.stringify(ordered.slice(-20)));
    sessionStorage.setItem(draftKey(project, queue), JSON.stringify(draft));
  } catch {
    /* Storage may be disabled or full; the in-memory draft remains. */
  }
}
function pretty(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function SendDialog({
  project,
  queue,
  open,
  onOpenChange,
  onSent,
  initial,
}: {
  project: string;
  queue: Queue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (id?: string) => void;
  initial?: SendDraft;
}) {
  const [draft, setDraft] = useState<SendDraft>(() => initial ?? readDraft(project, queue.name));
  const [json, setJson] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const bytes =
    new TextEncoder().encode(draft.body).length +
    (draft.attributes && Object.keys(draft.attributes).length ? new TextEncoder().encode(JSON.stringify(draft.attributes)).length : 0);
  const change = (next: SendDraft) => {
    setDraft(next);
    saveDraft(project, queue.name, next);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const text = (field: string) => String(form.get(field) ?? "").trim() || undefined;
    setError(null);
    try {
      if (bytes > queue.maxMessageBytes) throw new Error("Body plus attributes exceeds the queue's maximum size.");
      if (json) JSON.parse(draft.body);
      const delay = text("delay");
      const delayMs = delay === undefined ? undefined : parseDurationMs(delay);
      setPending(true);
      const res = await api.sendQueueMessage(project, queue.name, {
        body: draft.body,
        attributes: draft.attributes,
        groupId: text("groupId"),
        dedupId: text("dedupId"),
        delayMs,
      });
      if (res.failed[0]) throw new Error(res.failed[0].error);
      const sent = res.successful[0];
      if (!sent) throw new Error("The server returned no send result. Check the message list before retrying.");
      toast.success(sent.duplicate ? "Already sent in the last 5 minutes; not added again" : `Sent to ${queue.name}`);
      onSent(sent.duplicate ? undefined : sent.messageId);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={onSubmit}
          className="grid gap-4"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Send to {project} / {queue.name}
            </DialogTitle>
            <DialogDescription>A real message: your consumers will receive it. Last draft stays in this tab until cleared.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Body format"
              value={json ? "json" : "text"}
              options={[
                { value: "text", label: "Text" },
                { value: "json", label: "JSON" },
              ]}
              onChange={(v) => setJson(v === "json")}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                try {
                  change({
                    ...draft,
                    body: JSON.stringify(JSON.parse(draft.body), null, 2),
                  });
                  setError(null);
                } catch {
                  setError("Body is not valid JSON.");
                }
              }}
            >
              Format JSON
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft({ body: "" });
                try {
                  sessionStorage.removeItem(draftKey(project, queue.name));
                } catch {}
              }}
            >
              Clear draft
            </Button>
          </div>
          <Label htmlFor="send-body">Body</Label>
          <Textarea
            id="send-body"
            required
            autoFocus
            rows={8}
            value={draft.body}
            onChange={(e) => change({ ...draft, body: e.target.value })}
            spellCheck={false}
            className="font-mono text-base md:text-[13px]"
          />
          <p className={bytes > queue.maxMessageBytes ? "text-destructive" : "text-muted-foreground"}>
            {formatBytes(bytes)} / {formatBytes(queue.maxMessageBytes)} · ⌘/Ctrl+Enter sends
          </p>
          {queue.fifo ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="send-group">Group ID</Label>
                <Input id="send-group" name="groupId" required value={draft.groupId ?? ""} onChange={(e) => change({ ...draft, groupId: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="send-dedup">Dedup ID</Label>
                <Input id="send-dedup" name="dedupId" required={!queue.contentDedup} placeholder={queue.contentDedup ? "From body" : "New unique ID"} />
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="send-delay">Delay</Label>
              <Input id="send-delay" name="delay" placeholder={durationInput(queue.delayMs)} />
            </div>
          )}
          {draft.attributes && (
            <div>
              <p>Attributes copied from the original message</p>
              <CodeBlock code={JSON.stringify(draft.attributes, null, 2)} lang="json" />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || bytes > queue.maxMessageBytes}>
              {pending ? "Sending…" : "Send message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DurationField({ id, label, initial }: { id: string; label: string; initial: string }) {
  const [value, setValue] = useState(initial);
  let hint = "Use a number followed by ms, s, m, h or d.";
  try {
    hint = `= ${formatDuration(parseDurationMs(value))}`;
  } catch {}
  return (
    <div className="grid gap-2">
      <Label htmlFor={`queue-${id}`}>{label}</Label>
      <Input
        id={`queue-${id}`}
        name={id}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-describedby={`queue-${id}-help`}
        className="font-mono text-base md:text-[13px]"
      />
      <div className="flex gap-1">
        {["ms", "s", "m", "h", "d"].map((unit) => (
          <Button
            key={unit}
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Use ${unit} for ${label}`}
            onClick={() => setValue(value.replace(/[a-z]+$/, "") + unit)}
          >
            {unit}
          </Button>
        ))}
      </div>
      <p id={`queue-${id}-help`} className="text-muted-foreground">
        {
          {
            visibilityTimeout: "A received message stays hidden while its consumer works. ",
            retention: "Undeleted messages expire after this time. ",
            delay: "New messages wait before they can be received. ",
            receiveWait: "Receives wait for new messages, up to 20 seconds. ",
          }[id]
        }
        {hint}
      </p>
    </div>
  );
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseDurationMs(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value);
  if (!m) throw new Error(`"${value}" isn't a duration. Use ms, or e.g. 30s or 5m.`);
  return Math.round(Number(m[1]) * UNITS[m[2] ?? "ms"]!);
}

// ---- list ---------------------------------------------------------------------

function QueueList({ project, queues, onCreate }: { project: string; queues: Queue[]; onCreate: () => void }) {
  const stats = useLoad(`queue-stats:${project}:24h`, () => api.queueStats(project, "24h"), { interval: 60_000 });
  if (queues.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">No queues yet</p>
        <p className="mt-1 text-muted-foreground">
          A queue holds messages until a worker handles them: emails to send, images to resize, webhooks to retry. Create one here, declare them in{" "}
          <code className="font-mono text-[0.85em] text-foreground">mybase.config.ts</code>, or call{" "}
          <code className="font-mono text-[0.85em] text-foreground">createQueue()</code> from your app.
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
          <TableHead>Sent · 24 h</TableHead>
          <TableHead>Oldest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {queues.map((q) => (
          <TableRow key={q.name}>
            <TableCell>
              <span className="flex flex-wrap items-center gap-2">
                <a
                  href={href({ page: "queue", name: project, queue: q.name })}
                  className="font-mono text-xs font-medium outline-none hover:underline focus-visible:underline"
                >
                  {q.name}
                </a>
                <QueueTags queue={q} />
              </span>
            </TableCell>
            <TableCell className={cn("text-right", q.deadLetterFor.length > 0 && q.counts.visible > 0 && "text-destructive")}>
              <a href={`${href({ page: "queue", name: project, queue: q.name })}&state=visible`}>
                <ChangedCount value={q.counts.visible} />
                {q.deadLetterFor.length > 0 && " dead letters"}
              </a>
            </TableCell>
            <TableCell className="text-right">
              <ChangedCount value={q.counts.inFlight} />
            </TableCell>
            <TableCell className="text-right">
              <ChangedCount value={q.counts.delayed} />
            </TableCell>
            <TableCell>
              {stats.state.status === "ready" && (
                <Sparkline
                  label={`${q.name}, messages sent in 24 hours`}
                  values={stats.state.data.queues.find((series) => series.queue === q.name)?.series.map((p) => p.sent) ?? []}
                />
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{q.oldestMessageAt ? <TimeAgo iso={q.oldestMessageAt} /> : "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** "4 queues · 312 waiting · 2 dead" (A01). */
function queueFacts(queues: Queue[] | null) {
  if (!queues) return " ";
  const waiting = queues.reduce((n, q) => n + q.counts.visible + q.counts.delayed, 0);
  const dead = queues.filter((q) => q.deadLetterFor.length > 0).reduce((n, q) => n + q.counts.visible, 0);
  return (
    <span aria-live="polite">
      {plural(queues.length, "queue", "queues")} · {formatCount(waiting)} waiting
      {dead > 0 && (
        <>
          {" "}
          · <span className="text-destructive">{formatCount(dead)} dead</span>
        </>
      )}
    </span>
  );
}

function Queues({ project }: { project: Project }) {
  const name = project.name;
  const view = useServiceView();
  const [version, setVersion] = useState(0);
  const queues = useLoad(`queues:${name}`, () => api.queues(name), {
    interval: view === "settings" ? undefined : 15_000,
  });
  const settings = useLoad(`queue-settings:${name}`, () => api.queueSettings(name));
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"key" | "off" | null>(null);
  const [typedName, setTypedName] = useState("");

  async function turnOff() {
    if (queues.state.status !== "ready") throw new Error("Load the queue list before turning off queues so the impact can be checked.");
    if (typedName !== name) throw new Error(`Type ${name} to turn off queues.`);
    await api.disableService(name, "queue");
    await refreshProjects();
    toast.success(`Turned off queues for ${name}`);
    navigate({ page: "project", name });
  }

  return (
    <>
      <PageHeader
        title="Queues"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description={queueFacts(queues.state.status === "ready" ? queues.state.data : null)}
        action={
          <>
            <ConnectSheet title={`Connect an app to ${name}'s queues`}>
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
                        <code className="font-mono text-[0.85em] text-foreground">npm install @mybase-dev/sdk</code>. Delivery is at least once: a handler that
                        throws gets the message again, so make handlers safe to repeat.
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
            </ConnectSheet>
            <Button onClick={() => setCreating(true)} data-shortcut="create">
              <Plus />
              New queue
            </Button>
          </>
        }
      />
      <ServiceViews route={{ page: "queue", name, queue: null }} view={view} label="Queues" main="Queues" />

      {view !== "settings" && (
        <section aria-labelledby="queues" className="mb-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="queues" className="text-base font-semibold">
              Queues
            </h2>
            {queues.state.status === "ready" && queues.state.data.length > 0 && <LiveIndicator load={queues} />}
          </div>
          {queues.state.status === "loading" && <LoadingLines label="Loading queues" />}
          {queues.state.status === "error" && <LoadError what="queues" message={queues.state.message} onRetry={queues.refresh} />}
          {queues.state.status === "ready" && <QueueList project={name} queues={queues.state.data} onCreate={() => setCreating(true)} />}
        </section>
      )}

      {view !== "settings" && <ActivityDisclosure project={name} version={version} />}
      {view === "settings" && (
        <DangerZone
          title="Delete queue data and turn off"
          action={
            <Button variant="danger-outline" onClick={() => setDialog("off")}>
              Turn off queues…
            </Button>
          }
        >
          Deletes every queue and every message in them, including unprocessed ones. API keys stay; apps still using queues get errors.
        </DangerZone>
      )}

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
        preset={{
          name: `${name} queues`,
          permissions: ["queue:write"],
          projects: [name],
        }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off queues for ${name}`}
        description={
          <>
            {SERVICE_PAGES.queue.turnOff}{" "}
            {queues.state.status === "ready"
              ? `${queues.state.data.length} queues and ${queues.state.data.reduce((n, q) => n + q.counts.visible + q.counts.delayed + q.counts.inFlight, 0)} messages will be deleted.`
              : "Refresh the queue list to check the impact."}
          </>
        }
        confirm="Turn off queues"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      >
        <Label htmlFor="off-queue-name">Type {name}</Label>
        <Input id="off-queue-name" value={typedName} onChange={(e) => setTypedName(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

// ---- one queue ----------------------------------------------------------------

const STATE_LABELS: Record<QueueMessageRecord["state"], string> = {
  visible: "Visible",
  inFlight: "In flight",
  delayed: "Delayed",
};

const subscribeHash = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};
function useMessageFilters() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const params = new URLSearchParams(hash.split("?")[1]);
  const set = (key: string, value: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "after") params.delete("after");
    window.location.hash = `${hash.split("?")[0]}?${params}`;
  };
  return {
    state: params.get("state") ?? "",
    group: params.get("group") ?? "",
    id: params.get("id") ?? "",
    after: params.get("after") ?? "",
    set,
  };
}
function MessageInspector({
  project,
  queue,
  message,
  onClose,
  onSendAgain,
}: {
  project: string;
  queue: Queue;
  message: QueueMessageRecord;
  onClose: () => void;
  onSendAgain: (draft: SendDraft) => void;
}) {
  const full = useLoad(`queue-body:${project}:${queue.name}:${message.messageId}`, () =>
    api.queueMessages(project, queue.name, {
      id: message.messageId,
      full: "1",
      limit: "1",
    }),
  );
  const current = full.state.status === "ready" ? full.state.data[0] : undefined;
  return (
    <Inspector
      open
      onOpenChange={(open) => !open && onClose()}
      kind="Message"
      identifier={message.messageId}
      description={`${project} / ${queue.name} · Inspecting does not receive the message.`}
      actions={
        <Button
          disabled={!current || current.truncated}
          onClick={() =>
            current &&
            onSendAgain({
              body: current.body,
              groupId: current.groupId ?? undefined,
              attributes: current.attributes,
            })
          }
        >
          <Send />
          Send again…
        </Button>
      }
    >
      {full.state.status === "loading" && <LoadingLines label="Loading full body" />}
      {full.state.status === "error" && <LoadError what="message body" message={full.state.message} onRetry={full.refresh} />}
      {full.state.status === "ready" && !current && <p>This message was deleted or expired.</p>}
      {current && (
        <>
          <h3 className="mb-2 font-medium">Body</h3>
          {current.truncated && <p role="alert">Body is truncated; sending again is unavailable.</p>}
          <CodeBlock code={pretty(current.body)} copyText={current.body} />
          <Facts
            className="mt-5"
            items={[
              ["State", STATE_LABELS[current.state]],
              ["Receives", String(current.receiveCount)],
              ["Size", formatBytes(current.bytes)],
              ["Group", current.groupId ?? "—"],
              ["Dedup ID", current.dedupId ?? "—"],
              ["Sequence", current.sequence ?? "—"],
              ["Sent", formatDate(current.sentAt)],
              ["Visible", formatDate(current.visibleAt)],
              ["Expires", formatDate(current.expiresAt)],
              ["Failed in", current.deadLetteredFrom ?? "—"],
            ]}
          />
          <h3 className="mt-5 font-medium">Attributes</h3>
          <CodeBlock code={JSON.stringify(current.attributes, null, 2)} lang="json" />
          {current.deadLetteredFrom && (
            <p className="mt-3 text-muted-foreground">No worker error is stored with a message. Check the consumer's logs before redriving.</p>
          )}
        </>
      )}
    </Inspector>
  );
}
function Messages({
  project,
  queue,
  version,
  onChange,
  onSendAgain,
  sentId,
  selected,
  onSelected,
}: {
  project: string;
  queue: Queue;
  version: number;
  onChange: () => void;
  onSendAgain: (draft: SendDraft) => void;
  sentId?: string;
  selected: string[];
  onSelected: (ids: string[]) => void;
}) {
  const filters = useMessageFilters();
  const options = {
    after: filters.after || undefined,
    state: filters.state || undefined,
    group: filters.group || undefined,
    id: filters.id || undefined,
  };
  const messages = useLoad(`queue-messages:${project}:${queue.name}:${JSON.stringify(options)}`, () => api.queueMessages(project, queue.name, options), {
    interval: 15_000,
  });
  const [inspecting, setInspecting] = useState<QueueMessageRecord | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [cursors, setCursors] = useState<string[]>([]);
  const rows = messages.state.status === "ready" ? messages.state.data.slice(0, 50) : [];
  useEffect(() => {
    onSelected([]);
  }, [filters.state, filters.group, filters.id, filters.after]);
  const changeFilter = (key: string, value: string) => {
    setCursors([]);
    filters.set(key, value);
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Message state" value={filters.state} onChange={(e) => changeFilter("state", e.target.value)}>
          <option value="">All states</option>
          {Object.entries(STATE_LABELS).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Exact group ID"
          placeholder="Group ID (exact)"
          className="sm:max-w-48"
          value={filters.group}
          onChange={(e) => changeFilter("group", e.target.value)}
        />
        <Input
          aria-label="Exact message ID"
          placeholder="Message ID (exact)"
          className="sm:max-w-64"
          value={filters.id}
          onChange={(e) => changeFilter("id", e.target.value)}
        />
        {(filters.state || filters.group || filters.id) && (
          <Button
            variant="ghost"
            onClick={() => {
              const hash = window.location.hash;
              const params = new URLSearchParams(hash.split("?")[1]);
              ["state", "group", "id", "after"].forEach((k) => params.delete(k));
              window.location.hash = `${hash.split("?")[0]}?${params}`;
              setCursors([]);
            }}
          >
            Clear filters
          </Button>
        )}
        <LiveIndicator load={messages} />
      </div>
      <p className="mb-3 text-muted-foreground">
        Oldest first. Looking does not receive messages or change visibility.{" "}
        {sentId && "The new message is highlighted; a consumer may already have received it."}
      </p>
      {messages.state.status === "loading" && <LoadingLines label="Loading messages" />}
      {messages.state.status === "error" && <LoadError what="messages" message={messages.state.message} onRetry={messages.refresh} />}
      {messages.state.status === "ready" && rows.length === 0 && <p>No messages match. They may have been consumed or expired.</p>}
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead>Body</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow
                key={m.messageId}
                className={cn("align-top", m.messageId === sentId && "bg-selected animate-arrive", selected.includes(m.messageId) && "bg-selected")}
              >
                <TableCell>
                  <Checkbox
                    aria-label={`Select message ${m.messageId}`}
                    checked={selected.includes(m.messageId)}
                    onCheckedChange={(checked) => onSelected(checked ? [...selected, m.messageId] : selected.filter((id) => id !== m.messageId))}
                  />
                </TableCell>
                <TableCell className="w-full min-w-40 max-w-0">
                  <div className="flex items-start gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${expanded.includes(m.messageId) ? "Collapse" : "Expand"} body`}
                      aria-expanded={expanded.includes(m.messageId)}
                      onClick={() => setExpanded((old) => (old.includes(m.messageId) ? old.filter((id) => id !== m.messageId) : [...old, m.messageId]))}
                    >
                      <ChevronRight />
                    </Button>
                    <div className="min-w-0 flex-1">
                      {expanded.includes(m.messageId) ? (
                        <CodeBlock code={pretty(m.body)} copyText={m.body} title={m.truncated ? "Body preview (truncated)" : "Body"} />
                      ) : (
                        <pre className="select-text truncate font-mono text-[13px]">{m.body}</pre>
                      )}
                      {m.truncated && <p className="text-muted-foreground">Preview truncated · Inspect for full body</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone="outline">{STATE_LABELS[m.state]}</Badge>
                    <Badge tone="outline">{m.receiveCount} receives</Badge>
                  </div>
                  {m.state !== "visible" && <Countdown iso={m.visibleAt} expired="Available now" />}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <TimeAgo iso={m.sentAt} />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setInspecting(m)}>
                      Inspect
                    </Button>
                    <InlineDelete
                      label={`Delete message ${m.messageId}`}
                      onDelete={async () => {
                        await api.deleteQueueMessage(project, queue.name, m.messageId);
                        onChange();
                      }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          disabled={!filters.after}
          onClick={() => {
            const previous = cursors.at(-1) ?? "";
            setCursors((old) => old.slice(0, -1));
            filters.set("after", previous);
          }}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={messages.state.status !== "ready" || messages.state.data.length <= 50}
          onClick={() => {
            setCursors((old) => [...old, filters.after]);
            filters.set("after", rows.at(-1)!.cursor);
          }}
        >
          Next
        </Button>
        <span aria-live="polite">{rows.length} loaded</span>
      </div>
      {inspecting && (
        <MessageInspector
          project={project}
          queue={queue}
          message={inspecting}
          onClose={() => setInspecting(null)}
          onSendAgain={(draft) => {
            setInspecting(null);
            onSendAgain(draft);
          }}
        />
      )}
    </>
  );
}

function QueueDetail({ project, name }: { project: string; name: string }) {
  const view = useServiceView();
  const [version, setVersion] = useState(0);
  const bump = () => {
    invalidateQueue(project);
    setVersion((v) => v + 1);
  };
  const queue = useLoad(`queue:${project}:${name}`, () => api.queue(project, name), {
    interval: view === "settings" ? undefined : 15_000,
  });
  const filters = useMessageFilters();
  const [sentId, setSentId] = useState<string>();
  const [sendDraft, setSendDraft] = useState<SendDraft>();
  const [selected, setSelected] = useState<string[]>([]);
  const [redriveSelected, setRedriveSelected] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [redriveResult, setRedriveResult] = useState<string>();
  const all = useLoad(`queues:${project}`, () => api.queues(project));
  const [dialog, setDialog] = useState<"send" | "edit" | "purge" | "delete" | "redrive" | null>(null);
  const breadcrumb = [
    { label: project, href: href({ page: "project", name: project }) },
    {
      label: "Queues",
      href: href({ page: "queue", name: project, queue: null }),
    },
  ];

  if (queue.state.status !== "ready") {
    return (
      <>
        <PageHeader mono title={name} breadcrumb={breadcrumb} />
        {queue.state.status === "loading" ? (
          <LoadingLines label="Loading queue" />
        ) : (
          <LoadError what="the queue" message={queue.state.message} onRetry={queue.refresh} />
        )}
      </>
    );
  }
  const q = queue.state.data;
  const editable = q.source !== "code";

  async function purge() {
    await api.purgeQueue(project, name);
    toast.success(`Purged ${name}`);
    bump();
  }
  async function remove() {
    if (typedName !== name) throw new Error(`Type ${name} to delete this queue.`);
    await api.deleteQueue(project, name);
    toast.success(`Deleted ${name}`);
    navigate({ page: "queue", name: project, queue: null });
  }
  async function redrive() {
    const { moved } = await api.redriveQueue(project, name, undefined, redriveSelected ? selected : undefined);
    setRedriveResult(`Redrove ${plural(moved, "message", "messages")}. In-flight, expired or missing-source messages stay in place.`);
    setSelected([]);
    bump();
  }

  return (
    <>
      <PageHeader
        mono
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

      <ServiceViews route={{ page: "queue", name: project, queue: name }} view={view} label="Queue" main="Messages" />
      {view !== "settings" && (
        <>
          <dl className="mb-6 flex flex-wrap divide-x">
            {(
              [
                ["Visible", q.counts.visible],
                ["In flight", q.counts.inFlight],
                ["Delayed", q.counts.delayed],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="px-5 first:pl-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>
                  <button
                    className="mt-1 metric rounded focus-visible:ring-2 focus-visible:ring-ring"
                    aria-pressed={
                      filters.state ===
                      {
                        Visible: "visible",
                        "In flight": "inFlight",
                        Delayed: "delayed",
                      }[label]
                    }
                    onClick={() =>
                      filters.set(
                        "state",
                        {
                          Visible: "visible",
                          "In flight": "inFlight",
                          Delayed: "delayed",
                        }[label],
                      )
                    }
                  >
                    {formatCount(n)}
                  </button>
                </dd>
              </div>
            ))}
          </dl>

          <QueueMiniChart project={project} name={name} />
          <section aria-labelledby="messages" className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="messages" className="text-base font-semibold">
                Messages
              </h2>
              <div className="flex gap-2">
                {q.deadLetterFor.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setDialog("redrive")}>
                    <Undo2 />
                    Redrive dead letters…
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={bump}>
                  <RefreshCw />
                  Refresh
                </Button>
              </div>
            </div>
            {redriveResult && (
              <p role="status" className="mb-3">
                {redriveResult}
              </p>
            )}
            <Messages
              project={project}
              queue={q}
              version={version}
              onChange={bump}
              selected={selected}
              onSelected={setSelected}
              sentId={sentId}
              onSendAgain={(draft) => {
                setSendDraft(draft);
                setDialog("send");
              }}
            />
          </section>

          <ActivityDisclosure project={project} queue={name} version={version} />
        </>
      )}
      {view === "settings" && (
        <>
          <section aria-labelledby="settings" className="mb-8">
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
                  <a
                    href={href({
                      page: "queue",
                      name: project,
                      queue: q.deadLetter.queue,
                    })}
                    className="font-mono text-xs underline-offset-4 hover:underline"
                  >
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
            <h2 id="danger" className="mb-2 text-base font-semibold">
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
                <p className="max-w-prose text-muted-foreground">
                  Deletes the queue and its messages. Queues using it as their dead-letter queue lose that setting.
                </p>
                <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
                  Delete queue
                </Button>
              </div>
            )}
          </section>
        </>
      )}
      {dialog === "send" && (
        <SendDialog
          project={project}
          queue={q}
          initial={sendDraft}
          open
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
              setSendDraft(undefined);
            }
          }}
          onSent={(id) => {
            setSentId(id);
            if (id) filters.set("id", id);
            bump();
          }}
        />
      )}
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
        description={`Deletes ${q.counts.visible + q.counts.inFlight + q.counts.delayed} messages and the queue. ${q.deadLetterFor.length} source queues lose their dead-letter target. Apps still using it get 404s.`}
        confirm="Delete queue"
        pendingLabel="Deleting…"
        onConfirm={remove}
      >
        <Label htmlFor="delete-queue-name">Type {name}</Label>
        <Input id="delete-queue-name" value={typedName} onChange={(e) => setTypedName(e.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "redrive"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Redrive dead letters from ${name}`}
        description={`Each message goes back to the queue it failed in (${q.deadLetterFor.join(", ")}) with its receive count reset. Fix whatever made them fail first.`}
        confirm="Redrive dead letters"
        pendingLabel="Moving…"
        onConfirm={redrive}
        destructive={false}
      >
        <p>
          {q.counts.visible + q.counts.delayed} eligible messages; {q.counts.inFlight} in flight stay. Inspect a message and fix the consumer first.{" "}
        </p>
        {all.state.status === "ready" && (
          <ul>
            {all.state.data
              .filter((source) => q.deadLetterFor.includes(source.name))
              .map((source) => (
                <li key={source.name}>
                  {source.name}: {source.counts.visible + source.counts.inFlight + source.counts.delayed} currently in source queue
                </li>
              ))}
          </ul>
        )}
        <label className="flex items-center gap-2">
          <Checkbox checked={redriveSelected} onCheckedChange={(value) => setRedriveSelected(value === true)} disabled={selected.length === 0} />
          Selected messages only ({selected.length})
        </label>
      </ConfirmDialog>
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

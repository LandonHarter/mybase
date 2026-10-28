// `mybase queue …`: SQS-style queues apps use with @mybase-dev/sdk/queue.
import type {
  Queue,
  QueueMessageRecord,
  QueueServiceSettings,
  QueueStats,
  ReceiveMessagesResponse,
  RedriveResponse,
  SendMessagesResponse,
  SyncQueuesRequest,
  SyncQueuesResponse,
} from "@mybase/shared";
import { QUEUE_STATS_RANGES, type QueueStatsRange } from "@mybase/shared";
import { api } from "./api";
import { confirm, print } from "./output";
import { enableService, printLinked } from "./service-enable";
import { flagInt, flagString, need, parseArgs, printSync, readConfigFile } from "./cron";

export const queueUsage = `  queue enable <project>         Turn on queues
  queue disable <project> [--yes]  Turn them off, deleting every queue and message
  queue list <project>           List queues with message counts
  queue create <project> <name> [--fifo] [--visibility 30s] [--delay 0s] [--retention 4d]
         [--wait 0s] [--max-bytes <n>] [--content-dedup] [--dlq <queue> --max-receives <n>]
  queue delete <project> <name> [--yes]  Delete a queue and its messages
  queue purge <project> <name> [--yes]   Delete every message in a queue
  queue send <project> <name> <body> [--group <id>] [--dedup <id>] [--delay 30s]
  queue peek <project> <name> [--limit 20]  Show messages without receiving them
  queue receive <project> <name> [--max 1] [--wait 0s] [--delete]  Receive (and optionally delete)
  queue redrive <project> <dlq> [--to <queue>]  Move dead letters back to their queues
  queue stats <project> [--range 24h|7d]  Sent, received, deleted, dead-lettered per queue
  queue sync [--config <file>] [--dry-run] [--yes]  Make code-defined queues match mybase.config.ts`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/queue`;
const queuePath = (project: string, name: string, rest = "") => `${base(project)}/queues/${encodeURIComponent(name)}${rest}`;

/** 30000 → `30s`, 345600000 → `4d`. */
function formatMs(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

function printUsage(project: string, settings: QueueServiceSettings) {
  console.log(`  base URL  ${settings.baseUrl}\n`);
  console.log("In your app (@mybase-dev/sdk), with an API key that has queue:write for this project:");
  console.log(`  mybase token create ${project}-app --project ${project} --perm queue:write\n`);
  console.log(`  const queue = createQueueClient({ apiUrl: "${settings.apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! })`);
  console.log(`  await queue.send("<queue>", { hello: "world" })`);
}

/** Handles `mybase queue <sub> …`. False when `sub` isn't a queue command. */
export async function queue(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, name, third] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "queue", flags);
      const settings = await api<QueueServiceSettings>(base(p));
      print({ enabled: "queue", project: p, linked, ...settings }, () => {
        console.log(`Queues enabled for "${p}"\n`);
        printUsage(p, settings);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This deletes every queue and message of "${p}".`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/queue`, { method: "DELETE" });
      print({ disabled: "queue", project: p }, () => console.log(`Queues disabled for "${p}"`));
      return true;
    }
    case "list": {
      const p = need(project, "project name");
      const queues = await api<Queue[]>(`${base(p)}/queues`);
      print(queues, () => {
        if (queues.length === 0) console.log("No queues yet.");
        for (const q of queues) {
          const { visible, inFlight, delayed } = q.counts;
          const dlq = q.deadLetter ? `dlq ${q.deadLetter.queue} after ${q.deadLetter.maxReceives}` : "";
          console.log([q.name, q.fifo ? "fifo" : "standard", `${visible} visible, ${inFlight} in flight, ${delayed} delayed`, dlq, q.source].filter(Boolean).join("\t"));
        }
      });
      return true;
    }
    case "create": {
      const p = need(project, "project name");
      const dlq = flagString(flags, "dlq");
      const body = {
        name: need(name, "queue name"),
        fifo: flags.has("fifo") || undefined,
        visibilityTimeout: flagString(flags, "visibility"),
        delay: flagString(flags, "delay"),
        retention: flagString(flags, "retention"),
        receiveWait: flagString(flags, "wait"),
        maxMessageBytes: flagInt(flags, "max-bytes"),
        contentDedup: flags.has("content-dedup") || undefined,
        deadLetter: dlq ? { queue: dlq, maxReceives: flagInt(flags, "max-receives") ?? 5 } : undefined,
      };
      const q = await api<Queue>(`${base(p)}/queues`, { method: "POST", body: JSON.stringify(body) });
      print(q, () => console.log(`Created ${q.fifo ? "FIFO" : "standard"} queue "${q.name}" (visibility ${formatMs(q.visibilityTimeoutMs)}, retention ${formatMs(q.retentionMs)})`));
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const n = need(name, "queue name");
      confirm(flags.has("yes"), `This deletes queue "${n}" and every message in it.`, n, "the queue name");
      await api(queuePath(p, n), { method: "DELETE" });
      print({ deleted: n }, () => console.log(`Deleted queue "${n}"`));
      return true;
    }
    case "purge": {
      const p = need(project, "project name");
      const n = need(name, "queue name");
      confirm(flags.has("yes"), `This deletes every message in "${n}".`, n, "the queue name");
      await api(queuePath(p, n, "/purge"), { method: "POST" });
      print({ purged: n }, () => console.log(`Purged "${n}"`));
      return true;
    }
    case "send": {
      const p = need(project, "project name");
      const n = need(name, "queue name");
      const delay = flagString(flags, "delay");
      const message = {
        body: need(third, "message body"),
        groupId: flagString(flags, "group"),
        dedupId: flagString(flags, "dedup"),
        delayMs: delay === undefined ? undefined : parseDuration(delay),
      };
      const res = await api<SendMessagesResponse>(queuePath(p, n, "/messages"), { method: "POST", body: JSON.stringify({ messages: [message] }) });
      if (res.failed[0]) throw new Error(res.failed[0].error);
      const sent = res.successful[0]!;
      print(sent, () => console.log(`${sent.duplicate ? "Duplicate of" : "Sent"} ${sent.messageId}${sent.sequence ? ` (sequence ${sent.sequence})` : ""}`));
      return true;
    }
    case "peek": {
      const p = need(project, "project name");
      const n = need(name, "queue name");
      const messages = await api<QueueMessageRecord[]>(`${queuePath(p, n, "/messages")}?limit=${flagInt(flags, "limit") ?? 20}`);
      print(messages, () => {
        if (messages.length === 0) console.log("Empty.");
        for (const m of messages) {
          const meta = [m.state, m.groupId && `group ${m.groupId}`, m.receiveCount > 0 && `received ${m.receiveCount}x`, m.deadLetteredFrom && `from ${m.deadLetteredFrom}`];
          console.log(`${m.messageId}  ${meta.filter(Boolean).join(", ")}\n  ${m.body.slice(0, 200)}${m.truncated || m.body.length > 200 ? "…" : ""}`);
        }
      });
      return true;
    }
    case "receive": {
      const p = need(project, "project name");
      const n = need(name, "queue name");
      const wait = flagString(flags, "wait");
      const body = { max: flagInt(flags, "max") ?? 1, waitMs: wait === undefined ? undefined : parseDuration(wait) };
      const { messages } = await api<ReceiveMessagesResponse>(queuePath(p, n, "/receive"), { method: "POST", body: JSON.stringify(body) });
      const deleted = flags.has("delete") && messages.length > 0;
      if (deleted) await api(queuePath(p, n, "/delete"), { method: "POST", body: JSON.stringify({ receipts: messages.map((m) => m.receipt) }) });
      print({ messages, deleted }, () => {
        if (messages.length === 0) console.log("No messages.");
        for (const m of messages) console.log(`${m.messageId}  received ${m.receiveCount}x\n  ${m.body}\n  receipt ${m.receipt}`);
        if (deleted) console.log(`Deleted ${messages.length}.`);
      });
      return true;
    }
    case "redrive": {
      const p = need(project, "project name");
      const n = need(name, "dead-letter queue name");
      const { moved } = await api<RedriveResponse>(queuePath(p, n, "/redrive"), { method: "POST", body: JSON.stringify({ to: flagString(flags, "to") }) });
      print({ moved }, () => console.log(`Moved ${moved} message${moved === 1 ? "" : "s"}`));
      return true;
    }
    case "stats": {
      const p = need(project, "project name");
      const range = (flagString(flags, "range") ?? "24h") as QueueStatsRange;
      if (!QUEUE_STATS_RANGES.includes(range)) throw new Error(`--range must be one of ${QUEUE_STATS_RANGES.join(", ")}`);
      const stats = await api<QueueStats>(`${base(p)}/stats?range=${range}`);
      print(stats, () => {
        const { queues } = stats;
        console.log(`Last ${range}:`);
        if (queues.length === 0) console.log("  (no queues)");
        const width = Math.max(...queues.map((q) => q.queue.length), 5);
        for (const q of queues) console.log(`  ${q.queue.padEnd(width)}  ${q.sent} sent, ${q.received} received, ${q.deleted} deleted, ${q.dead} dead-lettered`);
      });
      return true;
    }
    case "sync": {
      await sync(flagString(flags, "config") ?? "mybase.config.ts", flags.has("dry-run"), flags.has("yes"));
      return true;
    }
  }
  return false;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid duration "${value}": use ms or e.g. 30s, 5m`);
  return Math.round(Number(m[1]) * UNITS[m[2] ?? "ms"]!);
}

async function sync(file: string, dryRun: boolean, yes: boolean) {
  const config = await readConfigFile(file);
  const queues = Object.entries(config.queue?.queues ?? {}).map(([name, q]) => ({ ...q, name })) as SyncQueuesRequest["queues"];
  const path = `${base(config.project)}/queues`;
  // Deleting a queue deletes its messages: show what would go and confirm first.
  const plan = await api<SyncQueuesResponse>(path, { method: "PUT", body: JSON.stringify({ queues, dryRun: true } satisfies SyncQueuesRequest) });
  if (dryRun) return printSync(config.project, true, plan);
  if (plan.deleted.length > 0) {
    confirm(yes, `This deletes ${plan.deleted.map((n) => `"${n}"`).join(", ")} and every message in ${plan.deleted.length === 1 ? "it" : "them"}.`, "yes");
  }
  printSync(config.project, false, await api<SyncQueuesResponse>(path, { method: "PUT", body: JSON.stringify({ queues } satisfies SyncQueuesRequest) }));
}

// Message queues through mybase, modeled on SQS: standard and FIFO queues, visibility
// timeouts, long polling, delays, batching, dead-letter queues. Messages live in the mybase
// server's Postgres, so they survive restarts.
//
//   const queue = createQueueClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   await queue.send("emails", { to: "a@example.com" });
//   queue.consume("emails", async (message) => sendEmail(message.json()));
//
// Delivery is at least once: a message whose handler fails (or whose visibility timeout runs
// out) is delivered again. Make handlers safe to repeat.
import { MybaseApiError, parseDelay } from "./cron";

export { MybaseApiError };

/** Queue names: unique per project, safe in URLs. */
export const QUEUE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const QUEUE_NAME_RULES = "Use 1–80 lowercase letters, digits, `_`, or `-`, starting with a letter or digit.";

export const QUEUE_LIMITS = {
  /** Messages per send, receive, delete, or visibility batch. */
  batch: 100,
  /** All bodies and attributes of one send together. */
  batchBytes: 1024 * 1024,
  maxMessageBytes: { min: 1024, max: 256 * 1024, default: 256 * 1024 },
  visibilityTimeoutMs: { min: 0, max: 12 * 3_600_000, default: 30_000 },
  delayMs: { min: 0, max: 15 * 60_000, default: 0 },
  retentionMs: { min: 60_000, max: 14 * 86_400_000, default: 4 * 86_400_000 },
  /** Long polling: how long a receive waits for a message to arrive. */
  waitMs: { min: 0, max: 20_000, default: 0 },
  maxReceives: { min: 1, max: 1000 },
  attributes: 10,
  /** FIFO group and deduplication ids: printable ASCII. */
  idLength: 128,
  /** A FIFO send with a deduplication id seen this recently is accepted but not enqueued. */
  dedupWindowMs: 5 * 60_000,
  queuesPerProject: 1000,
} as const;

export type QueueAttributes = Record<string, string | number | boolean>;

/** Where a queue is defined: dashboard/CLI, mybase.config.ts (`mybase queue sync`), or app code. */
export type QueueSource = "dashboard" | "code" | "api";

export interface DeadLetterSettings {
  /** Another queue in the project, of the same kind (standard or FIFO). */
  queue: string;
  /** Receives after which a message moves there instead of being delivered again. */
  maxReceives: number;
}

/** A queue's settings, as the API returns them. */
export interface QueueSettings {
  /** FIFO: strict order within each message group, exactly-once enqueue (deduplication). Fixed at creation. */
  fifo: boolean;
  /** How long a received message stays hidden from other consumers. */
  visibilityTimeoutMs: number;
  /** How long new messages wait before they can be received. */
  delayMs: number;
  /** How long a message is kept before it's deleted unreceived. */
  retentionMs: number;
  maxMessageBytes: number;
  /** Default long-poll wait for receives that don't set one. */
  receiveWaitMs: number;
  /** FIFO only: deduplicate by a SHA-256 of the body when a send has no `dedupId`. */
  contentDedup: boolean;
  deadLetter: DeadLetterSettings | null;
}

export interface QueueCounts {
  /** Ready to receive. */
  visible: number;
  /** Received, not yet deleted, still within the visibility timeout. */
  inFlight: number;
  /** Waiting out a delay. */
  delayed: number;
}

export interface Queue extends QueueSettings {
  name: string;
  source: QueueSource;
  /** Approximate. */
  counts: QueueCounts;
  /** Sent time of the oldest message, or null when empty. */
  oldestMessageAt: string | null;
  /** Queues that send their dead letters here. */
  deadLetterFor: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Create or change a queue. Durations are ms or `"30s"`, `"5m"`, `"4d"`; `…Ms` fields take ms.
 * Absent fields keep their current value (or the default, on create).
 */
export interface QueueSettingsInput {
  fifo?: boolean;
  visibilityTimeout?: number | string;
  delay?: number | string;
  retention?: number | string;
  receiveWait?: number | string;
  maxMessageBytes?: number;
  contentDedup?: boolean;
  deadLetter?: DeadLetterSettings | null;
}

export interface CreateQueueRequest extends QueueSettingsInput {
  name: string;
}

/** One message in a send. */
export interface SendMessageEntry {
  /** Yours, echoed in the result to match entries up. Default: the entry's index. */
  id?: string;
  body: string;
  /** Standard queues only; FIFO queues use the queue's delay. */
  delayMs?: number;
  /** FIFO: required. Messages with the same group are delivered in order, one batch at a time. */
  groupId?: string;
  /** FIFO: a repeat within 5 minutes is accepted but not enqueued again. Required unless the queue has `contentDedup`. */
  dedupId?: string;
  attributes?: QueueAttributes;
}

export interface SendMessagesRequest {
  messages: SendMessageEntry[];
}

export interface SentMessage {
  id: string;
  messageId: string;
  /** FIFO: position in the queue, increasing. Null for standard queues. */
  sequence: string | null;
  /** FIFO: the dedup id was seen in the last 5 minutes; `messageId` is the original's. */
  duplicate: boolean;
}

export interface BatchFailure {
  /** The entry's `id`, or its receipt for deletes and visibility changes. */
  id: string;
  error: string;
}

export interface SendMessagesResponse {
  successful: SentMessage[];
  failed: BatchFailure[];
}

export interface ReceiveMessagesRequest {
  /** 1–100. Default 1. */
  max?: number;
  /** Long polling: wait up to this long (0–20000 ms) for a message. Default: the queue's `receiveWaitMs`. */
  waitMs?: number;
  /** Overrides the queue's visibility timeout for these messages. */
  visibilityTimeoutMs?: number;
}

/** A received message. Delete it with `receipt` once handled, or it's delivered again. */
export interface QueueMessage {
  messageId: string;
  /** Proves this receive; changes on every delivery. Only the latest one works. */
  receipt: string;
  body: string;
  attributes: QueueAttributes;
  groupId: string | null;
  dedupId: string | null;
  sequence: string | null;
  /** Times this message has been received, this time included. */
  receiveCount: number;
  sentAt: string;
  firstReceivedAt: string;
}

export interface ReceiveMessagesResponse {
  messages: QueueMessage[];
}

export interface DeleteMessagesRequest {
  receipts: string[];
}

export interface VisibilityEntry {
  receipt: string;
  visibilityTimeoutMs: number;
}

export interface ChangeVisibilityRequest {
  entries: VisibilityEntry[];
}

/** Deletes and visibility changes: how many applied, and which receipts didn't (stale, or the message is gone). */
export interface BatchResult {
  done: number;
  failed: BatchFailure[];
}

/** Moves a dead-letter queue's messages back. Without `to`, each goes back to the queue it came from. */
export interface RedriveRequest {
  to?: string;
}

export interface RedriveResponse {
  moved: number;
}

// ---- client -----------------------------------------------------------------

export interface QueueClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `queue:write` for this project (`queue:read` is enough to list and get queues). Server-side only. */
  apiKey: string;
  /** How long to wait for mybase on calls other than long polls, in ms. Default 10000. */
  timeoutMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface SendOptions {
  /** Standard queues: hide the message this long first (ms or `"30s"`, up to 15 minutes). */
  delay?: number | string;
  groupId?: string;
  dedupId?: string;
  attributes?: QueueAttributes;
}

export interface SendBatchEntry extends SendOptions {
  id?: string;
  /** Strings are sent as is; anything else as JSON. */
  body: unknown;
}

export interface ReceiveOptions {
  max?: number;
  /** Long poll: ms or `"20s"`, up to 20 seconds. */
  wait?: number | string;
  visibilityTimeout?: number | string;
  signal?: AbortSignal;
}

/** A received message, with its body parsed on demand. */
export interface ReceivedMessage extends QueueMessage {
  /** `JSON.parse(body)`. */
  json<T = unknown>(): T;
}

export interface ConsumeOptions {
  /** Messages per receive, 1–100. Default 10. */
  batchSize?: number;
  /** Handlers running at once. Default `batchSize`. FIFO groups always run one message at a time, in order. */
  concurrency?: number;
  /** Long poll per receive. Default 20s. */
  wait?: number | string;
  /** Default: the queue's. Set it longer than your slowest handler. */
  visibilityTimeout?: number | string;
  /**
   * After a handler throws: make the message visible again after this long. Default: leave it
   * hidden until its visibility timeout runs out.
   */
  retryDelay?: number | string;
  /** Called when a handler throws or mybase can't be reached. Default `console.error`. */
  onError?: (error: unknown, message?: ReceivedMessage) => void;
  /** Stops the consumer, like `stop()`. */
  signal?: AbortSignal;
}

export interface Consumer {
  /** Stops receiving, waits for running handlers, and deletes what they finished. */
  stop(): Promise<void>;
  /** Settles when the consumer has stopped. */
  done: Promise<void>;
}

export interface QueueClient {
  send(queue: string, body: unknown, options?: SendOptions): Promise<SentMessage>;
  /** Up to 100 messages. Entries fail one by one: check `failed`. */
  sendBatch(queue: string, entries: SendBatchEntry[]): Promise<SendMessagesResponse>;
  receive(queue: string, options?: ReceiveOptions): Promise<ReceivedMessage[]>;
  /** Deletes received messages by receipt. Resolves to how many were deleted. */
  delete(queue: string, receipts: string | string[]): Promise<BatchResult>;
  /** Extends (or ends, with 0) the visibility timeout of a received message. */
  changeVisibility(queue: string, receipt: string, timeout: number | string): Promise<void>;
  changeVisibilityBatch(queue: string, entries: { receipt: string; timeout: number | string }[]): Promise<BatchResult>;
  /** Calls `handler` for each message, deleting it when the handler resolves. */
  consume(queue: string, handler: (message: ReceivedMessage) => unknown, options?: ConsumeOptions): Consumer;

  listQueues(): Promise<Queue[]>;
  getQueue(queue: string): Promise<Queue>;
  createQueue(queue: string, settings?: QueueSettingsInput): Promise<Queue>;
  updateQueue(queue: string, settings: QueueSettingsInput): Promise<Queue>;
  deleteQueue(queue: string): Promise<void>;
  /** Deletes every message in the queue. */
  purge(queue: string): Promise<void>;
  /** Moves a dead-letter queue's messages back to their source queues (or `to`). */
  redrive(queue: string, options?: RedriveRequest): Promise<RedriveResponse>;
}

/** Strings as is, everything else as JSON. */
export const encodeBody = (body: unknown): string => (typeof body === "string" ? body : JSON.stringify(body));

const ms = (value: number | string | undefined) => (value === undefined ? undefined : parseDelay(value));

function received(message: QueueMessage): ReceivedMessage {
  return { ...message, json: <T>() => JSON.parse(message.body) as T };
}

function toEntry(entry: SendBatchEntry, index: number): SendMessageEntry {
  return {
    id: entry.id ?? String(index),
    body: encodeBody(entry.body),
    delayMs: ms(entry.delay),
    groupId: entry.groupId,
    dedupId: entry.dedupId,
    attributes: entry.attributes,
  };
}

const sleep = (msToWait: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || msToWait <= 0) return resolve();
    const timer = setTimeout(done, msToWait);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

export function createQueueClient(options: QueueClientOptions): QueueClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/queue/${encodeURIComponent(options.project)}/queues`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const path = (queue: string, rest = "") => `${base}/${encodeURIComponent(queue)}${rest}`;

  async function call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await doFetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data as T;
  }

  const client: QueueClient = {
    async send(queue, body, opts = {}) {
      const result = await client.sendBatch(queue, [{ ...opts, body }]);
      const failure = result.failed[0];
      if (failure) throw new MybaseApiError(failure.error, 400);
      return result.successful[0]!;
    },
    sendBatch: (queue, entries) => call<SendMessagesResponse>("POST", path(queue, "/messages"), { messages: entries.map(toEntry) } satisfies SendMessagesRequest),
    async receive(queue, opts = {}) {
      const waitMs = ms(opts.wait);
      const body: ReceiveMessagesRequest = { max: opts.max, waitMs, visibilityTimeoutMs: ms(opts.visibilityTimeout) };
      // A long poll can take up to 20 s on the server: give it room before timing out.
      const timeout = AbortSignal.timeout((waitMs ?? QUEUE_LIMITS.waitMs.max) + timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const { messages } = await call<ReceiveMessagesResponse>("POST", path(queue, "/receive"), body, signal);
      return messages.map(received);
    },
    delete: (queue, receipts) => call<BatchResult>("POST", path(queue, "/delete"), { receipts: [receipts].flat() } satisfies DeleteMessagesRequest),
    async changeVisibility(queue, receipt, timeout) {
      const result = await client.changeVisibilityBatch(queue, [{ receipt, timeout }]);
      const failure = result.failed[0];
      if (failure) throw new MybaseApiError(failure.error, 400);
    },
    changeVisibilityBatch: (queue, entries) =>
      call<BatchResult>("POST", path(queue, "/visibility"), {
        entries: entries.map((e) => ({ receipt: e.receipt, visibilityTimeoutMs: parseDelay(e.timeout) })),
      } satisfies ChangeVisibilityRequest),
    consume: (queue, handler, opts) => consume(client, queue, handler, opts),

    listQueues: () => call<Queue[]>("GET", base),
    getQueue: (queue) => call<Queue>("GET", path(queue)),
    createQueue: (queue, settings = {}) => call<Queue>("POST", base, { ...settings, name: queue } satisfies CreateQueueRequest),
    updateQueue: (queue, settings) => call<Queue>("PATCH", path(queue), settings),
    deleteQueue: (queue) => call<void>("DELETE", path(queue)),
    purge: (queue) => call<void>("POST", path(queue, "/purge")),
    redrive: (queue, opts = {}) => call<RedriveResponse>("POST", path(queue, "/redrive"), opts),
  };
  return client;
}

function consume(client: QueueClient, queue: string, handler: (message: ReceivedMessage) => unknown, opts: ConsumeOptions = {}): Consumer {
  const batchSize = opts.batchSize ?? 10;
  const concurrency = Math.max(1, opts.concurrency ?? batchSize);
  const wait = opts.wait ?? QUEUE_LIMITS.waitMs.max;
  const retryDelay = ms(opts.retryDelay);
  const onError = opts.onError ?? ((err: unknown) => console.error("[mybase queue]", err));
  const stopper = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stopper.signal]) : stopper.signal;

  async function handle(message: ReceivedMessage): Promise<boolean> {
    try {
      await handler(message);
      return true;
    } catch (err) {
      onError(err, message);
      if (retryDelay !== undefined) await client.changeVisibility(queue, message.receipt, retryDelay).catch((e) => onError(e, message));
      return false;
    }
  }

  /** Runs one batch: groups in order (stopping a group at its first failure), the rest in parallel. */
  async function runBatch(messages: ReceivedMessage[]): Promise<string[]> {
    const lanes = new Map<string, ReceivedMessage[]>();
    for (const m of messages) {
      const lane = m.groupId === null ? `m:${m.messageId}` : `g:${m.groupId}`;
      lanes.set(lane, [...(lanes.get(lane) ?? []), m]);
    }
    const done: string[] = [];
    const queued = [...lanes.values()];
    const worker = async () => {
      for (let lane = queued.shift(); lane; lane = queued.shift()) {
        for (const m of lane) {
          if (!(await handle(m))) break;
          done.push(m.receipt);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queued.length) }, worker));
    return done;
  }

  const done = (async () => {
    let backoff = 1000;
    while (!signal.aborted) {
      let messages: ReceivedMessage[];
      const started = Date.now();
      try {
        messages = await client.receive(queue, { max: batchSize, wait, visibilityTimeout: opts.visibilityTimeout, signal });
        backoff = 1000;
        // An empty answer that came back at once (no long poll): don't spin.
        if (messages.length === 0) await sleep(1000 - (Date.now() - started), signal);
      } catch (err) {
        if (signal.aborted) break;
        onError(err);
        // 4xx (wrong key, no such queue) won't fix itself quickly either; back off the same way.
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      if (messages.length === 0) continue;
      const finished = await runBatch(messages);
      if (finished.length > 0) await client.delete(queue, finished).catch((err) => onError(err));
    }
  })();

  return {
    stop() {
      stopper.abort();
      return done;
    },
    done,
  };
}

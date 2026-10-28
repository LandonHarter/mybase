// Realtime webhooks: tells the app's (serverless) backend what browsers did, since it can't hold
// the sockets itself. Notify-only: messages are broadcast first and never wait on the app.
//
// Events are buffered per project and POSTed in batches (≤ 100, at most once a second) as
// `{ project, events }`, signed like cron calls (`X-Mybase-Signature`, the realtime secret).
// One call in flight per project, so the app sees events in order. Network errors, 429, and
// 5xx are retried after 10 s, 60 s, 5 min; then the batch is dropped. The buffer holds 10k
// events; past that the oldest go (counted as dropped). Nothing is written to disk.
import type { RealtimeWebhookEvent } from "@mybase-dev/sdk/realtime";
import { SIGNATURE_HEADER, signCronRequest } from "@mybase-dev/sdk/cron";
import { createLogger } from "@mybase/shared/logger";
import { outsideRequest } from "./audit";

const log = createLogger("realtime");

const FLUSH_MS = 1000;
const BATCH = 100;
const CAP = 10_000;
const RETRIES_MS = [10_000, 60_000, 5 * 60_000];
const TIMEOUT_MS = 10_000;

export interface WebhookTarget {
  url: string;
  secret: string;
}

interface Outbox {
  events: RealtimeWebhookEvent[];
  sending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  dropped: number;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Bumped by `dropWebhooks`, so a send in progress stops. */
  generation: number;
}

const outboxes = new Map<string, Outbox>();

let lookup: (project: string) => WebhookTarget | null = () => null;
let onResult: (project: string, ok: boolean, events: number) => void = () => {};

/** Wires in where to send (read at send time, so setting changes apply) and the stats hook. */
export function configureWebhooks(opts: { target: typeof lookup; result: typeof onResult }) {
  lookup = opts.target;
  onResult = opts.result;
}

function outbox(project: string): Outbox {
  let box = outboxes.get(project);
  if (!box) {
    box = { events: [], sending: false, timer: null, dropped: 0, lastError: null, lastErrorAt: null, generation: 0 };
    outboxes.set(project, box);
  }
  return box;
}

/** Queues an event; the caller has checked the project wants this event type. */
export function queueWebhook(project: string, event: RealtimeWebhookEvent) {
  const box = outbox(project);
  box.events.push(event);
  if (box.events.length > CAP) {
    const over = box.events.length - CAP;
    box.events.splice(0, over);
    box.dropped += over;
  }
  if (box.sending || box.timer) return;
  box.timer = setTimeout(
    () => {
      box.timer = null;
      outsideRequest(() => void drain(project));
    },
    box.events.length >= BATCH ? 0 : FLUSH_MS,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One POST. `retry` = worth trying again. */
async function post(project: string, target: WebhookTarget, events: RealtimeWebhookEvent[], timeoutMs = TIMEOUT_MS): Promise<{ ok: boolean; retry: boolean; error?: string }> {
  const body = JSON.stringify({ project, events });
  try {
    const res = await fetch(target.url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "User-Agent": "mybase-realtime", [SIGNATURE_HEADER]: await signCronRequest(target.secret, body) },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    if (res.ok) return { ok: true, retry: false };
    return { ok: false, retry: res.status === 429 || res.status >= 500, error: `answered ${res.status}` };
  } catch (err) {
    return { ok: false, retry: true, error: (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message };
  }
}

async function drain(project: string) {
  const box = outboxes.get(project);
  if (!box || box.sending) return;
  box.sending = true;
  const generation = box.generation;
  try {
    while (box.events.length && box.generation === generation) {
      const batch = box.events.slice(0, BATCH);
      let result: Awaited<ReturnType<typeof post>> = { ok: false, retry: false, error: "no webhook URL" };
      for (let attempt = 0; attempt <= RETRIES_MS.length; attempt++) {
        const target = lookup(project);
        if (!target) break;
        result = await post(project, target, batch);
        if (result.ok || !result.retry || attempt === RETRIES_MS.length) break;
        log.warn("realtime webhook failed, retrying", { project, events: batch.length, attempt: attempt + 1, error: result.error });
        await sleep(RETRIES_MS[attempt]!);
        if (box.generation !== generation) return;
      }
      if (box.generation !== generation) return;
      box.events.splice(0, batch.length);
      if (!lookup(project)) {
        box.events = [];
        break;
      }
      onResult(project, result.ok, batch.length);
      if (!result.ok) {
        box.lastError = result.error ?? "failed";
        box.lastErrorAt = new Date().toISOString();
        log.warn("realtime webhook gave up", { project, events: batch.length, error: result.error });
      }
    }
  } finally {
    if (box.generation === generation) box.sending = false;
  }
}

export function webhookStatus(project: string) {
  const box = outboxes.get(project);
  return { queued: box?.events.length ?? 0, dropped: box?.dropped ?? 0, lastError: box?.lastError ?? null, lastErrorAt: box?.lastErrorAt ?? null };
}

/** Forgets a project's queued events (service off, or webhook removed). */
export function dropWebhooks(project: string) {
  const box = outboxes.get(project);
  if (!box) return;
  if (box.timer) clearTimeout(box.timer);
  box.generation++;
  outboxes.delete(project);
}

/** On shutdown: one quick try for what's queued, no retries. */
export async function flushWebhooks() {
  await Promise.allSettled(
    [...outboxes].map(async ([project, box]) => {
      if (box.timer) clearTimeout(box.timer);
      const target = lookup(project);
      if (!target || box.sending) return;
      for (let i = 0; i < box.events.length; i += BATCH) await post(project, target, box.events.slice(i, i + BATCH), 3000);
    }),
  );
}

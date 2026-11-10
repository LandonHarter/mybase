// Sends queued email through SES. Same shape as the cron task runner (cron-tasks.ts): one timer
// sleeps until the next due message, claims use `for update skip locked`, a crash leaves rows in
// `sending` that boot puts back in the queue (so a message can go out twice after a crash, never zero
// times). Sends are paced at the account's max rate (1 recipient/s in the SES sandbox).
//
// One message, in order: load attachments (sizes checked again), check suppressions (an address
// may have bounced since it was queued), wait for a send slot, call SES. Only a failed SES call
// retries or fails the message. Once SES returned an id the message is sent: a failing DB write
// after that is retried (briefly, then on later ticks), never turned into a resend.
//
// Retries: throttling, AWS errors, network → 10 s, 60 s, 5 min, then `failed`. Daily quota or paused
// sending → the message waits 15 min without using an attempt.
// Never log addresses, subjects, bodies, or attachment names.
import { bucketName } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { AwsError, type SesAttachment } from "./email-aws";
import { attachmentsFit, attachmentsOverLimitMessage, bareEmail } from "./email-input";
import { countSent, maxSendRate, noteSesError, ses, sesConfigured } from "./email-ses";
import { sql as realSql } from "./postgres";
import { file as realFile } from "./storage";

const log = createLogger("email");

const BACKOFF_MS = [10_000, 60_000, 300_000];
const WAIT_QUOTA_MS = 15 * 60_000;
const MAX_SLEEP_MS = 3_600_000;
const MAX_IN_FLIGHT = 10;
/** After SES accepted a message: quick retries of the success write before it's left to later ticks. */
const RECORD_RETRY_MS = [1_000, 5_000];
const PENDING_RETRY_MS = 15_000;
/** How far a throttle reply pushes the next send back. */
const THROTTLE_PAUSE_MS = 1_000;

interface StoredObject {
  exists(): Promise<boolean>;
  stat(): Promise<{ size: number }>;
  slice(begin: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const defaults = {
  sql: realSql,
  file: realFile as (project: string, key: string) => StoredObject,
  now: () => Date.now(),
  sleep: (ms: number) => Bun.sleep(ms),
};
const deps = { ...defaults };

interface Claimed {
  id: string;
  project: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  attachments: { filename: string; contentType: string; size: number | null; storageKey: string | null }[];
  configurationSet: string;
  attempts: number;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let wakeAt: number | null = null;
let ticking = false;
let tickAgain = false;
let stopped = false;
const inFlight = new Set<string>();
let nextSlot = 0;
/** Accepted by SES, not yet recorded (DB down): id → SES message id. */
const unrecorded = new Map<string, { project: string; messageId: string }>();

function arm(at: number) {
  const t = Math.max(at, deps.now());
  if (wakeAt !== null && wakeAt <= t) return;
  if (timer) clearTimeout(timer);
  wakeAt = t;
  timer = setTimeout(() => void tick(), Math.min(t - deps.now(), MAX_SLEEP_MS));
}

/** Wakes the sender (a new message was queued for now, or one was due earlier than its timer). */
export function wakeSender(at: Date = new Date()) {
  if (!stopped && sesConfigured()) arm(at.getTime());
}

const recipientsOf = (row: Pick<Claimed, "to" | "cc" | "bcc">) => row.to.length + row.cc.length + row.bcc.length;

/**
 * Reserves send time for `recipients` at `rate` per second (SES counts recipients) and returns
 * how long to wait before sending.
 */
export function reserveSlot(recipients: number, rate: number, now = deps.now()): number {
  const at = Math.max(now, nextSlot);
  nextSlot = at + (Math.max(1, recipients) * 1000) / rate;
  return at - now;
}

async function slot(recipients: number) {
  const wait = reserveSlot(recipients, await maxSendRate());
  if (wait > 0) await deps.sleep(wait);
}

async function tick() {
  if (timer) clearTimeout(timer);
  timer = null;
  wakeAt = null;
  if (stopped) return;
  if (ticking) {
    tickAgain = true;
    return;
  }
  ticking = true;
  try {
    await recordUnrecorded();
    // One limit for claiming and for waking up: below 10/s the rate is the cap, so a backlog of
    // due messages doesn't make every tick re-query while all slots are busy.
    const limit = Math.min(MAX_IN_FLIGHT, await maxSendRate());
    do {
      tickAgain = false;
      const free = limit - inFlight.size;
      if (free > 0) {
        const claimed: Claimed[] = await deps.sql`
          update mybase.email_messages set status = 'sending', attempts = attempts + 1
          where id in (
            select id from mybase.email_messages where status = 'queued' and send_at <= now()
            order by send_at limit ${free} for update skip locked)
          returning id, project, from_address as "from", to_addresses as "to", cc_addresses as cc, bcc_addresses as bcc,
            reply_to as "replyTo", subject, html, text, attachments, configuration_set as "configurationSet", attempts`;
        for (const row of claimed) void run(row);
      }
    } while (tickAgain);
    // Saturated: a finishing send ticks again (run's finally), so no timer.
    if (inFlight.size < limit) {
      const [next]: { sendAt: Date }[] = await deps.sql`
        select send_at as "sendAt" from mybase.email_messages where status = 'queued' order by send_at limit 1`;
      arm(next ? Math.max(next.sendAt.getTime(), nextSlot) : deps.now() + MAX_SLEEP_MS);
    }
    if (unrecorded.size) arm(deps.now() + PENDING_RETRY_MS);
  } catch (err) {
    log.error("email sender tick failed", { err });
    arm(deps.now() + 30_000);
  } finally {
    ticking = false;
  }
}

class PermanentError extends Error {}

/** Base64 attachments from the DB, storage ones from the bucket (size checked before reading). */
async function attachmentsOf(row: Claimed): Promise<SesAttachment[]> {
  if (!row.attachments.length) return [];
  const stored: { position: number; content: Buffer }[] = await deps.sql`
    select position, content from mybase.email_attachment_data where message_id = ${row.id}`;
  const byPos = new Map(stored.map((s) => [s.position, s.content]));

  // Sizes first, all of them: an object that grew after queueing is refused before any read.
  const sizes: number[] = [];
  const objects = new Map<number, { f: StoredObject; size: number }>();
  for (const [i, a] of row.attachments.entries()) {
    const bytes = byPos.get(i);
    if (bytes) {
      sizes.push(bytes.length);
      continue;
    }
    if (!a.storageKey) throw new PermanentError(`attachment ${i + 1} is missing`);
    const f = deps.file(row.project, a.storageKey);
    if (!(await f.exists())) throw new PermanentError(`attachment ${i + 1}: the object isn't in bucket ${bucketName(row.project)} any more`);
    const { size } = await f.stat();
    sizes.push(size);
    objects.set(i, { f, size });
  }
  if (!attachmentsFit(sizes)) throw new PermanentError(attachmentsOverLimitMessage());

  // One at a time, never more than the stat'd size (+1 byte to notice growth).
  const out: SesAttachment[] = [];
  for (const [i, a] of row.attachments.entries()) {
    let bytes: Uint8Array | undefined = byPos.get(i);
    const obj = objects.get(i);
    if (obj) {
      bytes = new Uint8Array(await obj.f.slice(0, obj.size + 1).arrayBuffer());
      if (bytes.length > obj.size) throw new PermanentError(`attachment ${i + 1} changed while sending; send the email again`);
    }
    out.push({ FileName: a.filename, ContentType: a.contentType, RawContent: Buffer.from(bytes!).toString("base64") });
  }
  return out;
}

/** Daily quota reached or sending paused: wait, without using an attempt. */
export const isQuotaOrPaused = (err: unknown) =>
  err instanceof AwsError && (/SendingPaused|AccountSuspended/.test(err.code) || /daily message quota/i.test(err.message));

/** Per-second rate exceeded: a normal retry, and the next send waits a bit. */
export const isThrottle = (err: unknown) =>
  err instanceof AwsError && (err.status === 429 || /throttl|toomanyrequests/i.test(err.code) || /maximum sending rate/i.test(err.message));

async function run(row: Claimed) {
  inFlight.add(row.id);
  const mlog = log.child({ project: row.project, message: row.id.slice(0, 8) });
  const recipients = recipientsOf(row);
  try {
    let messageId: string;
    try {
      const attachments = await attachmentsOf(row);
      // Suppressions added after the message was queued (scheduled sends, retries) still count.
      const all = [...row.to, ...row.cc, ...row.bcc].map(bareEmail);
      const [hit]: { n: number }[] = await deps.sql`
        select count(*)::int as n from mybase.email_suppressions where project = ${row.project} and address in ${deps.sql(all)}`;
      if (hit && hit.n > 0) throw new PermanentError(`suppressed: ${hit.n} recipient(s) bounced or complained since this email was queued`);
      await slot(recipients);
      ({ messageId } = await ses().sendEmail({
        from: row.from,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        replyTo: row.replyTo,
        subject: row.subject,
        html: row.html ?? undefined,
        text: row.text ?? undefined,
        attachments,
        configurationSet: row.configurationSet,
        tags: { mybase_project: row.project, mybase_id: row.id },
      }));
    } catch (err) {
      await notSent(row, err, mlog);
      return;
    }
    countSent(recipients);
    await recordSent(row.id, row.project, messageId, mlog);
    mlog.info("email sent", { recipients, attempts: row.attempts });
  } catch (err) {
    mlog.error("email send not recorded", { err });
  } finally {
    inFlight.delete(row.id);
    void tick();
  }
}

/** The SES call (or what comes before it) failed: wait, retry, or fail the message. */
async function notSent(row: Claimed, err: unknown, mlog: Logger) {
  if (isQuotaOrPaused(err)) {
    noteSesError(`SES: ${(err as Error).message}`);
    await deps.sql`
      update mybase.email_messages set status = 'queued', attempts = attempts - 1, error = ${(err as Error).message},
        send_at = now() + ${`${WAIT_QUOTA_MS} milliseconds`}::interval
      where id = ${row.id} and status = 'sending'`;
    mlog.warn("email waiting: SES quota or sending paused", { code: (err as AwsError).code });
    return;
  }
  if (isThrottle(err)) nextSlot = Math.max(nextSlot, deps.now() + THROTTLE_PAUSE_MS);
  const permanent = err instanceof PermanentError;
  const retryable = !permanent && (!(err instanceof AwsError) || err.retryable || isThrottle(err));
  const message = (err as Error).message.slice(0, 1000);
  if (retryable && row.attempts <= BACKOFF_MS.length) {
    const delay = BACKOFF_MS[row.attempts - 1]!;
    await deps.sql`
      update mybase.email_messages set status = 'queued', error = ${message}, send_at = now() + ${`${delay} milliseconds`}::interval
      where id = ${row.id} and status = 'sending'`;
    mlog.warn("email send failed, retrying", { err, attempts: row.attempts, retryInMs: delay });
    return;
  }
  // Only from `sending`: an event (or a late success) may have moved it on already.
  const failed = await deps.sql.begin(async (tx) => {
    const [r] = await tx`update mybase.email_messages set status = 'failed', error = ${message} where id = ${row.id} and status = 'sending' returning id`;
    if (!r) return false;
    await tx`insert into mybase.email_events (message_id, type, at, detail) values (${row.id}, 'failed', now(), ${JSON.stringify({ error: message })}::text::jsonb)`;
    await tx`delete from mybase.email_attachment_data where message_id = ${row.id}`;
    return true;
  });
  if (failed) mlog.warn("email failed", { code: err instanceof AwsError ? err.code : undefined, permanent, attempts: row.attempts });
}

async function writeSent(id: string, messageId: string) {
  // `case`: an event (SEND) may already have moved it on.
  await deps.sql`
    update mybase.email_messages set status = case when status = 'sending' then 'sent' else status end,
      ses_message_id = ${messageId}, sent_at = coalesce(sent_at, now()), error = null
    where id = ${id}`;
}

/** SES has the message: record it, retrying a little; never requeue. */
async function recordSent(id: string, project: string, messageId: string, mlog: Logger) {
  for (let i = 0; ; i++) {
    try {
      await writeSent(id, messageId);
      break;
    } catch (err) {
      if (i >= RECORD_RETRY_MS.length) {
        unrecorded.set(id, { project, messageId });
        mlog.error("email sent but not recorded yet; retrying", { err });
        return;
      }
      await deps.sleep(RECORD_RETRY_MS[i]!);
    }
  }
  await deps.sql`delete from mybase.email_attachment_data where message_id = ${id}`.catch((err: unknown) =>
    mlog.warn("email attachment cleanup failed", { err }),
  );
}

async function recordUnrecorded() {
  for (const [id, { project, messageId }] of unrecorded) {
    try {
      await writeSent(id, messageId);
      unrecorded.delete(id);
      await deps.sql`delete from mybase.email_attachment_data where message_id = ${id}`.catch(() => {});
      log.info("email send recorded", { project, message: id.slice(0, 8) });
    } catch {
      return; // DB still down; next tick.
    }
  }
}

/** Puts messages a previous process left mid-send back in the queue, then starts sending. Call once at boot. */
export async function startSender() {
  stopped = false;
  // Sent but not recorded as sent: SES has it.
  await deps.sql`update mybase.email_messages set status = 'sent' where status = 'sending' and ses_message_id is not null`;
  // Accepted by SES in this process but not written yet: not a resend candidate.
  const keep = [...unrecorded.keys()];
  const requeued = keep.length
    ? await deps.sql`update mybase.email_messages set status = 'queued' where status = 'sending' and ses_message_id is null and id not in ${deps.sql(keep)}`
    : await deps.sql`update mybase.email_messages set status = 'queued' where status = 'sending' and ses_message_id is null`;
  if (requeued.count > 0) log.warn("emails interrupted by shutdown, sending again", { messages: requeued.count });
  await tick();
}

export function stopSender() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  wakeAt = null;
}

// ---- tests ------------------------------------------------------------------

/** For tests: swap the DB, storage, clock, or sleep. */
export function setSenderDepsForTests(d: Partial<typeof defaults>) {
  Object.assign(deps, d);
}

/** For tests: back to the real dependencies and an idle sender. */
export function resetSenderForTests() {
  stopSender();
  Object.assign(deps, defaults);
  inFlight.clear();
  unrecorded.clear();
  nextSlot = 0;
  ticking = false;
  tickAgain = false;
}

/** For tests: runs the sender's tick (the loop), with stop off. */
export async function tickForTests() {
  stopped = false;
  await tick();
}

/** For tests: claims one queued message by id and sends it now, waiting for the outcome. */
export async function sendNowForTests(id: string): Promise<void> {
  const claimed: Claimed[] = await deps.sql`
    update mybase.email_messages set status = 'sending', attempts = attempts + 1
    where id = ${id} and status = 'queued'
    returning id, project, from_address as "from", to_addresses as "to", cc_addresses as cc, bcc_addresses as bcc,
      reply_to as "replyTo", subject, html, text, attachments, configuration_set as "configurationSet", attempts`;
  if (!claimed[0]) throw new Error("not queued");
  stopped = true; // run's finally must not start the real loop
  await run(claimed[0]);
}

export const unrecordedForTests = () => new Map(unrecorded);

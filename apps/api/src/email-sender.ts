// Sends queued email through SES. Same shape as the cron task runner (cron-tasks.ts): one timer
// sleeps until the next due message, claims use `for update skip locked`, a crash leaves rows in
// `sending` that boot puts back in the queue (so a message can go out twice after a crash, never zero
// times). Sends are paced at the account's max rate (1/s in the SES sandbox).
//
// Retries: throttling, AWS errors, network → 10 s, 60 s, 5 min, then `failed`. Daily quota or paused
// sending → the message waits 15 min without using an attempt.
// Never log addresses, subjects, or bodies.
import { bucketName } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import { AwsError, type SesAttachment } from "./email-aws";
import { countSent, maxSendRate, noteSesError, ses, sesConfigured } from "./email-ses";
import { sql } from "./postgres";
import { file } from "./storage";

const log = createLogger("email");

const BACKOFF_MS = [10_000, 60_000, 300_000];
const WAIT_QUOTA_MS = 15 * 60_000;
const MAX_SLEEP_MS = 3_600_000;
const MAX_IN_FLIGHT = 10;

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

function arm(at: number) {
  const t = Math.max(at, Date.now());
  if (wakeAt !== null && wakeAt <= t) return;
  if (timer) clearTimeout(timer);
  wakeAt = t;
  timer = setTimeout(() => void tick(), Math.min(t - Date.now(), MAX_SLEEP_MS));
}

/** Wakes the sender (a new message was queued for now, or one was due earlier than its timer). */
export function wakeSender(at: Date = new Date()) {
  if (!stopped && sesConfigured()) arm(at.getTime());
}

/** Waits for the next send slot at the account's rate. */
async function slot() {
  const gap = 1000 / (await maxSendRate());
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await Bun.sleep(at - now);
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
    do {
      tickAgain = false;
      const free = Math.min(MAX_IN_FLIGHT, await maxSendRate()) - inFlight.size;
      if (free > 0) {
        const claimed: Claimed[] = await sql`
          update mybase.email_messages set status = 'sending', attempts = attempts + 1
          where id in (
            select id from mybase.email_messages where status = 'queued' and send_at <= now()
            order by send_at limit ${free} for update skip locked)
          returning id, project, from_address as "from", to_addresses as "to", cc_addresses as cc, bcc_addresses as bcc,
            reply_to as "replyTo", subject, html, text, attachments, configuration_set as "configurationSet", attempts`;
        for (const row of claimed) void run(row);
      }
    } while (tickAgain);
    if (inFlight.size < MAX_IN_FLIGHT) {
      const [next]: { sendAt: Date }[] = await sql`
        select send_at as "sendAt" from mybase.email_messages where status = 'queued' order by send_at limit 1`;
      arm(next ? next.sendAt.getTime() : Date.now() + MAX_SLEEP_MS);
    }
  } catch (err) {
    log.error("email sender tick failed", { err });
    arm(Date.now() + 30_000);
  } finally {
    ticking = false;
  }
}

async function attachmentsOf(row: Claimed): Promise<SesAttachment[]> {
  if (!row.attachments.length) return [];
  const stored: { position: number; content: Buffer }[] = await sql`
    select position, content from mybase.email_attachment_data where message_id = ${row.id}`;
  const byPos = new Map(stored.map((s) => [s.position, s.content]));
  return Promise.all(
    row.attachments.map(async (a, i) => {
      let bytes: Uint8Array | undefined = byPos.get(i);
      if (!bytes && a.storageKey) {
        const f = file(row.project, a.storageKey);
        if (!(await f.exists())) throw new PermanentError(`attachment ${a.filename}: ${a.storageKey} isn't in bucket ${bucketName(row.project)}`);
        bytes = new Uint8Array(await f.arrayBuffer());
      }
      if (!bytes) throw new PermanentError(`attachment ${a.filename} is missing`);
      return { FileName: a.filename, ContentType: a.contentType, RawContent: Buffer.from(bytes).toString("base64") };
    }),
  );
}

class PermanentError extends Error {}

const isQuotaOrPaused = (err: unknown) =>
  err instanceof AwsError && (/SendingPaused|AccountSuspended/.test(err.code) || /quota|maximum sending rate/i.test(err.message));

async function run(row: Claimed) {
  inFlight.add(row.id);
  const mlog = log.child({ project: row.project, message: row.id.slice(0, 8) });
  try {
    try {
      const attachments = await attachmentsOf(row);
      await slot();
      const { messageId } = await ses().sendEmail({
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
      });
      countSent();
      // `where status = 'sending'`: an event (SEND) may already have moved it on.
      await sql`
        update mybase.email_messages set status = case when status = 'sending' then 'sent' else status end,
          ses_message_id = ${messageId}, sent_at = now(), error = null
        where id = ${row.id}`;
      await sql`delete from mybase.email_attachment_data where message_id = ${row.id}`;
      mlog.info("email sent", { recipients: row.to.length + row.cc.length + row.bcc.length, attempts: row.attempts });
    } catch (err) {
      if (isQuotaOrPaused(err)) {
        noteSesError(`SES: ${(err as Error).message}`);
        await sql`
          update mybase.email_messages set status = 'queued', attempts = attempts - 1, error = ${(err as Error).message},
            send_at = now() + ${`${WAIT_QUOTA_MS} milliseconds`}::interval
          where id = ${row.id} and status = 'sending'`;
        mlog.warn("email waiting: SES quota or sending paused", { code: (err as AwsError).code });
        return;
      }
      const retryable = !(err instanceof PermanentError) && (!(err instanceof AwsError) || err.retryable);
      const message = (err as Error).message.slice(0, 1000);
      if (retryable && row.attempts <= BACKOFF_MS.length) {
        const delay = BACKOFF_MS[row.attempts - 1]!;
        await sql`
          update mybase.email_messages set status = 'queued', error = ${message}, send_at = now() + ${`${delay} milliseconds`}::interval
          where id = ${row.id} and status = 'sending'`;
        mlog.warn("email send failed, retrying", { err, attempts: row.attempts, retryInMs: delay });
        return;
      }
      await sql.begin(async (tx) => {
        await tx`update mybase.email_messages set status = 'failed', error = ${message} where id = ${row.id}`;
        await tx`insert into mybase.email_events (message_id, type, at, detail) values (${row.id}, 'failed', now(), ${JSON.stringify({ error: message })}::text::jsonb)`;
        await tx`delete from mybase.email_attachment_data where message_id = ${row.id}`;
      });
      mlog.warn("email failed", { code: err instanceof AwsError ? err.code : undefined, attempts: row.attempts });
    }
  } catch (err) {
    mlog.error("email send not recorded", { err });
  } finally {
    inFlight.delete(row.id);
    void tick();
  }
}

/** Puts messages a previous process left mid-send back in the queue, then starts sending. Call once at boot. */
export async function startSender() {
  stopped = false;
  // Sent but not recorded as sent: SES has it.
  await sql`update mybase.email_messages set status = 'sent' where status = 'sending' and ses_message_id is not null`;
  const requeued = await sql`update mybase.email_messages set status = 'queued' where status = 'sending' and ses_message_id is null`;
  if (requeued.count > 0) log.warn("emails interrupted by shutdown, sending again", { messages: requeued.count });
  await tick();
}

export function stopSender() {
  stopped = true;
  if (timer) clearTimeout(timer);
}

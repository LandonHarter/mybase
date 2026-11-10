// Delivery events for the email service. SES publishes them (configuration set → SNS topic →
// SQS queue, raw delivery); one loop here long-polls the queue, so no public URL is needed.
// Each event becomes an email_events row, may move the message's status forward, and hard
// bounces / complaints add the address to the project's suppression list.
//
// Never log addresses, subjects, or links: ids and counts only.
import type { EmailEventType, EmailStatus } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import { sql } from "./postgres";
import { ses } from "./email-ses";

const log = createLogger("email");

export interface MappedEvent {
  sesMessageId: string;
  /** Our id, from the `mybase_id` tag. */
  messageId: string | null;
  project: string | null;
  type: EmailEventType;
  at: string;
  detail: Record<string, unknown> | null;
  /** The status this event implies, if any. */
  status: EmailStatus | null;
  suppress: { address: string; reason: "bounce" | "complaint" }[];
}

const TYPES: Record<string, EmailEventType> = {
  send: "send",
  delivery: "delivery",
  deliverydelay: "delay",
  bounce: "bounce",
  complaint: "complaint",
  reject: "reject",
  open: "open",
  click: "click",
  renderingfailure: "rendering_failure",
};

/** Higher wins: an event never moves a message back (a late `delay` after `delivery`). */
const RANK: Partial<Record<EmailStatus, number>> = { sending: 0, sent: 1, delayed: 2, delivered: 3, bounced: 4, complained: 5, failed: 6 };

export const statusRank = (s: EmailStatus) => RANK[s] ?? -1;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const tag = (tags: Obj, name: string) => {
  const v = tags[name];
  return Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One SES event (raw SNS delivery body) → what to record. Null for anything we can't use. */
export function mapSesEvent(body: string): MappedEvent | null {
  let e: Obj;
  try {
    e = obj(JSON.parse(body));
  } catch {
    return null;
  }
  const kind = (str(e.eventType) ?? str(e.notificationType) ?? "").toLowerCase();
  const type = TYPES[kind];
  const mail = obj(e.mail);
  const sesMessageId = str(mail.messageId);
  if (!type || !sesMessageId) return null;
  const tags = obj(mail.tags);
  const messageId = tag(tags, "mybase_id");
  const section = obj(e[kind === "deliverydelay" ? "deliveryDelay" : kind === "renderingfailure" ? "failure" : kind]);
  const at = str(section.timestamp) ?? str(mail.timestamp) ?? new Date().toISOString();

  let detail: Obj | null = null;
  let status: EmailStatus | null = null;
  const suppress: MappedEvent["suppress"] = [];
  switch (type) {
    case "send":
      status = "sent";
      break;
    case "delivery":
      status = "delivered";
      detail = { recipients: section.recipients, smtpResponse: str(section.smtpResponse) };
      break;
    case "delay":
      status = "delayed";
      detail = { delayType: str(section.delayType), recipients: (section.delayedRecipients as Obj[] | undefined)?.map((r) => str(obj(r).emailAddress)) };
      break;
    case "bounce": {
      const permanent = str(section.bounceType) === "Permanent";
      const recipients = ((section.bouncedRecipients as unknown[]) ?? []).map(obj);
      detail = {
        bounceType: str(section.bounceType),
        bounceSubType: str(section.bounceSubType),
        recipients: recipients.map((r) => ({ address: str(r.emailAddress), diagnostic: str(r.diagnosticCode)?.slice(0, 500), status: str(r.status) })),
      };
      // Transient bounces (mailbox full, etc.) aren't final; SES keeps retrying.
      if (permanent) {
        status = "bounced";
        for (const r of recipients) {
          const address = str(r.emailAddress)?.toLowerCase();
          if (address) suppress.push({ address, reason: "bounce" });
        }
      }
      break;
    }
    case "complaint": {
      status = "complained";
      const recipients = ((section.complainedRecipients as unknown[]) ?? []).map(obj);
      detail = { feedbackType: str(section.complaintFeedbackType), recipients: recipients.map((r) => str(r.emailAddress)) };
      for (const r of recipients) {
        const address = str(r.emailAddress)?.toLowerCase();
        if (address) suppress.push({ address, reason: "complaint" });
      }
      break;
    }
    case "reject":
      status = "failed";
      detail = { reason: str(section.reason) };
      break;
    case "rendering_failure":
      status = "failed";
      detail = { error: str(section.errorMessage) };
      break;
    case "open":
      // No IP: it's the recipient's, and not needed for the log.
      detail = { userAgent: str(section.userAgent)?.slice(0, 300) };
      break;
    case "click":
      detail = { link: str(section.link)?.slice(0, 2000), userAgent: str(section.userAgent)?.slice(0, 300) };
      break;
  }
  return {
    sesMessageId,
    messageId: messageId && UUID.test(messageId) ? messageId : null,
    project: tag(tags, "mybase_project"),
    type,
    at,
    detail,
    status,
    suppress,
  };
}

/** Writes a batch of events in one transaction. Unknown messages (pruned, other systems) are skipped. */
export async function recordEvents(events: MappedEvent[]): Promise<number> {
  if (!events.length) return 0;
  let recorded = 0;
  await sql.begin(async (tx) => {
    for (const ev of events) {
      const [msg]: { id: string; project: string; status: EmailStatus }[] = ev.messageId
        ? await tx`select id, project, status from mybase.email_messages where id = ${ev.messageId} for update`
        : await tx`select id, project, status from mybase.email_messages where ses_message_id = ${ev.sesMessageId} for update`;
      if (!msg) continue;
      // Opens and clicks repeat (image proxies, re-reads): one per message + link per minute.
      if (ev.type === "open" || ev.type === "click") {
        const link = (ev.detail?.link as string | undefined) ?? null;
        const [dup] = await tx`
          select 1 from mybase.email_events
          where message_id = ${msg.id} and type = ${ev.type} and at > ${ev.at}::timestamptz - interval '1 minute'
            and coalesce(detail->>'link', '') = coalesce(${link}::text, '')
          limit 1`;
        if (dup) continue;
      }
      await tx`
        insert into mybase.email_events (message_id, type, at, detail)
        values (${msg.id}, ${ev.type}, ${ev.at}, ${ev.detail === null ? null : JSON.stringify(ev.detail)}::text::jsonb)`;
      if (ev.status && statusRank(ev.status) > statusRank(msg.status) && msg.status !== "canceled") {
        await tx`update mybase.email_messages set status = ${ev.status} where id = ${msg.id}`;
      }
      for (const s of ev.suppress) {
        await tx`
          insert into mybase.email_suppressions (project, address, reason) values (${msg.project}, ${s.address}, ${s.reason})
          on conflict do nothing`;
      }
      recorded++;
    }
  });
  return recorded;
}

let running = false;
let abort: AbortController | null = null;

/** Long-polls the events queue until `stopEvents`. */
export function startEventPoller(queueUrl: string) {
  if (running) return;
  running = true;
  void (async () => {
    let backoff = 0;
    while (running) {
      abort = new AbortController();
      try {
        const messages = await ses().receiveEvents(queueUrl, 20, abort.signal);
        const mapped = messages.map((m) => mapSesEvent(m.body)).filter((e): e is MappedEvent => e !== null);
        const recorded = await recordEvents(mapped);
        // Deleted after the write: a crash in between replays the batch (opens/clicks dedupe; the rest is idempotent enough).
        await ses().deleteEvents(queueUrl, messages);
        if (messages.length) log.debug("email events", { received: messages.length, recorded });
        backoff = 0;
      } catch (err) {
        if (!running) break;
        backoff = Math.min(backoff ? backoff * 2 : 5_000, 300_000);
        log.warn("email events poll failed", { err, retryInMs: backoff });
        await Bun.sleep(backoff);
      }
    }
  })();
}

export function stopEvents() {
  running = false;
  abort?.abort();
}

// Send email from your app through mybase (Amazon SES under the hood), from domains you verified
// for the project. Templates are React Email components, made in the dashboard or in your repo
// (`mybase email sync`), and sent by id with variables:
//
//   const email = createEmailClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
//   await email.send({ template: "welcome", to: "ann@example.com", variables: { name: "Ann" } });
//
// Or send content your app rendered itself (e.g. with @react-email/render, for loops/conditionals):
//
//   await email.send({ from: "Shop <hi@shop.com>", to, subject: "Your receipt", html, text });
//
// Sends are queued and go out at your SES account's rate; `send` answers with the message id.
// Server-side only: the API key can send email as your domains.
import { MybaseApiError } from "./cron";

export { MybaseApiError };

export const EMAIL_LIMITS = {
  /** To + cc + bcc, per message (SES's limit). */
  recipients: 50,
  subjectLength: 998,
  /** Rendered html or text, each, in characters. */
  bodyLength: 2_000_000,
  attachments: 10,
  /** Decoded bytes, all attachments together. */
  attachmentBytes: 10 * 1024 * 1024,
  /** The furthest ahead `sendAt` may be. */
  scheduleMs: 30 * 86_400_000,
  /** Template variables per send, and each value's length. */
  variables: 100,
  variableLength: 10_000,
  tags: 10,
  idempotencyKeyLength: 200,
  templateIdPattern: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  retentionDays: { min: 1, max: 365, default: 30 },
} as const;

export type EmailAddress = string;

export interface EmailAttachment {
  filename: string;
  /** Default: guessed from the file name. */
  contentType?: string;
  /** Base64. Or `storageKey`. */
  content?: string;
  /** A file in this project's storage bucket, read when the email is sent. */
  storageKey?: string;
}

interface SendCommon {
  /** `"name@domain"` or `"Name <name@domain>"`, on a domain verified for this project. Templates have a default. */
  from?: EmailAddress;
  to: EmailAddress | EmailAddress[];
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  replyTo?: EmailAddress | EmailAddress[];
  attachments?: EmailAttachment[];
  /** Send later (up to 30 days ahead). Cancel with `cancel(id)` until then. */
  sendAt?: Date | string;
  /** Same key within 24 hours → the first message's id, nothing sent twice. */
  idempotencyKey?: string;
  /** Your labels, shown in the dashboard's logs (≤ 10, short strings). */
  tags?: Record<string, string>;
}

export interface SendTemplateRequest extends SendCommon {
  /** Template id from the dashboard or `mybase email sync`. */
  template: string;
  /** Fills `{{name}}` placeholders. Every variable the template declares is required. */
  variables?: Record<string, string | number | boolean>;
}

export interface SendContentRequest extends SendCommon {
  from: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
}

export type SendEmailRequest = SendTemplateRequest | SendContentRequest;

export interface SendEmailResponse {
  id: string;
  status: EmailStatus;
  /** True when an earlier send with the same `idempotencyKey` answered. */
  duplicate?: boolean;
}

export const EMAIL_STATUSES = ["queued", "sending", "sent", "delivered", "delayed", "bounced", "complained", "failed", "canceled"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_EVENT_TYPES = ["send", "delivery", "delay", "bounce", "complaint", "reject", "open", "click", "rendering_failure", "failed", "canceled"] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export interface EmailEvent {
  type: EmailEventType;
  at: string;
  /** Bounce type and diagnostic, clicked link, user agent: whatever SES reported. */
  detail?: Record<string, unknown>;
}

/** A sent (or queued) message, without its body. */
export interface EmailMessageSummary {
  id: string;
  template: string | null;
  from: string;
  to: string[];
  subject: string;
  status: EmailStatus;
  error: string | null;
  tags: Record<string, string>;
  createdAt: string;
  sendAt: string;
  sentAt: string | null;
}

export interface EmailMessage extends EmailMessageSummary {
  cc: string[];
  bcc: string[];
  replyTo: string[];
  attachments: { filename: string; contentType: string; size: number | null }[];
  events: EmailEvent[];
}

// ---- client -----------------------------------------------------------------

export interface EmailClientOptions {
  /** Where the mybase API is reachable from your app, e.g. `https://mybase.example.com`. */
  apiUrl: string;
  project: string;
  /** A mybase API key (`mb_…`) with `email:write` for this project (`email:read` for `get`). Server-side only. */
  apiKey: string;
  /** Default 30000 (attachments can be large). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface EmailClient {
  send(request: SendEmailRequest): Promise<SendEmailResponse>;
  /** The message, its status and delivery events. */
  get(id: string): Promise<EmailMessage>;
  /** Cancels a queued or scheduled message. Throws 409 once it's being sent. */
  cancel(id: string): Promise<void>;
}

const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

export function createEmailClient(options: EmailClientOptions): EmailClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl.replace(/\/+$/, "")}/email/${encodeURIComponent(options.project)}`;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new MybaseApiError(data.error ?? `mybase API answered ${res.status}`, res.status);
    return data;
  }

  return {
    send(request) {
      const sendAt = request.sendAt instanceof Date ? request.sendAt.toISOString() : request.sendAt;
      return call<SendEmailResponse>("POST", "/send", {
        ...request,
        to: list(request.to),
        cc: list(request.cc),
        bcc: list(request.bcc),
        replyTo: list(request.replyTo),
        sendAt,
      });
    },
    get: (id) => call<EmailMessage>("GET", `/messages/${encodeURIComponent(id)}`),
    cancel: (id) => call<void>("DELETE", `/messages/${encodeURIComponent(id)}`),
  };
}

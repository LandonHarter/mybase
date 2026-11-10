// The email service: transactional email from a project's own domains, through the instance's
// Amazon SES account (MYBASE_SES_*, set by `mybase server email`).
//
// - Domains are verified per project (SES identity + DKIM; records added in Cloudflare with
//   MYBASE_DNS_TOKEN, else shown to add by hand). email-domains.ts.
// - Templates are React Email components rendered to HTML *before* they get here: by the
//   dashboard's sandboxed render frame or by `mybase email sync` on the developer's machine. The
//   server only stores HTML with `{{name}}` placeholders and fills them per send (email-input.ts);
//   template code never runs in the API.
// - Sends are queued rows (email_messages) sent by email-sender.ts; delivery events arrive through
//   SQS (email-events.ts). The rendered email is kept for the log until retention prunes it.
//
// Never log or audit recipients, subjects, bodies, variables, or attachment names.
import type {
  EmailDomain,
  EmailDnsRecord,
  EmailMessage,
  EmailMessageList,
  EmailMessageSummary,
  EmailSettings,
  EmailStatus,
  EmailSuppression,
  EmailTemplate,
  EmailTemplateSummary,
  EmailTemplateVariable,
  SendEmailResponse,
  SyncEmailTemplatesResponse,
} from "@mybase/shared";
import { cloudflare, DNS_TOKEN_PERMISSIONS, type Cloudflare } from "@mybase/shared/cloudflare";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { EMAIL_LIMITS, EMAIL_STATUSES } from "@mybase-dev/sdk/email";
import { audit } from "./audit";
import { configurationSetName, type SesIdentity } from "./email-aws";
import { addressDomain, applyDns, domainRecords, MAIL_FROM_LABEL, normalizeDomain, removeDns } from "./email-domains";
import { startEventPoller, stopEvents } from "./email-events";
import {
  bareEmail,
  fillTemplate,
  parseSend,
  parseSyncTemplates,
  parseTemplateParts,
  parseTemplateVariables,
  parseAddresses,
  parseVariables,
  type ParsedSend,
} from "./email-input";
import { startSender, stopSender, wakeSender } from "./email-sender";
import { NOT_SET_UP, serverStatus, ses, sesConfigured, sesRegion, setUpEvents, stopSes } from "./email-ses";
import { AwsError } from "./email-aws";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, UpstreamError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";

export { serverStatus };

const log = createLogger("email");

function dnsClient(): Cloudflare | null {
  const token = process.env.MYBASE_DNS_TOKEN?.trim();
  return token ? cloudflare(token, fetch, DNS_TOKEN_PERMISSIONS) : null;
}

/** AWS failures → a 502 the dashboard can show; 503 when SES isn't set up. */
async function aws<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    if (err instanceof AwsError) throw new UpstreamError(`SES ${what} failed: ${err.message}`);
    throw err;
  }
}

// ---- service ----------------------------------------------------------------

export const emailService: ServiceModule = {
  id: "email",
  async enable(project, log) {
    if (!sesConfigured()) throw new ServiceUnavailableError(NOT_SET_UP);
    await sql`insert into mybase.email_projects (project) values (${project}) on conflict do nothing`;
    log.info("email enabled");
  },
  async disable(project, log) {
    // Domains first: SES identities and our DNS records live outside the database.
    const domains: DomainRow[] = await sql`select * from mybase.email_domains where project = ${project}`;
    const cf = dnsClient();
    for (const d of domains) {
      if (sesConfigured()) await ses().deleteIdentity(d.domain);
      if (cf) await removeDns(d.zone_id, d.record_ids, d.records, cf).catch((err) => log.warn("email dns cleanup failed", { err, domain: d.domain }));
    }
    await sql`delete from mybase.email_projects where project = ${project}`;
    log.info("email disabled", { domains: domains.length });
  },
};

export async function requireEnabled(project: string): Promise<void> {
  const [row] = await sql`select 1 from mybase.email_projects where project = ${project}`;
  if (!row) throw new NotFoundError("email is not enabled for this project");
}

// ---- settings ---------------------------------------------------------------

interface SettingsRow {
  retention_days: number;
  track_opens: boolean;
  track_clicks: boolean;
  default_from: string | null;
}

async function settingsRow(project: string): Promise<SettingsRow> {
  const [row]: SettingsRow[] = await sql`
    select retention_days, track_opens, track_clicks, default_from from mybase.email_projects where project = ${project}`;
  if (!row) throw new NotFoundError("email is not enabled for this project");
  return row;
}

const toSettings = (r: SettingsRow): EmailSettings => ({
  retentionDays: r.retention_days,
  trackOpens: r.track_opens,
  trackClicks: r.track_clicks,
  defaultFrom: r.default_from,
});

export const getSettings = async (project: string) => toSettings(await settingsRow(project));

export async function updateSettings(project: string, body: unknown): Promise<EmailSettings> {
  const cur = await settingsRow(project);
  const b = (body ?? {}) as Record<string, unknown>;
  const next = { ...cur };
  if (b.retentionDays !== undefined) {
    const n = b.retentionDays;
    const { min, max } = EMAIL_LIMITS.retentionDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new BadRequestError(`retentionDays must be ${min}–${max}`);
    next.retention_days = n;
  }
  for (const [key, col] of [
    ["trackOpens", "track_opens"],
    ["trackClicks", "track_clicks"],
  ] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") throw new BadRequestError(`${key} must be true or false`);
    next[col] = b[key] as boolean;
  }
  if (b.defaultFrom !== undefined) {
    if (b.defaultFrom === null || b.defaultFrom === "") next.default_from = null;
    else {
      const [from] = parseAddresses(b.defaultFrom, "defaultFrom");
      await requireVerifiedFrom(project, from!);
      next.default_from = from!;
    }
  }
  await sql`
    update mybase.email_projects set retention_days = ${next.retention_days}, track_opens = ${next.track_opens},
      track_clicks = ${next.track_clicks}, default_from = ${next.default_from}
    where project = ${project}`;
  return toSettings(next);
}

// ---- domains ----------------------------------------------------------------

interface DomainRow {
  domain: string;
  project: string;
  status: EmailDomain["status"];
  dns: EmailDomain["dns"];
  records: EmailDnsRecord[];
  zone_id: string | null;
  record_ids: string[];
  error: string | null;
  created_at: Date;
  checked_at: Date | null;
  verified_at: Date | null;
}

const toDomain = (r: DomainRow, identity?: SesIdentity | null): EmailDomain => ({
  domain: r.domain,
  status: r.status,
  dns: r.dns,
  records: r.records,
  dkim: identity?.DkimAttributes?.Status ?? null,
  mailFrom: identity?.MailFromAttributes?.MailFromDomainStatus ?? null,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  checkedAt: r.checked_at?.toISOString() ?? null,
  verifiedAt: r.verified_at?.toISOString() ?? null,
});

export async function listDomains(project: string): Promise<EmailDomain[]> {
  await requireEnabled(project);
  const rows: DomainRow[] = await sql`select * from mybase.email_domains where project = ${project} order by domain`;
  return rows.map((r) => toDomain(r));
}

async function domainRow(project: string, domain: string): Promise<DomainRow> {
  const [row]: DomainRow[] = await sql`select * from mybase.email_domains where project = ${project} and domain = ${normalizeDomain(domain)}`;
  if (!row) throw new NotFoundError(`domain ${domain} isn't added to this project`);
  return row;
}

export async function addDomain(project: string, raw: unknown, log: Logger): Promise<EmailDomain> {
  await requireEnabled(project);
  const domain = normalizeDomain(String((raw as { domain?: unknown })?.domain ?? ""));
  const [taken]: { project: string }[] = await sql`select project from mybase.email_domains where domain = ${domain}`;
  if (taken) throw new ConflictError(taken.project === project ? `${domain} is already added` : `${domain} belongs to another project`);
  const region = sesRegion()!;

  // An identity left from earlier (or made by hand in AWS) is reused: its DKIM tokens stay valid.
  let identity = await aws("domain lookup", () => ses().getIdentity(domain));
  identity ??= await aws("domain setup", () => ses().createIdentity(domain));
  await aws("MAIL FROM setup", () => ses().setMailFrom(domain, `${MAIL_FROM_LABEL}.${domain}`));
  const tokens = identity.DkimAttributes?.Tokens ?? [];
  if (!tokens.length) throw new UpstreamError("SES returned no DKIM tokens for this domain");
  let records = domainRecords(domain, tokens, region);

  const cf = dnsClient();
  let dns: EmailDomain["dns"] = "manual";
  let zoneId: string | null = null;
  let recordIds: string[] = [];
  let error: string | null = null;
  if (cf) {
    const applied = await applyDns(domain, records, cf);
    records = applied.records;
    zoneId = applied.zoneId;
    recordIds = applied.recordIds;
    error = applied.error;
    if (applied.zoneId) dns = "cloudflare";
  }
  const status = identity.VerifiedForSendingStatus ? "verified" : "pending";
  const [row]: DomainRow[] = await sql`
    insert into mybase.email_domains (domain, project, status, dns, records, zone_id, record_ids, error, checked_at, verified_at)
    values (${domain}, ${project}, ${status}, ${dns}, ${JSON.stringify(records)}::text::jsonb, ${zoneId},
      ${JSON.stringify(recordIds)}::text::jsonb, ${error}, now(), ${status === "verified" ? new Date() : null})
    returning *`;
  log.info("email domain added", { domain, dns, records: recordIds.length });
  audit({ action: "email.domain.added", project, target: domain });
  return toDomain(row!, identity);
}

/** Asks SES whether the domain verified. Pending domains are also checked every 10 minutes. */
export async function checkDomain(project: string, domain: string): Promise<EmailDomain> {
  const row = await domainRow(project, domain);
  const identity = await aws("domain check", () => ses().getIdentity(row.domain));
  return toDomain(await saveCheck(row, identity), identity);
}

const GIVE_UP_MS = 72 * 3_600_000;

async function saveCheck(row: DomainRow, identity: SesIdentity | null): Promise<DomainRow> {
  let status: EmailDomain["status"];
  let error = row.error;
  if (!identity) {
    status = "failed";
    error = "SES no longer has this domain; remove it and add it again";
  } else if (identity.VerifiedForSendingStatus) {
    status = "verified";
    if (row.status !== "verified") error = null;
  } else if (identity.DkimAttributes?.Status === "FAILED" || Date.now() - row.created_at.getTime() > GIVE_UP_MS) {
    status = "failed";
    error = "SES couldn't find the DKIM records; check them, then re-check";
  } else {
    status = "pending";
  }
  const [updated]: DomainRow[] = await sql`
    update mybase.email_domains set status = ${status}, error = ${error}, checked_at = now(),
      verified_at = case when ${status} = 'verified' then coalesce(verified_at, now()) else null end
    where domain = ${row.domain} returning *`;
  if (status !== row.status) log.info("email domain status", { project: row.project, domain: row.domain, status });
  return updated!;
}

export async function removeDomain(project: string, domain: string, log: Logger): Promise<void> {
  const row = await domainRow(project, domain);
  await aws("domain removal", () => ses().deleteIdentity(row.domain));
  const cf = dnsClient();
  if (cf) await removeDns(row.zone_id, row.record_ids, row.records, cf).catch((err) => log.warn("email dns cleanup failed", { err, domain: row.domain }));
  await sql`delete from mybase.email_domains where domain = ${row.domain}`;
  log.info("email domain removed", { domain: row.domain });
  audit({ action: "email.domain.removed", project, target: row.domain });
}

async function verifiedDomains(project: string): Promise<string[]> {
  const rows: { domain: string }[] = await sql`select domain from mybase.email_domains where project = ${project} and status = 'verified'`;
  return rows.map((r) => r.domain);
}

async function requireVerifiedFrom(project: string, from: string) {
  const domain = addressDomain(from);
  const verified = await verifiedDomains(project);
  if (!domain || !verified.includes(domain)) {
    throw new BadRequestError(
      verified.length ? `from must be an address at ${verified.join(", ")} (verified for this project)` : "verify a domain for this project before sending (mybase email domains add <domain>)",
    );
  }
}

async function recheckPending() {
  const rows: DomainRow[] = await sql`select * from mybase.email_domains where status = 'pending' order by checked_at nulls first limit 20`;
  for (const row of rows) {
    try {
      await saveCheck(row, await ses().getIdentity(row.domain));
    } catch (err) {
      log.warn("email domain check failed", { err, domain: row.domain });
    }
  }
}

// ---- templates --------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  from_address: string | null;
  html: string;
  text: string;
  source: string | null;
  variables: EmailTemplateVariable[];
  source_kind: "dashboard" | "code";
  updated_at: Date;
}

const toSummary = (r: TemplateRow): EmailTemplateSummary => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  from: r.from_address,
  variables: r.variables,
  source: r.source_kind,
  updatedAt: r.updated_at.toISOString(),
});

const toTemplate = (r: TemplateRow): EmailTemplate => ({ ...toSummary(r), html: r.html, text: r.text, tsx: r.source });

export async function listTemplates(project: string): Promise<EmailTemplateSummary[]> {
  await requireEnabled(project);
  const rows: TemplateRow[] = await sql`
    select id, name, subject, from_address, '' as html, '' as text, null as source, variables, source_kind, updated_at
    from mybase.email_templates where project = ${project} order by id`;
  return rows.map(toSummary);
}

async function templateRow(project: string, id: string): Promise<TemplateRow> {
  const [row]: TemplateRow[] = await sql`select * from mybase.email_templates where project = ${project} and id = ${id}`;
  if (!row) throw new NotFoundError(`no template "${id}"`);
  return row;
}

export const getTemplate = async (project: string, id: string) => toTemplate(await templateRow(project, id));

const checkId = (id: string) => {
  if (!EMAIL_LIMITS.templateIdPattern.test(id)) throw new BadRequestError("template ids are lowercase letters, digits, - and _ (≤ 64)");
};

/** Dashboard save (create or update). Code templates can only change through sync. */
export async function saveTemplate(project: string, id: string, body: unknown): Promise<EmailTemplate> {
  await requireEnabled(project);
  checkId(id);
  const b = (body ?? {}) as Record<string, unknown>;
  const parts = parseTemplateParts(b, id);
  if (typeof b.tsx !== "string" || !b.tsx.trim() || b.tsx.length > 200_000) throw new BadRequestError("tsx (the template's source) is required");
  const variables = parseTemplateVariables(b.variables ?? [], parts);
  if (parts.from) await requireVerifiedFrom(project, parts.from);
  const [existing]: { source_kind: string }[] = await sql`select source_kind from mybase.email_templates where project = ${project} and id = ${id}`;
  if (existing?.source_kind === "code") throw new ConflictError(`template "${id}" comes from code; change it in the repo and run mybase email sync`);
  const [row]: TemplateRow[] = await sql`
    insert into mybase.email_templates (project, id, name, subject, from_address, html, text, source, variables, source_kind)
    values (${project}, ${id}, ${parts.name ?? id}, ${parts.subject}, ${parts.from}, ${parts.html}, ${parts.text}, ${b.tsx},
      ${JSON.stringify(variables)}::text::jsonb, 'dashboard')
    on conflict (project, id) do update set name = excluded.name, subject = excluded.subject, from_address = excluded.from_address,
      html = excluded.html, text = excluded.text, source = excluded.source, variables = excluded.variables, updated_at = now()
    returning *`;
  return toTemplate(row!);
}

export async function deleteTemplate(project: string, id: string): Promise<void> {
  const row = await templateRow(project, id);
  if (row.source_kind === "code") throw new ConflictError(`template "${id}" comes from code; remove it from the repo and run mybase email sync`);
  await sql`delete from mybase.email_templates where project = ${project} and id = ${id}`;
}

/** Replaces the code-defined templates. Dashboard ones are never touched; an id clash is a conflict. */
export async function syncTemplates(project: string, body: unknown): Promise<SyncEmailTemplatesResponse> {
  await requireEnabled(project);
  const b = (body ?? {}) as { templates?: unknown; dryRun?: unknown };
  const templates = parseSyncTemplates(b.templates);
  const dryRun = b.dryRun === true;
  const verified = await verifiedDomains(project);
  for (const t of templates) {
    const d = t.from ? addressDomain(t.from) : null;
    if (t.from && (!d || !verified.includes(d))) throw new BadRequestError(`${t.id}: from ${t.from} isn't on a verified domain of this project`);
  }
  const rows: TemplateRow[] = await sql`select * from mybase.email_templates where project = ${project}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const clash = templates.filter((t) => byId.get(t.id)?.source_kind === "dashboard").map((t) => t.id);
  if (clash.length) throw new ConflictError(`made in the dashboard, so sync won't replace them: ${clash.join(", ")} (delete them there or rename in code)`);

  const res: SyncEmailTemplatesResponse = { created: [], updated: [], deleted: [], unchanged: [] };
  const wanted = new Set(templates.map((t) => t.id));
  for (const t of templates) {
    const cur = byId.get(t.id);
    if (!cur) res.created.push(t.id);
    else if (
      cur.name !== t.name ||
      cur.subject !== t.subject ||
      cur.from_address !== (t.from ?? null) ||
      cur.html !== t.html ||
      cur.text !== t.text ||
      JSON.stringify(cur.variables) !== JSON.stringify(t.variables)
    )
      res.updated.push(t.id);
    else res.unchanged.push(t.id);
  }
  for (const r of rows) if (r.source_kind === "code" && !wanted.has(r.id)) res.deleted.push(r.id);
  if (dryRun) return res;

  await sql.begin(async (tx) => {
    for (const t of templates) {
      if (!res.created.includes(t.id) && !res.updated.includes(t.id)) continue;
      await tx`
        insert into mybase.email_templates (project, id, name, subject, from_address, html, text, source, variables, source_kind)
        values (${project}, ${t.id}, ${t.name ?? t.id}, ${t.subject}, ${t.from ?? null}, ${t.html}, ${t.text}, null,
          ${JSON.stringify(t.variables)}::text::jsonb, 'code')
        on conflict (project, id) do update set name = excluded.name, subject = excluded.subject, from_address = excluded.from_address,
          html = excluded.html, text = excluded.text, variables = excluded.variables, updated_at = now()`;
    }
    if (res.deleted.length) await tx`delete from mybase.email_templates where project = ${project} and id in ${tx(res.deleted)} and source_kind = 'code'`;
  });
  return res;
}

/** Template HTML with sample (or given) values, for the dashboard preview. */
export async function previewTemplate(project: string, id: string, vars: Record<string, string>): Promise<{ subject: string; html: string; text: string }> {
  const t = await templateRow(project, id);
  const values = Object.fromEntries(t.variables.map((v) => [v.name, vars[v.name] ?? v.sample]));
  return fillTemplate(t, values, []);
}

// ---- sending ----------------------------------------------------------------

const EMPTY_IDEMPOTENCY_AFTER = "24 hours";

// Bun SQL doesn't encode a plain JS array as a Postgres array (["a@b.c"] arrives as "a@b.c", a
// malformed array literal), so text[] columns always go through sql.array.
const textArray = (list: string[]) => sql.array(list, "text");

/**
 * Queues one email (template or content). Answers with the id at once; the sender sends it at the
 * account's rate. `test` (dashboard test sends) skips idempotency and suppressions.
 */
export async function send(project: string, raw: unknown, opts: { test?: boolean } = {}): Promise<SendEmailResponse> {
  const settings = await settingsRow(project);
  if (!sesConfigured()) throw new ServiceUnavailableError(NOT_SET_UP);
  const req = parseSend(raw);

  if (req.idempotencyKey) {
    const [dup]: { id: string; status: EmailStatus }[] = await sql`
      select id, status from mybase.email_messages
      where project = ${project} and idempotency_key = ${req.idempotencyKey} and created_at > now() - ${EMPTY_IDEMPOTENCY_AFTER}::interval`;
    if (dup) return { id: dup.id, status: dup.status, duplicate: true };
  }

  const content = await resolveContent(project, req, settings);
  await requireVerifiedFrom(project, content.from);

  if (!opts.test) {
    const all = [...req.to, ...req.cc, ...req.bcc].map(bareEmail);
    const suppressed: { address: string }[] = await sql`
      select address from mybase.email_suppressions where project = ${project} and address in ${sql(all)}`;
    if (suppressed.length) {
      throw new BadRequestError(
        `suppressed (bounced or complained earlier): ${suppressed.map((s) => s.address).join(", ")}. Remove them from the list in the dashboard to send anyway`,
      );
    }
  }

  const attachmentsMeta = req.attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.content?.length ?? null,
    storageKey: a.storageKey,
  }));
  const configSet = configurationSetName({ opens: settings.track_opens, clicks: settings.track_clicks });
  const sendAt = req.sendAt ?? new Date();
  const row = await sql.begin(async (tx) => {
    // The key frees up after 24 h, even while the old message is still in the log.
    if (req.idempotencyKey) {
      await tx`update mybase.email_messages set idempotency_key = null where project = ${project} and idempotency_key = ${req.idempotencyKey}`;
    }
    const [msg]: { id: string }[] = await tx`
      insert into mybase.email_messages (project, template_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to,
        subject, html, text, attachments, tags, configuration_set, status, send_at, idempotency_key)
      values (${project}, ${req.template}, ${content.from}, ${textArray(req.to)}, ${textArray(req.cc)}, ${textArray(req.bcc)}, ${textArray(req.replyTo)},
        ${content.subject}, ${content.html}, ${content.text}, ${JSON.stringify(attachmentsMeta)}::text::jsonb,
        ${JSON.stringify(opts.test ? { ...req.tags, mybase: "test" } : req.tags)}::text::jsonb, ${configSet}, 'queued', ${sendAt}, ${req.idempotencyKey})
      returning id`;
    for (const [i, a] of req.attachments.entries()) {
      if (a.content) await tx`insert into mybase.email_attachment_data (message_id, position, content) values (${msg!.id}, ${i}, ${a.content})`;
    }
    return msg!;
  });
  wakeSender(sendAt);
  return { id: row.id, status: "queued" };
}

async function resolveContent(project: string, req: ParsedSend, settings: SettingsRow) {
  if (req.template === null) {
    return { from: req.from!, subject: req.subject!, html: req.html, text: req.text };
  }
  const t = await templateRow(project, req.template);
  const filled = fillTemplate(t, req.variables, t.variables.map((v) => v.name));
  const from = req.from ?? t.from_address ?? settings.default_from;
  if (!from) throw new BadRequestError(`template "${t.id}" has no from address: pass from, or set one on the template or in email settings`);
  return { from, subject: filled.subject, html: filled.html, text: filled.text || null };
}

/** Dashboard "send test": a template with its sample values (or given ones) to one address. */
export async function sendTest(project: string, id: string, body: unknown): Promise<SendEmailResponse> {
  const b = (body ?? {}) as { to?: unknown; variables?: unknown; from?: unknown };
  const t = await templateRow(project, id);
  const given = parseVariables(b.variables);
  const variables = Object.fromEntries(t.variables.map((v) => [v.name, given[v.name] ?? v.sample]));
  return send(project, { template: id, to: b.to, from: b.from ?? undefined, variables }, { test: true });
}

// ---- messages ---------------------------------------------------------------

interface MessageRow {
  id: string;
  template_id: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string[];
  subject: string;
  attachments: { filename: string; contentType: string; size: number | null }[];
  tags: Record<string, string>;
  status: EmailStatus;
  error: string | null;
  created_at: Date;
  send_at: Date;
  sent_at: Date | null;
}

const toMessageSummary = (r: MessageRow): EmailMessageSummary => ({
  id: r.id,
  template: r.template_id,
  from: r.from_address,
  to: r.to_addresses,
  subject: r.subject,
  status: r.status,
  error: r.error,
  tags: r.tags,
  createdAt: r.created_at.toISOString(),
  sendAt: r.send_at.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const checkMessageId = (id: string) => {
  if (!UUID.test(id)) throw new NotFoundError("no such message");
};

const summaryColumns = () => sql`id, template_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, subject,
  attachments, tags, status, error, created_at, send_at, sent_at`;

export interface MessageFilter {
  status?: string | null;
  to?: string | null;
  template?: string | null;
  since?: string | null;
  /** Cursor: the last id of the previous page. */
  before?: string | null;
  limit?: number;
}

export async function listMessages(project: string, f: MessageFilter): Promise<EmailMessageList> {
  await requireEnabled(project);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  if (f.status && !(EMAIL_STATUSES as readonly string[]).includes(f.status)) throw new BadRequestError(`status must be one of ${EMAIL_STATUSES.join(", ")}`);
  const since = f.since ? new Date(f.since) : null;
  if (since && Number.isNaN(since.getTime())) throw new BadRequestError("since must be an ISO date");
  let cursor: Date | null = null;
  if (f.before) {
    checkMessageId(f.before);
    const [c]: { created_at: Date }[] = await sql`select created_at from mybase.email_messages where id = ${f.before} and project = ${project}`;
    cursor = c?.created_at ?? null;
  }
  const to = f.to?.trim().toLowerCase() || null;
  const rows: MessageRow[] = await sql`
    select ${summaryColumns()} from mybase.email_messages
    where project = ${project}
      ${f.status ? sql`and status = ${f.status}` : sql``}
      ${f.template ? sql`and template_id = ${f.template}` : sql``}
      ${since ? sql`and created_at >= ${since}` : sql``}
      ${cursor ? sql`and (created_at, id) < (${cursor}, ${f.before!}::uuid)` : sql``}
      ${to ? sql`and exists (select 1 from unnest(to_addresses || cc_addresses || bcc_addresses) a where lower(a) like ${`%${to.replace(/[\\%_]/g, "\\$&")}%`})` : sql``}
    order by created_at desc, id desc
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  return { messages: page.map(toMessageSummary), next: rows.length > limit ? page.at(-1)!.id : null };
}

export async function getMessage(project: string, id: string): Promise<EmailMessage> {
  checkMessageId(id);
  const [row]: MessageRow[] = await sql`select ${summaryColumns()} from mybase.email_messages where project = ${project} and id = ${id}`;
  if (!row) throw new NotFoundError("no such message");
  const events: { type: EmailMessage["events"][number]["type"]; at: Date; detail: Record<string, unknown> | null }[] = await sql`
    select type, at, detail from mybase.email_events where message_id = ${id} order by at, id`;
  return {
    ...toMessageSummary(row),
    cc: row.cc_addresses,
    bcc: row.bcc_addresses,
    replyTo: row.reply_to,
    attachments: row.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    events: events.map((e) => ({ type: e.type, at: e.at.toISOString(), ...(e.detail ? { detail: e.detail } : {}) })),
  };
}

/** The stored body, for the dashboard's sandboxed preview. */
export async function messageBody(project: string, id: string): Promise<{ html: string | null; text: string | null }> {
  checkMessageId(id);
  const [row]: { html: string | null; text: string | null }[] = await sql`
    select html, text from mybase.email_messages where project = ${project} and id = ${id}`;
  if (!row) throw new NotFoundError("no such message");
  return row;
}

export async function cancelMessage(project: string, id: string): Promise<void> {
  checkMessageId(id);
  const res = await sql.begin(async (tx) => {
    const updated = await tx`update mybase.email_messages set status = 'canceled' where project = ${project} and id = ${id} and status = 'queued'`;
    if (updated.count) {
      await tx`insert into mybase.email_events (message_id, type, at) values (${id}, 'canceled', now())`;
      await tx`delete from mybase.email_attachment_data where message_id = ${id}`;
    }
    return updated.count;
  });
  if (res) return;
  const [row]: { status: string }[] = await sql`select status from mybase.email_messages where project = ${project} and id = ${id}`;
  if (!row) throw new NotFoundError("no such message");
  throw new ConflictError(`the message is ${row.status}; only queued or scheduled messages can be canceled`);
}

// ---- suppressions -----------------------------------------------------------

export async function listSuppressions(project: string): Promise<EmailSuppression[]> {
  await requireEnabled(project);
  const rows: { address: string; reason: EmailSuppression["reason"]; created_at: Date }[] = await sql`
    select address, reason, created_at from mybase.email_suppressions where project = ${project} order by created_at desc limit 1000`;
  return rows.map((r) => ({ address: r.address, reason: r.reason, createdAt: r.created_at.toISOString() }));
}

export async function addSuppression(project: string, body: unknown): Promise<void> {
  await requireEnabled(project);
  const [addr] = parseAddresses((body as { address?: unknown })?.address, "address");
  await sql`insert into mybase.email_suppressions (project, address, reason) values (${project}, ${bareEmail(addr!)}, 'manual') on conflict do nothing`;
}

export async function removeSuppression(project: string, address: string): Promise<void> {
  const res = await sql`delete from mybase.email_suppressions where project = ${project} and address = ${address.trim().toLowerCase()}`;
  if (!res.count) throw new NotFoundError("that address isn't suppressed");
}

// ---- overview (context, MCP) ------------------------------------------------

export async function overview(project: string) {
  const [domains, templates, [counts]] = await Promise.all([
    sql<{ domain: string; status: string }[]>`select domain, status from mybase.email_domains where project = ${project} order by domain`,
    sql<{ id: string }[]>`select id from mybase.email_templates where project = ${project} order by id`,
    sql<{ sent: number; bounced: number; complained: number }[]>`
      select count(*) filter (where status not in ('queued','canceled','failed'))::int as sent,
        count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'complained')::int as complained
      from mybase.email_messages where project = ${project} and created_at > now() - interval '7 days'`,
  ]);
  return { domains: [...domains], templates: templates.map((t) => t.id), last7Days: counts ?? { sent: 0, bounced: 0, complained: 0 } };
}

// ---- background -------------------------------------------------------------

let timers: ReturnType<typeof setInterval>[] = [];

async function prune() {
  const res = await sql`
    delete from mybase.email_messages m using mybase.email_projects p
    where m.project = p.project and m.created_at < now() - make_interval(days => p.retention_days)
      and m.status not in ('queued', 'sending')`;
  if (res.count) log.info("old emails pruned", { messages: res.count });
}

/** Boot: event pipeline, sender, domain checks, pruning. No-op without SES settings. */
export async function startEmail() {
  if (!sesConfigured()) {
    log.debug("email not configured (MYBASE_SES_*)");
    return;
  }
  void setUpEvents((queueUrl) => startEventPoller(queueUrl));
  await startSender();
  const safe = (name: string, fn: () => Promise<void>) => () => void fn().catch((err) => log.warn(`email ${name} failed`, { err }));
  timers = [setInterval(safe("domain checks", recheckPending), 10 * 60_000), setInterval(safe("prune", prune), 3_600_000)];
  safe("domain checks", recheckPending)();
  safe("prune", prune)();
  log.info("email started", { region: sesRegion() });
}

export function stopEmail() {
  for (const t of timers) clearInterval(t);
  stopSender();
  stopEvents();
  stopSes();
}

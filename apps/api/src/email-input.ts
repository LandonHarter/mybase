// Pure checks for the email service: send requests, template variables and substitution,
// attachments. No I/O, so it's all unit-tested (email-input.test.ts).
import type { EmailTemplateVariable, SyncEmailTemplate } from "@mybase/shared";
import { EMAIL_LIMITS } from "@mybase-dev/sdk/email";
import { parseAddress } from "./email-domains";
import { BadRequestError } from "./errors";

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Every `{{name}}` used in these strings. */
export function placeholders(...texts: string[]): string[] {
  const names = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(VAR)) names.add(m[1]!);
  return [...names];
}

export type Variables = Record<string, string>;

/** Stringifies and checks a send's `variables`. */
export function parseVariables(raw: unknown): Variables {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestError("variables must be an object of strings");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > EMAIL_LIMITS.variables) throw new BadRequestError(`at most ${EMAIL_LIMITS.variables} variables`);
  const out: Variables = {};
  for (const [k, v] of entries) {
    if (!VAR_NAME.test(k)) throw new BadRequestError(`variable name "${k}" isn't valid (letters, digits, _)`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new BadRequestError(`variable "${k}" must be a string, number, or boolean`);
    const s = String(v);
    if (s.length > EMAIL_LIMITS.variableLength) throw new BadRequestError(`variable "${k}" is too long`);
    out[k] = s;
  }
  return out;
}

/**
 * Fills `{{name}}` in a template's parts: HTML-escaped in html, as is in text, and with line
 * breaks flattened in the subject (header injection). Missing variables → BadRequestError naming them.
 */
export function fillTemplate(t: { subject: string; html: string; text: string }, vars: Variables, declared: string[]) {
  const needed = new Set([...declared, ...placeholders(t.subject, t.html, t.text)]);
  const missing = [...needed].filter((n) => !(n in vars));
  if (missing.length) throw new BadRequestError(`missing variables: ${missing.join(", ")}`);
  const fill = (s: string, enc: (v: string) => string) => s.replace(VAR, (_, name: string) => enc(vars[name]!));
  return {
    subject: fill(t.subject, (v) => v.replace(/[\r\n]+/g, " ")).trim(),
    html: fill(t.html, escapeHtml),
    text: fill(t.text, (v) => v),
  };
}

// Extensions SES refuses (https://docs.aws.amazon.com/ses/latest/dg/attachments.html).
const BLOCKED = new Set(
  "ade adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its js jse ksh lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 mshxml msh1xml msh2xml msi msp mst ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ps2 ps2xml psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ws wsc wsf wsh xnk".split(
    " ",
  ),
);

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const extOf = (filename: string) => (filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "");

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** Decoded bytes for base64 attachments; null for storage ones (read at send time). */
  content: Uint8Array | null;
  storageKey: string | null;
}

/** Checks `attachments`; base64 content is decoded and counted toward the size limit. */
export function parseAttachments(raw: unknown): AttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestError("attachments must be an array");
  if (raw.length > EMAIL_LIMITS.attachments) throw new BadRequestError(`at most ${EMAIL_LIMITS.attachments} attachments`);
  let total = 0;
  return raw.map((a, i) => {
    if (!a || typeof a !== "object") throw new BadRequestError(`attachment ${i + 1} must be an object`);
    const { filename, contentType, content, storageKey } = a as Record<string, unknown>;
    if (typeof filename !== "string" || !filename.trim() || filename.length > 255 || /[\r\n\0/\\"]/.test(filename)) {
      throw new BadRequestError(`attachment ${i + 1} needs a plain filename`);
    }
    if (BLOCKED.has(extOf(filename))) throw new BadRequestError(`${filename}: SES doesn't send .${extOf(filename)} files`);
    if (contentType !== undefined && (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType))) {
      throw new BadRequestError(`${filename}: contentType isn't a media type`);
    }
    const type = (contentType as string | undefined) ?? TYPES[extOf(filename)] ?? "application/octet-stream";
    if ((content === undefined) === (storageKey === undefined)) throw new BadRequestError(`${filename}: give either content (base64) or storageKey`);
    if (typeof storageKey === "string") {
      if (!storageKey || storageKey.length > 1024 || storageKey.startsWith("/") || storageKey.split("/").includes("..")) {
        throw new BadRequestError(`${filename}: storageKey isn't a valid object key`);
      }
      return { filename, contentType: type, content: null, storageKey };
    }
    if (typeof content !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(content)) throw new BadRequestError(`${filename}: content must be base64`);
    const bytes = Buffer.from(content, "base64");
    total += bytes.length;
    if (total > EMAIL_LIMITS.attachmentBytes) throw new BadRequestError(`attachments are over ${EMAIL_LIMITS.attachmentBytes / 1024 / 1024} MB`);
    return { filename, contentType: type, content: new Uint8Array(bytes), storageKey: null };
  });
}

/** Address list from a string or array; every entry must parse. Returns normalized `Name <email>` / `email`. */
export function parseAddresses(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((a) => {
    const parsed = typeof a === "string" ? parseAddress(a) : null;
    if (!parsed) throw new BadRequestError(`${field}: "${String(a).slice(0, 100)}" isn't an email address`);
    return formatAddress(parsed);
  });
}

export const formatAddress = (a: { name: string | null; email: string }) => (a.name ? `"${a.name.replaceAll('"', "")}" <${a.email}>` : a.email);

/** Bare email of a formatted address. */
export const bareEmail = (addr: string) => parseAddress(addr)?.email ?? addr.toLowerCase();

export interface ParsedSend {
  template: string | null;
  variables: Variables;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  attachments: AttachmentInput[];
  sendAt: Date | null;
  idempotencyKey: string | null;
  tags: Record<string, string>;
}

/** Validates a send request body (template or content). `now` for tests. */
export function parseSend(raw: unknown, now = Date.now()): ParsedSend {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestError("body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const template = b.template === undefined ? null : b.template;
  if (template !== null && (typeof template !== "string" || !EMAIL_LIMITS.templateIdPattern.test(template))) throw new BadRequestError("template must be a template id");

  const to = parseAddresses(b.to, "to");
  const cc = parseAddresses(b.cc, "cc");
  const bcc = parseAddresses(b.bcc, "bcc");
  if (!to.length) throw new BadRequestError("to needs at least one address");
  if (to.length + cc.length + bcc.length > EMAIL_LIMITS.recipients) throw new BadRequestError(`at most ${EMAIL_LIMITS.recipients} recipients (to + cc + bcc)`);
  const replyTo = parseAddresses(b.replyTo, "replyTo");
  const fromList = parseAddresses(b.from, "from");
  if (fromList.length > 1) throw new BadRequestError("from must be one address");

  let subject: string | null = null;
  let html: string | null = null;
  let text: string | null = null;
  if (template === null) {
    if (!fromList.length) throw new BadRequestError("from is required without a template");
    if (typeof b.subject !== "string" || !b.subject.trim()) throw new BadRequestError("subject is required without a template");
    subject = b.subject.replace(/[\r\n]+/g, " ").trim();
    if (subject.length > EMAIL_LIMITS.subjectLength) throw new BadRequestError("subject is too long");
    for (const [k, v] of [
      ["html", b.html],
      ["text", b.text],
    ] as const) {
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") throw new BadRequestError(`${k} must be a string`);
      if (v.length > EMAIL_LIMITS.bodyLength) throw new BadRequestError(`${k} is too long`);
    }
    html = typeof b.html === "string" && b.html ? b.html : null;
    text = typeof b.text === "string" && b.text ? b.text : null;
    if (!html && !text) throw new BadRequestError("html or text is required without a template");
    if (b.variables !== undefined) throw new BadRequestError("variables only work with a template");
  } else if (b.subject !== undefined || b.html !== undefined || b.text !== undefined) {
    throw new BadRequestError("subject, html, and text come from the template; send one or the other");
  }

  let sendAt: Date | null = null;
  if (b.sendAt !== undefined && b.sendAt !== null) {
    const d = typeof b.sendAt === "string" ? new Date(b.sendAt) : null;
    if (!d || Number.isNaN(d.getTime())) throw new BadRequestError("sendAt must be an ISO date");
    if (d.getTime() > now + EMAIL_LIMITS.scheduleMs) throw new BadRequestError("sendAt can be at most 30 days ahead");
    sendAt = d.getTime() > now ? d : null;
  }

  const key = b.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || !key || key.length > EMAIL_LIMITS.idempotencyKeyLength)) {
    throw new BadRequestError(`idempotencyKey must be a string of up to ${EMAIL_LIMITS.idempotencyKeyLength} characters`);
  }

  const tags: Record<string, string> = {};
  if (b.tags !== undefined && b.tags !== null) {
    if (typeof b.tags !== "object" || Array.isArray(b.tags)) throw new BadRequestError("tags must be an object of strings");
    const entries = Object.entries(b.tags as Record<string, unknown>);
    if (entries.length > EMAIL_LIMITS.tags) throw new BadRequestError(`at most ${EMAIL_LIMITS.tags} tags`);
    for (const [k, v] of entries) {
      if (!/^[\w.-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 256) throw new BadRequestError(`tag "${k.slice(0, 64)}" must be a short name with a string value`);
      tags[k] = v;
    }
  }

  return {
    template,
    variables: template === null ? {} : parseVariables(b.variables),
    from: fromList[0] ?? null,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    attachments: parseAttachments(b.attachments),
    sendAt,
    idempotencyKey: (key as string | undefined) ?? null,
    tags,
  };
}

/** Checks a template's declared variables and that every placeholder is declared. */
export function parseTemplateVariables(raw: unknown, parts: { subject: string; html: string; text: string }): EmailTemplateVariable[] {
  if (!Array.isArray(raw)) throw new BadRequestError("variables must be an array");
  if (raw.length > EMAIL_LIMITS.variables) throw new BadRequestError(`at most ${EMAIL_LIMITS.variables} variables`);
  const vars = raw.map((v) => {
    const { name, sample } = (v ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !VAR_NAME.test(name)) throw new BadRequestError(`variable name "${String(name)}" isn't valid (letters, digits, _)`);
    return { name, sample: typeof sample === "string" ? sample.slice(0, 1000) : sample === undefined || sample === null ? "" : String(sample).slice(0, 1000) };
  });
  const declared = new Set(vars.map((v) => v.name));
  if (declared.size !== vars.length) throw new BadRequestError("variable names must be unique");
  const undeclared = placeholders(parts.subject, parts.html, parts.text).filter((n) => !declared.has(n));
  for (const name of undeclared) vars.push({ name, sample: "" });
  return vars;
}

/** Checks a template's rendered parts (dashboard save or sync). */
export function parseTemplateParts(raw: Record<string, unknown>, label: string) {
  const { subject, html, text, from, name } = raw;
  if (typeof subject !== "string" || !subject.trim() || subject.length > EMAIL_LIMITS.subjectLength || /[\r\n]/.test(subject)) {
    throw new BadRequestError(`${label}: subject must be one line`);
  }
  if (typeof html !== "string" || !html.trim() || html.length > EMAIL_LIMITS.bodyLength) throw new BadRequestError(`${label}: html is missing or too long`);
  if (typeof text !== "string" || text.length > EMAIL_LIMITS.bodyLength) throw new BadRequestError(`${label}: text must be a string`);
  let fromAddress: string | null = null;
  if (from !== undefined && from !== null && from !== "") {
    const parsed = typeof from === "string" ? parseAddress(from) : null;
    if (!parsed) throw new BadRequestError(`${label}: from isn't an email address`);
    fromAddress = formatAddress(parsed);
  }
  if (name !== undefined && (typeof name !== "string" || name.length > 200)) throw new BadRequestError(`${label}: name must be a short string`);
  return { subject: subject.trim(), html, text, from: fromAddress, name: (name as string | undefined)?.trim() || null };
}

/** Checks a `mybase email sync` payload. */
export function parseSyncTemplates(raw: unknown): SyncEmailTemplate[] {
  if (!Array.isArray(raw)) throw new BadRequestError("templates must be an array");
  if (raw.length > 500) throw new BadRequestError("at most 500 templates");
  const seen = new Set<string>();
  return raw.map((t, i) => {
    if (!t || typeof t !== "object") throw new BadRequestError(`template ${i + 1} must be an object`);
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || !EMAIL_LIMITS.templateIdPattern.test(r.id)) throw new BadRequestError(`template ${i + 1}: id must match ${EMAIL_LIMITS.templateIdPattern}`);
    if (seen.has(r.id)) throw new BadRequestError(`template ${r.id} appears twice`);
    seen.add(r.id);
    const parts = parseTemplateParts(r, r.id);
    return { id: r.id, name: parts.name ?? r.id, subject: parts.subject, from: parts.from, html: parts.html, text: parts.text, variables: parseTemplateVariables(r.variables ?? [], parts) };
  });
}

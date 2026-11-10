// Sending domains for the email service. Pure record building plus the Cloudflare DNS steps,
// kept apart from email.ts so they're testable with a fake Cloudflare.
//
// A domain needs: three DKIM CNAMEs (SES Easy DKIM), a custom MAIL FROM (`bounce.<domain>`: MX to
// SES's feedback endpoint + SPF TXT) so SPF aligns for DMARC, and a DMARC TXT if the domain has
// none. With MYBASE_DNS_TOKEN (DNS edit + zone read, shared with hosting/public Postgres) mybase
// adds them in Cloudflare (never proxied); otherwise the dashboard lists them to add by hand.
import { isHostname, type EmailDnsRecord } from "@mybase/shared";
import { zoneOf, type Cloudflare } from "@mybase/shared/cloudflare";
import { BadRequestError } from "./errors";

export const MAIL_FROM_LABEL = "bounce";
export const DMARC_DEFAULT = "v=DMARC1; p=none;";
const COMMENT = "mybase email";

/** Lowercase, no trailing dot; throws if it can't be a sending domain. */
export function normalizeDomain(raw: string): string {
  const domain = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (domain.includes("*")) throw new BadRequestError("wildcard domains can't send email; add the domain itself");
  if (!isHostname(domain) || !domain.includes(".")) throw new BadRequestError(`"${domain}" isn't a domain (like acme.com or mail.acme.com)`);
  if (domain.endsWith(".localhost") || domain.endsWith(".local") || domain.endsWith(".internal")) throw new BadRequestError(`${domain} isn't a public domain`);
  return domain;
}

/** The records SES needs for `domain`. DMARC is a suggestion: skipped when the domain has one. */
export function domainRecords(domain: string, dkimTokens: string[], region: string): EmailDnsRecord[] {
  const mailFrom = `${MAIL_FROM_LABEL}.${domain}`;
  return [
    ...dkimTokens.map((t): EmailDnsRecord => ({ purpose: "dkim", type: "CNAME", name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` })),
    { purpose: "mail-from", type: "MX", name: mailFrom, value: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
    { purpose: "mail-from", type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
    { purpose: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: DMARC_DEFAULT },
  ];
}

/** TXT values may come back quoted from Cloudflare. */
const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1");

export interface DnsApplied {
  zoneId: string | null;
  recordIds: string[];
  /** Records with `state` filled in. */
  records: EmailDnsRecord[];
  /** Why automatic DNS didn't (fully) work; null = it did. */
  error: string | null;
}

/**
 * Adds the records in Cloudflare. A record that's already there with the same value is kept (not
 * ours to delete later); a DMARC record of any value counts as present. A different CNAME at a
 * DKIM name, or another MX at the MAIL FROM name, is a conflict: reported, never replaced.
 */
export async function applyDns(domain: string, records: EmailDnsRecord[], cf: Cloudflare): Promise<DnsApplied> {
  let zoneId: string | null = null;
  const recordIds: string[] = [];
  const out: EmailDnsRecord[] = records.map((r) => ({ ...r }));
  const problems: string[] = [];
  try {
    const zone = zoneOf(await cf.listZones(), domain);
    if (!zone) {
      return {
        zoneId: null,
        recordIds,
        records: out,
        error: `no active Cloudflare zone for ${domain} that MYBASE_DNS_TOKEN can see; add the records yourself`,
      };
    }
    zoneId = zone.id;
    for (const r of out) {
      const existing = await cf.listRecords(zone.id, r.name);
      const sameType = existing.filter((e) => e.type === r.type);
      if (r.purpose === "dmarc") {
        if (sameType.some((e) => unquote(e.content).toLowerCase().startsWith("v=dmarc1"))) {
          r.state = "present";
          continue;
        }
      } else if (sameType.some((e) => unquote(e.content).toLowerCase() === r.value.toLowerCase())) {
        r.state = "present";
        continue;
      }
      // A CNAME can't share its name; a second MX or SPF record at the MAIL FROM name would break it.
      const conflict =
        r.type === "CNAME"
          ? existing[0]
          : r.type === "MX"
            ? sameType[0]
            : sameType.find((e) => unquote(e.content).toLowerCase().startsWith("v=spf1"));
      if (conflict) {
        r.state = "conflict";
        problems.push(`${r.name} already has ${conflict.type} ${unquote(conflict.content)}`);
        continue;
      }
      const created = await cf.createRecord(zone.id, {
        type: r.type,
        name: r.name,
        content: r.value,
        ...(r.priority !== undefined ? { priority: r.priority } : {}),
        proxied: false,
        ttl: 1,
        comment: COMMENT,
      });
      recordIds.push(created.id);
      r.state = "added";
    }
    return { zoneId, recordIds, records: out, error: problems.length ? `fix these by hand: ${problems.join("; ")}` : null };
  } catch (err) {
    return { zoneId, recordIds, records: out, error: (err as Error).message };
  }
}

/** Deletes the records mybase added (by id), if they still carry our comment. */
export async function removeDns(zoneId: string | null, recordIds: string[], records: EmailDnsRecord[], cf: Cloudflare): Promise<void> {
  if (!zoneId || !recordIds.length) return;
  const ids = new Set(recordIds);
  const names = [...new Set(records.map((r) => r.name))];
  for (const name of names) {
    for (const r of await cf.listRecords(zoneId, name)) {
      if (ids.has(r.id) && r.comment === COMMENT) await cf.deleteRecord(zoneId, r.id);
    }
  }
}

/** The domain part of `addr` (`"Name <a@b.com>"` or `a@b.com`), lowercased; null if malformed. */
export function addressDomain(addr: string): string | null {
  const email = parseAddress(addr)?.email;
  return email ? email.slice(email.lastIndexOf("@") + 1) : null;
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** `"Name <a@b.com>"` or `a@b.com` → parts. Rejects CR/LF and anything SES would choke on. */
export function parseAddress(raw: string): { name: string | null; email: string } | null {
  if (typeof raw !== "string" || raw.length > 320 || /[\r\n\0]/.test(raw)) return null;
  const s = raw.trim();
  const m = /^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/.exec(s);
  const email = (m ? m[2]! : s).toLowerCase();
  if (!EMAIL.test(email)) return null;
  const [local, domain] = [email.slice(0, email.lastIndexOf("@")), email.slice(email.lastIndexOf("@") + 1)];
  if (local.length > 64 || domain.length > 253) return null;
  return { name: m?.[1]?.trim() || null, email };
}

/** True if `addr`'s domain is one of `verified` (exact match; subdomains are their own identity). */
export function fromAllowed(addr: string, verified: string[]): boolean {
  const d = addressDomain(addr);
  return !!d && verified.includes(d);
}

// Custom domains for hosted sites. Pure checks plus the Cloudflare DNS steps, kept apart from
// hosting.ts so they're testable with a fake Cloudflare.
//
// Traffic reaches Caddy through the Cloudflare Tunnel. `mybase server hosting` sets the tunnel's
// catch-all to Caddy, so a hostname needs only a proxied CNAME to `<tunnel id>.cfargotunnel.com`
// (Cloudflare only routes those for zones in the tunnel's own account). MYBASE_DNS_TOKEN (DNS edit
// + zone read) writes that record; without it, or without a tunnel, the user adds DNS by hand.
import { HOSTING_SITE_PATTERN, isHostname, type HostingDomainStatus } from "@mybase/shared";
import { pointsAtTunnel, zoneOf, type Cloudflare, type DnsRecord } from "@mybase/shared/cloudflare";
import { BadRequestError, ConflictError } from "./errors";

/** Lowercase, no trailing dot. */
export const normalizeHostname = (raw: string) => raw.trim().toLowerCase().replace(/\.$/, "");

export interface HostnameRules {
  /** MYBASE_HOSTING_DOMAIN. */
  hostingDomain: string | null;
  /** mybase's own public hostnames (API, S3, public Postgres). */
  ownHosts: string[];
}

/** Throws if `host` can't be a site's custom domain. `host` is normalized. */
export function checkHostname(host: string, rules: HostnameRules): void {
  if (host.includes("*")) throw new BadRequestError("wildcard domains aren't supported; add each hostname");
  if (!isHostname(host)) throw new BadRequestError(`"${host}" isn't a hostname (like shop.com or www.shop.com)`);
  if (host.endsWith(".localhost")) throw new BadRequestError("<site>.localhost names are built in");
  if (rules.ownHosts.includes(host)) throw new BadRequestError(`${host} is one of mybase's own hostnames`);
  const d = rules.hostingDomain;
  if (d && host.endsWith(`.${d}`)) {
    const label = host.slice(0, -d.length - 1);
    // One label under the base domain is where sites live: `x.<domain>` belongs to site `x`.
    if (!label.includes(".")) {
      throw new BadRequestError(
        HOSTING_SITE_PATTERN.test(label) ? `${host} is the address of a site named "${label}"; name the site ${label} instead` : `${host} is under the sites' base domain`,
      );
    }
  }
}

/** The hostnames among these env values (full URLs or bare hosts). */
export function hostsOf(values: (string | undefined)[]): string[] {
  return values.flatMap((raw) => {
    if (!raw) return [];
    const host = raw.includes("://") ? URL.parse(raw)?.hostname : raw.split(":")[0];
    return host ? [normalizeHostname(host)] : [];
  });
}

/** A note when Cloudflare's free certificate (zone + one level) won't cover `host`. */
export function certNote(host: string, zone: string): string | null {
  if (host === zone) return null;
  const sub = host.slice(0, -zone.length - 1);
  if (!sub.includes(".")) return null;
  return `Cloudflare's free certificate covers ${zone} and *.${zone} only: https://${host} needs Advanced Certificate Manager.`;
}

export interface DnsConfig {
  /** MYBASE_TUNNEL_ID. */
  tunnelId: string | null;
  /** A Cloudflare client with MYBASE_DNS_TOKEN, if set. */
  cf: Cloudflare | null;
  /** MYBASE_HOSTING_PORT, for the no-tunnel instructions. */
  hostingPort: number;
}

export interface Routed {
  status: HostingDomainStatus;
  error: string | null;
  instructions: string | null;
  zoneId: string | null;
  recordId: string | null;
}

/** What to add by hand when mybase can't edit the DNS. */
export function manualInstructions(host: string, dns: Pick<DnsConfig, "tunnelId" | "hostingPort">): string {
  if (dns.tunnelId) {
    return `In Cloudflare, add a proxied CNAME ${host} → ${dns.tunnelId}.cfargotunnel.com (the zone must be in the tunnel's account). Or set MYBASE_DNS_TOKEN on the server and re-check.`;
  }
  return `Point ${host} at this machine yourself: Caddy answers plain HTTP on port ${dns.hostingPort}. With a Cloudflare Tunnel (mybase server tunnel, then mybase server hosting) mybase can add the record.`;
}

const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);
const isOurs = (r: DnsRecord, tunnelId: string) => r.type === "CNAME" && pointsAtTunnel(r, tunnelId);

/**
 * Points `host` at the tunnel: reuses a CNAME that already does, else creates one. Other
 * address records (A/AAAA/CNAME) at the name are replaced only with `replace`; without it a
 * ConflictError (`throwOnConflict`) or an `error` status. Other types (MX, TXT) are left alone.
 * Cloudflare failures become an `error` status.
 */
export async function routeDomain(host: string, site: string, dns: DnsConfig, opts: { replace: boolean; throwOnConflict: boolean }): Promise<Routed> {
  const none = { zoneId: null, recordId: null };
  if (!dns.tunnelId || !dns.cf) return { status: "manual", error: null, instructions: manualInstructions(host, dns), ...none };
  const { cf, tunnelId } = dns;
  let zoneId: string | null = null;
  try {
    const zone = zoneOf(await cf.listZones(), host);
    if (!zone) {
      return { status: "error", error: `no active Cloudflare zone for ${host} that MYBASE_DNS_TOKEN can see (add the domain to Cloudflare, or give the token access to it)`, instructions: null, ...none };
    }
    zoneId = zone.id;
    const records = await cf.listRecords(zone.id, host);
    let record = records.find((r) => isOurs(r, tunnelId));
    const others = records.filter((r) => ADDRESS_TYPES.has(r.type) && r !== record);
    if (others.length && !opts.replace) {
      const message = `${host} already has ${others.map((r) => `${r.type} → ${r.content}`).join(", ")} in Cloudflare; replace it to route the domain here`;
      if (opts.throwOnConflict) throw new ConflictError(message);
      return { status: "error", error: message, instructions: null, zoneId, recordId: null };
    }
    for (const r of others) await cf.deleteRecord(zone.id, r.id);
    record ??= await cf.createRecord(zone.id, { type: "CNAME", name: host, content: `${tunnelId}.cfargotunnel.com`, proxied: true, comment: `mybase hosting ${site}` });
    return { status: "active", error: null, instructions: certNote(host, zone.name), zoneId, recordId: record.id };
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    return { status: "error", error: (err as Error).message, instructions: null, zoneId, recordId: null };
  }
}

/** Deletes the CNAME mybase made, if it still points at the tunnel. Never touches other records. */
export async function unrouteDomain(host: string, zoneId: string | null, recordId: string | null, dns: DnsConfig): Promise<void> {
  if (!zoneId || !recordId || !dns.cf || !dns.tunnelId) return;
  const records = await dns.cf.listRecords(zoneId, host);
  const ours = records.find((r) => r.id === recordId && isOurs(r, dns.tunnelId!));
  if (ours) await dns.cf.deleteRecord(zoneId, ours.id);
}

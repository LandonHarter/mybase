// Just enough of Cloudflare's API for mybase: the CLI sets up a tunnel (`mybase server setup|tunnel`:
// a remotely managed tunnel, its ingress rules, proxied CNAMEs; that token is never saved), and the API
// keeps public Postgres's DNS (an unproxied A record and ACME TXT records) with MYBASE_DNS_TOKEN.

const API = "https://api.cloudflare.com/client/v4";

/** What the API token needs, shown before asking for it. */
export const TOKEN_PERMISSIONS = ["Account › Cloudflare Tunnel › Edit", "Zone › DNS › Edit", "Zone › Zone › Read"];

/** What MYBASE_DNS_TOKEN needs (public Postgres: DDNS + Let's Encrypt DNS challenges). */
export const DNS_TOKEN_PERMISSIONS = ["Zone › DNS › Edit", "Zone › Zone › Read"];

export const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

export interface Account {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
  account: Account;
}

export interface Tunnel {
  id: string;
  name: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

export interface DnsRecordInput {
  type: "A" | "AAAA" | "TXT" | "CNAME";
  name: string;
  content: string;
  proxied?: boolean;
  /** Seconds; 1 = automatic. */
  ttl?: number;
  comment?: string;
}

export interface IngressRule {
  hostname: string;
  service: string;
}

export class CloudflareError extends Error {}

export function cloudflare(token: string, fetcher: typeof fetch = fetch, permissions = TOKEN_PERMISSIONS) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
      throw new CloudflareError("can't reach api.cloudflare.com");
    });
    const data = (await res.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[]; result?: T } | null;
    if (!res.ok || !data?.success) {
      const message = data?.errors?.map((e) => e.message).join("; ") || res.statusText;
      if (res.status === 401 || res.status === 403) throw new CloudflareError(`Cloudflare refused the token (${message}). It needs: ${permissions.join(", ")}.`);
      throw new CloudflareError(`Cloudflare: ${message}`);
    }
    return data.result as T;
  }

  return {
    listAccounts: () => call<Account[]>("GET", "/accounts?per_page=50"),

    listZones: () => call<Zone[]>("GET", "/zones?per_page=50&status=active"),

    /** The active zone `host` belongs to (longest matching name), or null. */
    async zoneFor(host: string): Promise<Zone | null> {
      const zones = await call<Zone[]>("GET", "/zones?per_page=50&status=active");
      return zoneOf(zones, host);
    },

    /** Creates or replaces the record of this type at `name`. */
    async upsertRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecord> {
      const path = `/zones/${zoneId}/dns_records`;
      const existing = await call<DnsRecord[]>("GET", `${path}?type=${record.type}&name=${encodeURIComponent(record.name)}`);
      if (existing[0]) return call<DnsRecord>("PUT", `${path}/${existing[0].id}`, record);
      return call<DnsRecord>("POST", path, record);
    },

    /** Adds a record next to any others at the same name (TXT challenges can repeat). */
    createRecord: (zoneId: string, record: DnsRecordInput) => call<DnsRecord>("POST", `/zones/${zoneId}/dns_records`, record),

    deleteRecord: (zoneId: string, id: string) => call<unknown>("DELETE", `/zones/${zoneId}/dns_records/${id}`),

    /** The live tunnel called `name`, or a new remotely managed one (configured from the API, not a file). */
    async ensureTunnel(accountId: string, name: string): Promise<Tunnel & { created: boolean }> {
      const existing = await call<Tunnel[]>("GET", `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
      if (existing[0]) return { id: existing[0].id, name: existing[0].name, created: false };
      const tunnel = await call<Tunnel>("POST", `/accounts/${accountId}/cfd_tunnel`, { name, config_src: "cloudflare" });
      return { id: tunnel.id, name: tunnel.name, created: true };
    },

    /** Replaces the tunnel's ingress: each hostname to its service, anything else 404. */
    putIngress: (accountId: string, tunnelId: string, rules: IngressRule[]) =>
      call<unknown>("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: { ingress: [...rules, { service: "http_status:404" }] },
      }),

    /** The record that `name` has now, if any (to ask before replacing one that isn't ours). */
    async findRecord(zoneId: string, name: string): Promise<DnsRecord | null> {
      const records = await call<DnsRecord[]>("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      return records[0] ?? null;
    },

    /** Points `name` at the tunnel (proxied CNAME), replacing whatever record it had. */
    async upsertCname(zoneId: string, name: string, tunnelId: string) {
      const record = { type: "CNAME", name, content: `${tunnelId}.cfargotunnel.com`, proxied: true, comment: "mybase tunnel" };
      const existing = await call<DnsRecord[]>("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      if (existing[0]) await call("PUT", `/zones/${zoneId}/dns_records/${existing[0].id}`, record);
      else await call("POST", `/zones/${zoneId}/dns_records`, record);
    },

    /** The token `cloudflared tunnel run` needs (CLOUDFLARE_TUNNEL_TOKEN). */
    tunnelToken: (accountId: string, tunnelId: string) => call<string>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`),
  };
}

export type Cloudflare = ReturnType<typeof cloudflare>;

/** Whether a DNS record already points at `tunnelId`. */
export const pointsAtTunnel = (record: { content: string }, tunnelId: string) => record.content === `${tunnelId}.cfargotunnel.com`;

/** The zone `host` belongs to: the longest zone name that is `host` or a parent of it. */
export function zoneOf<Z extends { name: string }>(zones: Z[], host: string): Z | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  let best: Z | null = null;
  for (const zone of zones) {
    const z = zone.name.toLowerCase();
    if ((name === z || name.endsWith(`.${z}`)) && z.length > (best?.name.length ?? -1)) best = zone;
  }
  return best;
}

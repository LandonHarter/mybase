// Just enough of Cloudflare's API to set up a tunnel for `mybase server setup|tunnel`: a remotely
// managed tunnel, its ingress rules, and proxied CNAMEs. The API token is used for this and never saved.

const API = "https://api.cloudflare.com/client/v4";

/** What the API token needs, shown before asking for it. */
export const TOKEN_PERMISSIONS = ["Account › Cloudflare Tunnel › Edit", "Zone › DNS › Edit", "Zone › Zone › Read"];

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

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

export interface IngressRule {
  hostname: string;
  service: string;
}

export class CloudflareError extends Error {}

export function cloudflare(token: string, fetcher: typeof fetch = fetch) {
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
      if (res.status === 401 || res.status === 403) throw new CloudflareError(`Cloudflare refused the token (${message}). It needs: ${TOKEN_PERMISSIONS.join(", ")}.`);
      throw new CloudflareError(`Cloudflare: ${message}`);
    }
    return data.result as T;
  }

  return {
    listAccounts: () => call<Account[]>("GET", "/accounts?per_page=50"),

    listZones: () => call<Zone[]>("GET", "/zones?per_page=50&status=active"),

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

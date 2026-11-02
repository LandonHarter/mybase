// Which addresses outbound calls that projects aim (cron jobs + tasks, realtime webhooks) may reach.
//
// Those URLs come from API keys, which apps hold, and the API sits next to Postgres, Garage's
// admin API, Valkey, the registry, and the workers, and on a cloud VM next to the metadata
// service. Cron stores the start of each answer, so an unchecked URL would let a key read
// internal services. Always refused: loopback, link-local (cloud metadata), unspecified,
// multicast, and mybase's own services. `MYBASE_OUTBOUND=public` also refuses private and LAN
// addresses (recommended on a cloud server); the default `lan` allows them, for apps at home.
// `any` turns the checks off; it's the default outside production (`bun run dev`), where
// jobs call apps on localhost.
//
// Checked right before each call. Fetch resolves the name again when it connects, so DNS
// rebinding can still slip through (see search-fetch.ts); this closes the plain cases.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIp } from "./search-fetch";

export function outboundMode(): "public" | "lan" | "any" {
  const mode = process.env.MYBASE_OUTBOUND;
  if (mode === "public" || mode === "lan" || mode === "any") return mode;
  return process.env.NODE_ENV === "production" ? "lan" : "any";
}

const hostOf = (url: string | undefined) => {
  if (!url || url.startsWith("unix:")) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
};

/** mybase's own services by the names compose gives them, plus whatever the env points at. */
function internalHosts(): string[] {
  const env = process.env;
  const names = [
    "postgres", "garage", "valkey", "searxng", "registry", "caddy", "hosting-worker", "sandbox-worker", "cloudflared", "mybase",
    env.POSTGRES_HOST, env.VALKEY_HOST,
    hostOf(env.GARAGE_ADMIN_URL), hostOf(env.GARAGE_S3_URL), hostOf(env.SEARXNG_URL), hostOf(env.MYBASE_REGISTRY_URL),
    hostOf(env.MYBASE_HOSTING_WORKER_URL), hostOf(env.MYBASE_SANDBOX_WORKER_URL), hostOf(env.MYBASE_CADDY_ADMIN),
  ];
  return [...new Set(names.filter((n): n is string => Boolean(n) && n !== "localhost"))];
}

let internal: { at: number; addresses: Set<string> } | null = null;

/** Addresses of mybase's own services, re-resolved every minute (containers get new IPs on restart). */
async function internalAddresses(): Promise<Set<string>> {
  if (internal && Date.now() - internal.at < 60_000) return internal.addresses;
  const addresses = new Set<string>();
  await Promise.all(
    internalHosts().map(async (host) => {
      if (isIP(host)) return void addresses.add(host);
      const found = await lookup(host, { all: true, verbatim: true }).catch(() => []);
      for (const a of found) addresses.add(a.address);
    }),
  );
  internal = { at: Date.now(), addresses };
  return addresses;
}

/** Loopback, link-local, unspecified, multicast: never a project's webhook. */
function neverAllowed(ip: string): boolean {
  let v = ip.toLowerCase().replace(/^::ffff:/, "");
  // IPv4-mapped in hex (`::ffff:7f00:1`, how URLs spell it): back to dotted.
  const hex = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    v = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number) as [number, number];
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  return v === "::" || v === "::1" || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff") || v.startsWith("fd00:ec2:");
}

/** Why `url` may not be called, or null when it may. Never throws. */
export async function outboundBlocked(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "only http(s) urls can be called";
  if (outboundMode() === "any") return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return `couldn't resolve ${host}`;
    }
  }
  if (addresses.length === 0) return `couldn't resolve ${host}`;
  const own = await internalAddresses();
  for (const ip of addresses) {
    if (neverAllowed(ip) || own.has(ip)) return `${host} is a local or internal address, which projects can't call`;
    if (outboundMode() === "public" && !isPublicIp(ip)) return `${host} isn't a public address (MYBASE_OUTBOUND=public)`;
  }
  return null;
}

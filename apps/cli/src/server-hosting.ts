// `mybase server hosting`: turns on the hosting containers (registry, Caddy, worker) on this
// machine, sets the base domain, and, behind a Cloudflare Tunnel, routes *.<domain> to Caddy
// with one wildcard DNS record + tunnel rule. The Cloudflare token is used once, not saved.
import * as p from "@clack/prompts";
import { join } from "node:path";
import { styleText } from "node:util";
import { cloudflare, CloudflareError, mergeIngress, pointsAtTunnel, TOKEN_PERMISSIONS, TOKEN_URL, zoneOf } from "./cloudflare";
import { CliError, jsonMode, print, usageError } from "./output";
import { compose } from "./server-docker";
import { composeProfile, mergeEnv, parseEnv, tunnelIdFromToken } from "./server-env";
import { flag, serverDir, startStack, ui } from "./server-setup";

export const LOCAL_HOSTING_WORKER = "http://hosting-worker:4020";
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const hostingProfileOn = (values: Record<string, string>) => (values.COMPOSE_PROFILES ?? "").split(",").some((s) => s.trim() === "hosting");

/** A guess at the base domain: the zone part of MYBASE_PUBLIC_URL (`mybase.example.com` → `example.com`). */
export function guessDomain(values: Record<string, string>): string | null {
  try {
    const host = new URL(values.MYBASE_PUBLIC_URL ?? "").hostname;
    const parts = host.split(".");
    return parts.length >= 3 && DOMAIN.test(host) ? parts.slice(1).join(".") : null;
  } catch {
    return null;
  }
}

/** The .env changes that turn hosting on. Keeps an existing worker key. */
export function hostingSettings(values: Record<string, string>, domain: string | null): Record<string, string | null> {
  const key = values.MYBASE_HOSTING_WORKER_KEY || Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  return {
    COMPOSE_PROFILES: composeProfile(values.COMPOSE_PROFILES, "hosting", true),
    MYBASE_HOSTING_WORKER_URL: LOCAL_HOSTING_WORKER,
    MYBASE_HOSTING_WORKER_KEY: key,
    MYBASE_HOSTING_DOMAIN: domain,
  };
}

async function ask<T>(answer: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await answer;
  if (p.isCancel(value)) throw new CliError("cancelled; nothing changed");
  return value as Exclude<T, symbol>;
}

/** Routes *.<domain> through the tunnel to Caddy. Returns false when skipped. */
async function routeWildcard(tunnelToken: string, domain: string, apiToken: string | undefined, interactive: boolean): Promise<boolean> {
  const tunnelId = tunnelIdFromToken(tunnelToken);
  if (!tunnelId) throw new CliError("CLOUDFLARE_TUNNEL_TOKEN in .env isn't a tunnel token");
  let token = apiToken;
  if (!token) {
    if (!interactive) return false;
    ui.note(
      [`Same token as the tunnel setup: ${TOKEN_URL}`, ...TOKEN_PERMISSIONS.map((perm) => `  • ${perm}`), "", "Used now to add *." + domain + ", not saved."].join("\n"),
      "Cloudflare API token",
    );
    token = (await ask(p.password({ message: "Cloudflare API token (empty to skip)" }))).trim();
    if (!token) return false;
  }
  const cf = cloudflare(token);
  const zone = zoneOf(await cf.listZones(), domain);
  if (!zone) throw new CliError(`${domain} isn't an active zone on this Cloudflare token`);
  if (zone.name !== domain) ui.warn(`${domain} is under ${zone.name}: Cloudflare's free certificate only covers one level (*.${zone.name}), so https://<site>.${domain} needs Advanced Certificate Manager.`);
  const wildcard = `*.${domain}`;
  const record = await cf.findRecord(zone.id, wildcard).catch(() => null);
  if (record && !pointsAtTunnel(record, tunnelId)) {
    if (!interactive) throw new CliError(`${wildcard} already points at ${record.content}; replace it by hand or rerun in a terminal`);
    const replace = await ask(p.confirm({ message: `${wildcard} already points at ${record.content}. Replace it?`, initialValue: false }));
    if (!replace) return false;
  }
  const current = await cf.getIngress(zone.account.id, tunnelId);
  await cf.putIngress(zone.account.id, tunnelId, mergeIngress(current, [{ hostname: wildcard, service: "http://caddy:80" }]));
  await cf.upsertCname(zone.id, wildcard, tunnelId);
  return true;
}

export async function setupHostingServer(args: string[]) {
  const dir = await serverDir(args);
  const envFile = Bun.file(join(dir, ".env"));
  if (!(await envFile.exists())) throw new CliError(`no mybase server in ${dir}. Run \`mybase server setup\` (or pass --dir).`, 4);
  const text = await envFile.text();
  const values = parseEnv(text);
  const interactive = !jsonMode && process.stdin.isTTY === true;
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${styleText("dim", "server hosting")}`);

  if (args.includes("--off")) {
    await Bun.write(join(dir, ".env"), mergeEnv(text, { COMPOSE_PROFILES: composeProfile(values.COMPOSE_PROFILES, "hosting", false), MYBASE_HOSTING_WORKER_URL: null }));
    // Sites keep running in Docker until their projects turn hosting off; stop the routing. The
    // registry stays when its own profile is on (`mybase server registry`).
    const registryOwn = (values.COMPOSE_PROFILES ?? "").split(",").some((s) => s.trim() === "registry");
    await compose(dir, ["--profile", "hosting", "rm", "-sf", "caddy", "hosting-worker", ...(registryOwn ? [] : ["registry"])]);
    await startStack(dir, values, false);
    return print({ dir, hosting: false }, () => p.outro("Hosting off: sites aren't reachable. Turn it off per project to remove their containers."));
  }

  let domain = flag(args, "--domain")?.toLowerCase() ?? null;
  if (!domain && interactive) {
    const guess = values.MYBASE_HOSTING_DOMAIN || guessDomain(values) || "";
    domain = (await ask(p.text({ message: "Base domain for sites (<site>.<domain>); empty for LAN only", placeholder: "example.com", defaultValue: guess, initialValue: guess }))).trim().toLowerCase() || null;
  } else if (!domain) domain = values.MYBASE_HOSTING_DOMAIN || null;
  if (domain && !DOMAIN.test(domain)) throw usageError(`"${domain}" isn't a domain name`);

  const updates = hostingSettings(values, domain);
  let routed = false;
  if (domain && values.CLOUDFLARE_TUNNEL_TOKEN) {
    try {
      routed = await routeWildcard(values.CLOUDFLARE_TUNNEL_TOKEN, domain, flag(args, "--cf-token") ?? process.env.CLOUDFLARE_API_TOKEN, interactive);
    } catch (err) {
      throw new CliError(err instanceof CloudflareError ? err.message : (err as Error).message);
    }
  }
  await Bun.write(join(dir, ".env"), mergeEnv(text, updates));
  const version = await startStack(dir, values);
  const url = domain ? `https://<site>.${domain}` : `http://<site>.localhost:${values.MYBASE_HOSTING_PORT || "80"}`;
  print({ dir, version, hosting: true, domain, wildcardRouted: routed }, () => {
    if (domain && values.CLOUDFLARE_TUNNEL_TOKEN && !routed) ui.warn(`*.${domain} isn't routed yet. In the tunnel's public hostnames, add *.${domain} → http://caddy:80, and a proxied CNAME *.${domain} → <tunnel id>.cfargotunnel.com. Or rerun with --cf-token.`);
    if (domain && !values.CLOUDFLARE_TUNNEL_TOKEN) ui.info(`No tunnel: point *.${domain} at this machine yourself (port ${values.MYBASE_HOSTING_PORT || "80"}, plain HTTP), or run mybase server tunnel first.`);
    p.outro(`Hosting is on. Sites answer at ${url}. Next: mybase hosting enable <project>, then mybase deploy.`);
  });
}

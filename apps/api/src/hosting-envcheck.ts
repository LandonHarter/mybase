// Deploy-time env check: before a new site container takes traffic, every env value that's a URL
// with a host (DATABASE_URL, REDIS_URL, S3_ENDPOINT, …) is tried from the project network. A dead
// address (the old machine's public IP, a closed port forward, `localhost`) shows up in the deploy
// instead of as a 500 at runtime. Warn only, unless the site sets `strictEnvCheck`.
//
// Pure: the probing happens in the hosting worker. Messages carry key names and host:port only,
// never values (so never passwords).
import { HOSTING_MANAGED_ENV, type LinkService } from "@mybase/shared";

export interface EnvTarget {
  key: string;
  host: string;
  port: number;
  /** `localhost` inside a container is the container itself: no need to probe. */
  loopback: boolean;
  /** This project's service the value most likely means, for the fix. */
  service: LinkService | null;
}

const DEFAULT_PORTS: Record<string, number> = {
  "postgres:": 5432,
  "postgresql:": 5432,
  "redis:": 6379,
  "rediss:": 6379,
  "http:": 80,
  "https:": 443,
  "mysql:": 3306,
  "mongodb:": 27017,
  "amqp:": 5672,
  "amqps:": 5671,
  "nats:": 4222,
};

const MAX_TARGETS = 20;

function serviceOf(key: string, url: URL): LinkService | null {
  if (url.protocol === "postgres:" || url.protocol === "postgresql:") return "database";
  if (url.protocol === "redis:" || url.protocol === "rediss:") return "cache";
  if (/S3|STORAGE|BUCKET/i.test(key) || url.port === "3900") return "storage";
  if (/^MYBASE_(API_)?URL$/i.test(key)) return "api";
  return null;
}

/** The env values worth probing, deduplicated by host:port (first key wins). */
export function envTargets(env: Record<string, string>): EnvTarget[] {
  const skip = new Set<string>(HOSTING_MANAGED_ENV);
  const seen = new Set<string>();
  const out: EnvTarget[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (skip.has(key) || out.length >= MAX_TARGETS) continue;
    const value = raw.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]/i.test(value)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || DEFAULT_PORTS[url.protocol];
    if (!host || !port) continue;
    const id = `${host}:${port}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, host, port, loopback: /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i.test(host), service: serviceOf(key, url) });
  }
  return out;
}

const NAMES: Record<LinkService, string> = { database: "Postgres", cache: "cache (Valkey)", storage: "storage (S3)", api: "mybase API" };

/**
 * One warning for a target the site can't reach. `internal` = this project's services as the
 * site reaches them (`postgres:5432`, …); `secretsEnv` = the site's secrets env, if any.
 */
export function envWarning(t: EnvTarget, opts: { project: string; site: string; secretsEnv: string | null; internal: Partial<Record<LinkService, string>> }): string {
  const lines = [
    t.loopback
      ? `${t.key} → ${t.host}:${t.port}: inside the container, ${t.host} is the site itself, not the mybase server.`
      : `${t.key} → ${t.host}:${t.port} unreachable from site network.`,
  ];
  const where = t.service ? opts.internal[t.service] : undefined;
  if (t.service && where) {
    lines.push(`This project's ${NAMES[t.service]} is reachable here as ${where}. Run:`);
    const flag = t.service === "storage" ? "--storage" : `--${t.service}${linkAs(t)}`;
    if (opts.secretsEnv) {
      lines.push(`  mybase secrets link -p ${opts.project} -e ${opts.secretsEnv} ${flag}`);
    } else {
      lines.push(`  mybase hosting set ${opts.project} ${opts.site} --secrets-env prod`, `  mybase secrets link -p ${opts.project} -e prod ${flag}`);
    }
    lines.push(`  mybase hosting redeploy ${opts.project} ${opts.site}`);
  } else {
    lines.push("Check the address: sites reach the internet, and this project's services by name (postgres, valkey, garage, mybase).");
  }
  return lines.join("\n");
}

/** `--as KEY` when the key isn't the link's default name. */
function linkAs(t: EnvTarget): string {
  // Only single-key links take --as (storage and api link several keys).
  const defaults: Partial<Record<LinkService, string>> = { database: "DATABASE_URL", cache: "REDIS_URL" };
  return t.service && defaults[t.service] && defaults[t.service] !== t.key ? ` --as ${t.key}` : "";
}

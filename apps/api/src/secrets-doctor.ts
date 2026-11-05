// `mybase secrets doctor`: finds literal values that are really this project's own service
// credentials (hand-pasted connection strings), so they can become links that follow the server
// (secrets-resolve.ts). Pure; findings carry key names and hosts, never values.
import type { LinkService, SecretsDoctorFinding } from "@mybase/shared";

export interface DoctorFacts {
  /** The project's Garage access key ids. */
  storageKeyIds: string[];
  /** Every URL the mybase API is reachable at (all routes). */
  apiUrls: string[];
}

function parse(value: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/** The database name in a postgres URL's path. */
const dbName = (url: URL) => decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");

export function findOwnCredentials(project: string, env: string, values: Record<string, string>, facts: DoctorFacts): SecretsDoctorFinding[] {
  const out: SecretsDoctorFinding[] = [];
  const add = (key: string, service: LinkService, reason: string, host: string | null) => out.push({ env, key, service, reason, host });
  for (const [key, value] of Object.entries(values)) {
    const url = parse(value);
    if (url) {
      const user = decodeURIComponent(url.username);
      if (/^postgres(ql)?:$/.test(url.protocol) && (user === project || dbName(url) === project)) {
        add(key, "database", user === project ? `connects as the "${project}" role` : `uses the "${project}" database`, url.hostname);
        continue;
      }
      if (/^rediss?:$/.test(url.protocol) && user === project) {
        add(key, "cache", `connects as the "${project}" cache user`, url.hostname);
        continue;
      }
      const origin = `${url.protocol}//${url.host}`;
      if (/^https?:$/.test(url.protocol) && facts.apiUrls.some((u) => u.replace(/\/$/, "") === value.replace(/\/$/, "") || u === origin) && /MYBASE_(API_)?URL/i.test(key)) {
        add(key, "api", "is this mybase server's API URL", url.hostname);
        continue;
      }
    }
    if (facts.storageKeyIds.includes(value.trim())) add(key, "storage", "is this project's S3 access key id", null);
  }
  return out;
}

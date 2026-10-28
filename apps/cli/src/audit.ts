// `mybase audit …`: who did what (sign-ins, key and project changes, secret reads).
import type { AuditEventList, AuditEventRecord, AuditSettings } from "@mybase/shared";
import { api } from "./api";
import { flagInt, flagString, parseArgs } from "./cron";
import { jsonMode, print, usageError } from "./output";

export const auditUsage = `  audit [--project p] [--action auth|auth.login] [--outcome ok|denied|failed] [--since 24h|7d|<ISO date>] [--limit n] [--follow]
                                 Recent audit log entries, newest first (--follow: keep printing new ones)
  audit retention [<days>]       Show (or set, 7–365, admin key) how long entries are kept`;

/** `24h`, `7d`, `30m`, or an ISO date → ISO date. */
export function sinceDate(value: string, now = Date.now()): string {
  const m = /^(\d+)(m|h|d)$/.exec(value);
  if (m) return new Date(now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]).toISOString();
  if (Number.isNaN(Date.parse(value))) throw usageError(`--since must be like 24h, 7d, or a date (got "${value}")`);
  return new Date(value).toISOString();
}

const actorLabel = (e: AuditEventRecord) =>
  e.actor.kind === "token" ? `key "${e.actor.name}"` : e.actor.kind === "session" ? (e.actor.name ?? "admin") : e.actor.kind === "system" ? "mybase" : e.actor.name ? `${e.actor.name} (not signed in)` : "anonymous";

export function formatEvent(e: AuditEventRecord): string {
  const where = [e.project && `[${e.project}]`, e.target].filter(Boolean).join(" ");
  const meta = e.meta ? ` ${Object.entries(e.meta).map(([k, v]) => `${k}=${v}`).join(" ")}` : "";
  return `${e.at.replace("T", " ").slice(0, 19)}  ${e.outcome.padEnd(6)}  ${e.action.padEnd(24)}  ${actorLabel(e)}${e.ip ? ` from ${e.ip}` : ""}${where ? `  ${where}` : ""}${meta}`;
}

/** Handles `mybase audit …`. */
export async function audit(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  if (positional[0] === "retention") {
    const days = positional[1];
    const settings = days
      ? await api<AuditSettings>("/audit/settings", { method: "PUT", body: JSON.stringify({ retentionDays: Number(days) }) })
      : await api<AuditSettings>("/audit/settings");
    print(settings, () => console.log(`Audit entries are kept for ${settings.retentionDays} days.`));
    return;
  }
  if (positional.length) throw usageError(`unknown: mybase audit ${positional[0]}\n\n${auditUsage}`);

  const query = new URLSearchParams();
  for (const name of ["project", "action", "outcome", "actor"]) {
    const value = flagString(flags, name);
    if (value) query.set(name, value);
  }
  const since = flagString(flags, "since");
  if (since) query.set("since", sinceDate(since));
  query.set("limit", String(flagInt(flags, "limit") ?? 50));

  const page = await api<AuditEventList>(`/audit?${query}`);
  if (!flags.has("follow")) {
    print(page, () => {
      if (page.events.length === 0) console.log("No audit entries match.");
      for (const e of [...page.events].reverse()) console.log(formatEvent(e));
    });
    return;
  }

  // Follow: print the latest, then poll for newer ones (ids only grow).
  let last = page.events[0]?.id ?? "0";
  const show = (events: AuditEventRecord[]) => {
    for (const e of [...events].reverse()) console.log(jsonMode ? JSON.stringify(e) : formatEvent(e));
  };
  show(page.events);
  query.delete("since");
  for (;;) {
    await Bun.sleep(5000);
    const fresh = await api<AuditEventList>(`/audit?${query}`);
    const newer = fresh.events.filter((e) => BigInt(e.id) > BigInt(last));
    if (newer.length) {
      show(newer);
      last = newer[0]!.id;
    }
  }
}

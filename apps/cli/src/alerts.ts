// `mybase alerts …`: where security alerts go (webhooks, ntfy) and which rules are on.
import type { AlertChannel, AlertsOverview } from "@mybase/shared";
import { api } from "./api";
import { flagString, parseArgs } from "./cron";
import { confirm, print, usageError } from "./output";

export const alertsUsage = `  alerts                         Alert channels and rules (admin key)
  alerts add webhook|ntfy <url> [--name n] [--token t]  Send alerts to a webhook (signed) or an ntfy topic URL
  alerts test <channel-id>       Send a test alert and wait for the result
  alerts remove <channel-id> [--yes]  Stop sending alerts there
  alerts rotate <channel-id>     New webhook signing secret
  alerts rule <rule> on|off      Turn one rule on or off (rule ids: see \`mybase alerts\`)`;

function printChannel(c: AlertChannel) {
  const state = c.enabled ? "" : " (paused)";
  console.log(`  ${c.id}  ${c.kind.padEnd(7)}  ${c.name}${state}`);
  console.log(`      ${c.url}${c.lastError ? `  last error: ${c.lastError}` : c.lastSentAt ? `  last sent ${c.lastSentAt}` : ""}`);
  if (c.secret) console.log(`      signing secret ${c.secret}  (verify with verifyCronSignature from @mybase-dev/sdk/cron)`);
}

/** Handles `mybase alerts …`. */
export async function alerts(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub, a, b] = positional;
  switch (sub) {
    case undefined: {
      const o = await api<AlertsOverview>("/alerts");
      print(o, () => {
        console.log("Channels:");
        if (o.channels.length === 0) console.log("  None. Add one with: mybase alerts add ntfy https://ntfy.sh/<topic>");
        for (const c of o.channels) printChannel(c);
        console.log("\nRules:");
        for (const r of o.rules) console.log(`  ${r.enabled ? "on " : "off"}  ${r.id.padEnd(24)}  ${r.description}`);
      });
      return;
    }
    case "add": {
      if ((a !== "webhook" && a !== "ntfy") || !b) throw usageError(`usage: mybase alerts add webhook|ntfy <url>\n\n${alertsUsage}`);
      const c = await api<AlertChannel>("/alerts/channels", {
        method: "POST",
        body: JSON.stringify({ kind: a, url: b, name: flagString(flags, "name"), token: flagString(flags, "token") }),
      });
      print(c, () => {
        console.log(`Added ${c.kind} channel "${c.name}"`);
        printChannel(c);
        console.log(`\nTry it: mybase alerts test ${c.id}`);
      });
      return;
    }
    case "test": {
      if (!a) throw usageError("missing channel id");
      const r = await api<{ ok: boolean; error: string | null }>(`/alerts/channels/${encodeURIComponent(a)}/test`, { method: "POST" });
      print(r, () => console.log(r.ok ? "Sent. Check that it arrived." : `Not delivered: ${r.error}`));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "remove": {
      if (!a) throw usageError("missing channel id");
      confirm(args.includes("--yes"), `Alerts will no longer be sent to channel ${a}.`, a, "the channel id");
      await api(`/alerts/channels/${encodeURIComponent(a)}`, { method: "DELETE" });
      print({ removed: a }, () => console.log(`Removed channel ${a}`));
      return;
    }
    case "rotate": {
      if (!a) throw usageError("missing channel id");
      const c = await api<AlertChannel>(`/alerts/channels/${encodeURIComponent(a)}/secret/rotate`, { method: "POST" });
      print(c, () => {
        console.log("Rotated. The old secret stops working now.");
        printChannel(c);
      });
      return;
    }
    case "rule": {
      if (!a || (b !== "on" && b !== "off")) throw usageError("usage: mybase alerts rule <rule> on|off");
      const o = await api<AlertsOverview>(`/alerts/rules/${encodeURIComponent(a)}`, { method: "PUT", body: JSON.stringify({ enabled: b === "on" }) });
      print(o.rules.find((r) => r.id === a), () => console.log(`Rule ${a} is ${b}.`));
      return;
    }
  }
  throw usageError(`unknown: mybase alerts ${sub}\n\n${alertsUsage}`);
}

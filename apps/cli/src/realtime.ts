// `mybase realtime …`: WebSocket channels for apps whose host can't hold sockets.
import type { ChannelInfo, RealtimeSettings, RealtimeStats, UpdateRealtimeSettingsRequest } from "@mybase/shared";
import { api } from "./api";
import { flagInt, flagString, need, parseArgs } from "./cron";
import { confirm, print, usageError } from "./output";
import { enableService, printLinked } from "./service-enable";

export const realtimeUsage = `  realtime enable <project>      Turn on realtime and print the socket URL and secret
  realtime info <project>        Settings, connections, and messages in the last 24 hours
  realtime key <project> [--rotate]  Show (or replace) the secret that signs browser tokens and webhooks
                                 (rotating closes every open connection)
  realtime settings <project> [--origins a,b|none] [--public on|off] [--webhook <url>|none]
                                 [--events message,presence,channel] [--max-connections n]
                                 [--max-channels n] [--max-message-bytes n] [--max-rate n]
  realtime channels <project> [--prefix p]   Channels with subscribers right now
  realtime publish <project> <channel> <event> [json]   Send a message to everyone subscribed
  realtime disable <project> [--yes]  Turn it off (closes every connection)`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/realtime`;

function printSettings(s: RealtimeSettings) {
  console.log(`  socket      ${s.socketUrl}  (connectRealtime in @mybase-dev/sdk/realtime)`);
  console.log(`  publish     POST ${s.publishUrl}  (realtime:write key)`);
  console.log(`  secret      ${s.secret}  (server-side only: MYBASE_REALTIME_SECRET)`);
  console.log(`  public      ${s.publicChannels ? "on: public:… channels need no token" : "off: every connection needs a token"}`);
  console.log(`  origins     ${s.allowedOrigins.length ? s.allowedOrigins.join(", ") : "any"}`);
  console.log(`  webhook     ${s.webhookUrl ? `${s.webhookUrl} (${s.webhookEvents.join(", ") || "no events"})` : "none"}`);
  console.log(`  limits      ${s.maxConnections} connections, ${s.maxChannels} channels each, ${s.maxMessageBytes} B frames, ${s.maxRate}/s`);
}

const list = (value: string) => (value === "none" ? [] : value.split(",").map((v) => v.trim()).filter(Boolean));

function onOff(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on" || value === "off") return value === "on";
  throw usageError(`--${name} takes on or off`);
}

/** Handles `mybase realtime <sub> …`. False when `sub` isn't a realtime command. */
export async function realtime(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, channel, event, data] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "realtime", flags);
      const s = await api<RealtimeSettings>(base(p));
      print({ enabled: "realtime", project: p, linked, ...s }, () => {
        console.log(`Realtime enabled for "${p}"\n`);
        printSettings(s);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "info": {
      const p = need(project, "project name");
      const [s, stats] = await Promise.all([api<RealtimeSettings>(base(p)), api<RealtimeStats>(`${base(p)}/stats`)]);
      const { secret: _secret, ...settings } = s;
      print({ ...settings, stats }, () => {
        printSettings({ ...s, secret: "(mybase realtime key)" });
        const out = stats.hours.reduce((n, h) => n + h.messagesOut, 0);
        console.log(`\n  now         ${stats.connections} connections (peak ${stats.peakConnections}), ${stats.channels} channels`);
        console.log(`  24 hours    ${out} messages delivered`);
        if (stats.webhook.lastError) console.log(`  webhook     failing: ${stats.webhook.lastError} (${stats.webhook.queued} queued, ${stats.webhook.dropped} dropped)`);
      });
      return true;
    }
    case "key": {
      const p = need(project, "project name");
      if (flags.has("rotate")) confirm(args.includes("--yes"), `Every open realtime connection on "${p}" closes, and tokens signed with the old secret stop working.`, p, "the project name");
      const s = flags.has("rotate") ? await api<RealtimeSettings>(`${base(p)}/secret/rotate`, { method: "POST" }) : await api<RealtimeSettings>(base(p));
      print({ secret: s.secret }, () => {
        if (flags.has("rotate")) console.log("Rotated. Update MYBASE_REALTIME_SECRET where your server signs tokens.\n");
        console.log(s.secret);
      });
      return true;
    }
    case "settings": {
      const p = need(project, "project name");
      const body: UpdateRealtimeSettingsRequest = {};
      const origins = flagString(flags, "origins");
      if (origins !== undefined) body.allowedOrigins = list(origins);
      const pub = onOff(flagString(flags, "public"), "public");
      if (pub !== undefined) body.publicChannels = pub;
      const webhook = flagString(flags, "webhook");
      if (webhook !== undefined) body.webhookUrl = webhook === "none" ? null : webhook;
      const events = flagString(flags, "events");
      if (events !== undefined) body.webhookEvents = list(events) as UpdateRealtimeSettingsRequest["webhookEvents"];
      const ints = { maxConnections: "max-connections", maxChannels: "max-channels", maxMessageBytes: "max-message-bytes", maxRate: "max-rate" } as const;
      for (const [key, flag] of Object.entries(ints)) {
        const n = flagInt(flags, flag);
        if (n !== undefined) body[key as keyof typeof ints] = n;
      }
      const s = Object.keys(body).length ? await api<RealtimeSettings>(base(p), { method: "PATCH", body: JSON.stringify(body) }) : await api<RealtimeSettings>(base(p));
      const { secret: _secret, ...shown } = s;
      print(shown, () => printSettings({ ...s, secret: "(mybase realtime key)" }));
      return true;
    }
    case "channels": {
      const p = need(project, "project name");
      const prefix = flagString(flags, "prefix");
      const { channels } = await api<{ channels: ChannelInfo[] }>(`${base(p)}/channels${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`);
      print(channels, () => {
        if (!channels.length) return console.log("No channels have subscribers right now.");
        for (const c of channels) console.log(`${c.channel}  ${c.subscribers} subscribers${c.members === undefined ? "" : `, ${c.members} members`}`);
      });
      return true;
    }
    case "publish": {
      const p = need(project, "project name");
      let payload: unknown = null;
      if (data !== undefined) {
        try {
          payload = JSON.parse(data);
        } catch {
          payload = data;
        }
      }
      const { ids } = await api<{ ids: string[] }>(`${base(p)}/publish`, {
        method: "POST",
        body: JSON.stringify({ channel: need(channel, "channel"), event: need(event, "event"), data: payload }),
      });
      print({ id: ids[0] }, () => console.log(`Published ${event} to ${channel}`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(args.includes("--yes"), `Every open realtime connection on "${p}" closes, and pages listening for updates stop getting them.`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/realtime`, { method: "DELETE" });
      print({ disabled: "realtime", project: p }, () => console.log(`Realtime disabled for "${p}"`));
      return true;
    }
  }
  return false;
}

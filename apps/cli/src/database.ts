// `mybase database access`: every way the project's database can be reached (hosting network,
// the server itself, LAN, Tailscale, the internet, the WebSocket proxy), and turning internet
// access on or off (`--public`, which runs `server database-public` on this machine).
// Linked DATABASE_URLs (`secrets link --database`) follow whatever this shows.
import type { DatabaseAccess } from "@mybase/shared";
import { api } from "./api";
import { need, parseArgs } from "./cron";
import { confirm, jsonMode, print, usageError } from "./output";
import { databasePublic } from "./server";

export const databaseUsage = `  database access <project>      How the database is reached: hosting network, server, LAN, Tailscale,
                                 public, WebSocket proxy (hosts and ports; no secrets)
    [--public on|off] [--yes]    Turn internet access on/off (runs \`server database-public\`, so on the
                                 server; on also takes its --host/--dns-token/--email/--staging/--dir)`;

const LABELS: Record<string, string> = {
  internal: "hosting network",
  localhost: "server localhost",
  lan: "LAN",
  tailscale: "Tailscale",
  public: "public",
  proxy: "wss proxy",
};

export function accessTable(a: DatabaseAccess): string[] {
  return a.routes.map((r) => {
    const where = r.route === "proxy" ? a.wsUrl : r.host ? `${r.host}:${r.port}` : "";
    return `${(LABELS[r.route] ?? r.route).padEnd(17)} ${(r.on ? "on" : "off").padEnd(4)} ${where.padEnd(32)} ${r.note ?? ""}`.trimEnd();
  });
}

const show = (a: DatabaseAccess) =>
  print(a, () => {
    console.log(`Database access for "${a.project}":\n`);
    for (const line of accessTable(a)) console.log(`  ${line}`);
    console.log(`\nLinked DATABASE_URLs pick a route per reader. Link one: mybase secrets link -p ${a.project} -e <env> --database`);
  });

/** `mybase database <sub> …`. False when `sub` isn't a database command. */
export async function database(sub: string, args: string[]): Promise<boolean> {
  if (sub !== "access") return false;
  const { positional, flags } = parseArgs(args);
  const project = need(positional[0], "project name");
  const path = `/projects/${encodeURIComponent(project)}/database/access`;
  const mode = flags.get("public");
  if (mode === undefined) {
    show(await api<DatabaseAccess>(path));
    return true;
  }
  if (mode !== "on" && mode !== "off") throw usageError("--public takes on or off");
  // Flags for `server database-public`, minus ours.
  const rest = args.filter((a, i) => a !== project && a !== "--public" && args[i - 1] !== "--public" && a !== "--yes");
  if (mode === "on") {
    confirm(
      flags.has("yes"),
      [
        "Warning: this opens Postgres to the internet (router port forward + TLS).",
        `Every project's connection string logs in as its owner role, so anyone holding "${project}"'s DATABASE_URL can read and change all of its data from anywhere.`,
        "Only project roles are let in, only to their own database, only over TLS; superusers never. Prefer `mybase db proxy` (or `mybase run`) when only you need access.",
      ].join("\n"),
      project,
      "the project name",
    );
    await databasePublic(rest);
  } else {
    await databasePublic([...rest, "--off"]);
  }
  if (!jsonMode) console.log("");
  show(await api<DatabaseAccess>(path));
  return true;
}

// `mybase server …`: install and run mybase itself on this machine (Docker Compose in ~/mybase).
// The setup wizard is in server-setup.ts; these are the day-two commands around it.
import * as p from "@clack/prompts";
import { join } from "node:path";
import { styleText } from "node:util";
import type { DbPublicStatus } from "@mybase/shared";
import { api, CLI_VERSION } from "./api";
import { CliError, jsonMode, print, usageError } from "./output";
import { addresses, compose, dockerOnBoot, waitHealthy } from "./server-docker";
import { mergeEnv, parseEnv, tunnelEnv, tunnelIdFromToken } from "./server-env";
import { DB_PUBLIC_KEYS, dbPublicStep, flag, localUrl, serverDir, setup, startStack, tunnelStep, turnOnDockerAtBoot, ui, writeCompose } from "./server-setup";

export const serverUsage = `  server setup [--dir <dir>]     Install mybase on this machine: checks Docker, generates keys, sets up
                                 LAN/Tailscale access, a Cloudflare Tunnel, start on boot, and the admin
    [--yes] [--public-host <h>] [--tunnel-token <t> --domain <d>] [--port <n>] [--no-autostart]
    [--admin-user <u> --admin-password-stdin]   Without a terminal: defaults plus these flags
  server status [--dir <dir>]    Containers, health, and whether mybase starts on boot
  server update [--dir <dir>]    Download new images and restart (also refreshes compose.yml)
  server tunnel [--dir <dir>]    Add or replace the Cloudflare Tunnel [--tunnel-token <t> --domain <d>] | --off
  server database-public [--dir <dir>]   A normal postgres:// URL from anywhere: router port forward +
                                 Let's Encrypt TLS + DNS kept on your IP (Cloudflare)
    [--host <db.domain> --dns-token <t> [--email <e>] [--staging]] | --off
  server autostart on|off        Start mybase when this machine boots (and restart it after crashes)
  Default dir: the last one setup used, else ~/mybase`;

const dim = (s: string) => styleText("dim", s);
const green = (s: string) => styleText("green", s);
const red = (s: string) => styleText("red", s);

/** The install's .env, or a "run setup first" error. */
async function loadEnv(dir: string): Promise<{ text: string; values: Record<string, string> }> {
  const file = Bun.file(join(dir, ".env"));
  if (!(await file.exists()) || !(await Bun.file(join(dir, "compose.yml")).exists())) {
    throw new CliError(`no mybase server in ${dir}. Run \`mybase server setup\` (or pass --dir).`, 4);
  }
  const text = await file.text();
  return { text, values: parseEnv(text) };
}

async function saveEnv(dir: string, text: string) {
  await Bun.write(join(dir, ".env"), text);
}

interface ContainerState {
  Service: string;
  State: string;
  Health?: string;
  Status?: string;
}

async function status(args: string[]) {
  const dir = await serverDir(args);
  const { values } = await loadEnv(dir);
  const ps = await compose(dir, ["ps", "-a", "--format", "json"]);
  if (!ps.ok) throw new CliError(`docker compose ps failed: ${ps.stderr}`);
  // Older Compose prints one JSON array, newer one object per line.
  const containers: ContainerState[] = ps.stdout.startsWith("[") ? JSON.parse(ps.stdout) : ps.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const url = localUrl(values);
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    .then(async (r) => (r.ok ? ((await r.json()) as { version?: string }).version ?? "unknown" : null))
    .catch(() => null);
  const autostart = values.MYBASE_RESTART !== "no";
  const docker = dockerOnBoot();
  const data = {
    dir,
    url,
    healthy: health !== null,
    version: health,
    autostart: autostart && docker !== "disabled",
    dockerOnBoot: docker,
    publicUrl: values.CLOUDFLARE_TUNNEL_TOKEN ? (values.MYBASE_PUBLIC_URL ?? null) : null,
    containers: containers.map((c) => ({ service: c.Service, state: c.State, health: c.Health || null })),
  };
  print(data, () => {
    console.log(`mybase in ${dir}`);
    console.log(`  ${health ? green("●") : red("●")} ${url}  ${health ? `version ${health}` : "not answering"}`);
    if (data.publicUrl) console.log(`  ${dim("public")}  ${data.publicUrl}`);
    console.log(`  ${dim("starts on boot")}  ${!autostart ? "no (mybase server autostart on)" : docker === "disabled" ? "no: Docker doesn't start at boot (sudo systemctl enable docker)" : "yes"}`);
    console.log("");
    if (containers.length === 0) console.log("  No containers. Start them: mybase server update");
    for (const c of data.containers) {
      const up = c.state === "running" && (c.health === null || c.health === "healthy");
      console.log(`  ${up ? green("●") : red("●")} ${c.service.padEnd(12)} ${c.state}${c.health ? ` (${c.health})` : ""}`);
    }
  });
  if (!health) process.exitCode = 1;
}

async function update(args: string[]) {
  const dir = await serverDir(args);
  const { values } = await loadEnv(dir);
  const interactive = !jsonMode && process.stdin.isTTY === true && !args.includes("--yes");
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${dim("server update")}`);
  const replaced = await writeCompose(dir, interactive, true);
  if (replaced) ui.success(`compose.yml updated to this CLI's (${CLI_VERSION})`);
  const version = await startStack(dir, values);
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  if (minor(version) !== minor(CLI_VERSION)) {
    ui.warn(`The server is ${version}, this CLI ${CLI_VERSION}. Update the CLI: mybase update --cli`);
  }
  if (jsonMode) return print({ dir, version, composeUpdated: replaced }, () => {});
  p.outro(`mybase ${version} is running at ${localUrl(values)}`);
}

async function tunnel(args: string[]) {
  const dir = await serverDir(args);
  const { text, values } = await loadEnv(dir);
  const interactive = !jsonMode && process.stdin.isTTY === true;
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${dim("server tunnel")}`);

  let updates: Record<string, string | null>;
  let host: string | null = null;
  if (args.includes("--off")) {
    updates = Object.fromEntries(["COMPOSE_PROFILES", "CLOUDFLARE_TUNNEL_TOKEN", "MYBASE_PUBLIC_URL", "MYBASE_S3_PUBLIC_URL", "MYBASE_TRUST_PROXY", "POSTGRES_BIND", "GARAGE_S3_BIND", "VALKEY_BIND"].map((k) => [k, null]));
  } else if (flag(args, "--tunnel-token")) {
    const token = flag(args, "--tunnel-token")!;
    const domain = flag(args, "--domain");
    if (!tunnelIdFromToken(token)) throw usageError("--tunnel-token isn't a Cloudflare tunnel token");
    if (!domain) throw usageError("--tunnel-token needs --domain (serves mybase.<domain> and s3.<domain>)");
    host = `mybase.${domain}`;
    updates = tunnelEnv(token, host, `s3.${domain}`);
  } else if (interactive) {
    const result = await tunnelStep();
    host = result.apiHost;
    updates = result.env;
  } else throw usageError("without a terminal, pass --tunnel-token <t> --domain <d>, or --off");

  await saveEnv(dir, mergeEnv(text, updates));
  // `up` alone won't stop cloudflared once its profile is gone.
  if (args.includes("--off")) await compose(dir, ["--profile", "tunnel", "rm", "-sf", "cloudflared"]);
  const version = await startStack(dir, { ...values }, !args.includes("--off"));
  if (jsonMode) return print({ dir, version, publicUrl: host ? `https://${host}` : null }, () => {});
  p.outro(host ? `Public at https://${host}. Turn on two-factor sign-in in Settings if you haven't.` : "Tunnel off. mybase is reachable on this machine and your network only.");
}

async function databasePublic(args: string[]) {
  const dir = await serverDir(args);
  const { text, values } = await loadEnv(dir);
  const interactive = !jsonMode && process.stdin.isTTY === true;
  const off = args.includes("--off");
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${dim("server database-public")}`);

  let updates: Record<string, string | null>;
  if (off) {
    updates = Object.fromEntries(DB_PUBLIC_KEYS.map((k) => [k, null]));
  } else if (flag(args, "--dns-token")) {
    const host = flag(args, "--host");
    if (!host) throw usageError("--dns-token needs --host (like db.example.com)");
    updates = {
      MYBASE_DB_PUBLIC: "on",
      MYBASE_DB_PUBLIC_HOST: host.toLowerCase(),
      MYBASE_DNS_TOKEN: flag(args, "--dns-token")!,
      MYBASE_ACME_EMAIL: flag(args, "--email") ?? null,
      MYBASE_ACME_STAGING: args.includes("--staging") ? "1" : null,
      POSTGRES_BIND: null,
    };
  } else if (interactive) {
    updates = await dbPublicStep(values);
  } else throw usageError("without a terminal, pass --host <db.domain> --dns-token <t>, or --off");

  if (!off && values.POSTGRES_BIND === "127.0.0.1") ui.info("Postgres now listens on your network again (POSTGRES_BIND), so the router can reach it.");
  await saveEnv(dir, mergeEnv(text, updates));
  // An older compose.yml doesn't pass the new settings to the API, and an older image ignores them.
  if (await writeCompose(dir, interactive, true)) ui.success(`compose.yml updated to this CLI's (${CLI_VERSION})`);
  const version = await startStack(dir, values);
  const status = off ? null : await waitForDbPublic(localUrl(values));
  const port = values.POSTGRES_PORT || "5432";
  const lan = addresses().find((a) => a.label.startsWith("LAN IP"))?.value ?? "<this machine's LAN IP>";
  const host = off ? null : updates.MYBASE_DB_PUBLIC_HOST!;
  if (jsonMode) return print({ dir, version, host, port: Number(port), forward: host ? `${lan}:${port}` : null, status }, () => {});
  if (!host) return p.outro("Public Postgres off. Connection strings point at your network address again. Remove the port forward on your router.");
  ui.note(
    [
      `On your router (usually "Port forwarding" or "Virtual server"):`,
      `  TCP ${port} (external) → ${lan}:${port}`,
      ``,
      dim(status?.tls.active ? "DNS and the certificate are ready." : "Check progress in the dashboard (Database → Settings) or with `mybase doctor`."),
    ].join("\n"),
    "Last step",
  );
  p.outro(`New connection strings: postgres://<project>:<password>@${host}:${port}/<project>?sslmode=require`);
}

/**
 * Waits for the API's DNS update and certificate, so failures show here instead of only in the
 * server log. Throws when the server can't do it at all (old image, settings not passed through).
 */
async function waitForDbPublic(url: string): Promise<DbPublicStatus | null> {
  const s = ui.spinner();
  s.start("Pointing DNS at your public IP and getting a certificate (about a minute)");
  const deadline = Date.now() + 150_000;
  let last: DbPublicStatus | null = null;
  for (;;) {
    try {
      last = await api<DbPublicStatus>("/database/public", { url });
    } catch (err) {
      const status = (err as CliError).status;
      if (status === 401 || status === 403) {
        s.stop("Can't check progress: this CLI isn't signed in to the server as admin");
        return null;
      }
      if (status !== 404) throw err;
      last = null;
    }
    // A 404, or the dashboard's page for an unknown path: the server image predates this command.
    if (typeof last?.enabled !== "boolean") {
      s.error("The server doesn't support public Postgres");
      throw new CliError("the running mybase image is older than this CLI. Run `mybase server update` (or set MYBASE_IMAGE to a newer build), then this command again.");
    }
    if (!last.enabled) {
      s.error("The server didn't get the settings");
      throw new CliError("MYBASE_DB_PUBLIC isn't reaching the API. Check that compose.yml passes it (`mybase server update` refreshes compose.yml).");
    }
    if (last.problem) {
      s.error(last.problem);
      throw new CliError(last.problem);
    }
    if (last.dns.error || last.tls.error) {
      s.error([last.dns.error && `DNS: ${last.dns.error}`, last.tls.error && `Certificate: ${last.tls.error}`].filter(Boolean).join("; "));
      ui.info("mybase keeps retrying (certificate: in 1 h, 6 h, then daily). Fix the cause, then run `mybase server update` to retry now.");
      return last;
    }
    if (last.tls.active) {
      s.stop(`${last.host} → ${last.dns.ip}, certificate valid until ${last.tls.notAfter?.slice(0, 10)}`);
      return last;
    }
    if (Date.now() > deadline) {
      s.stop(`Still working (${last.dns.ip ? `DNS → ${last.dns.ip}` : "DNS pending"}, certificate pending)`);
      return last;
    }
    await Bun.sleep(3000);
  }
}

async function autostart(args: string[]) {
  const mode = args[0];
  if (mode !== "on" && mode !== "off") throw usageError("usage: mybase server autostart on|off");
  const dir = await serverDir(args);
  const { text, values } = await loadEnv(dir);
  await saveEnv(dir, mergeEnv(text, { MYBASE_RESTART: mode === "on" ? null : "no" }));
  if (mode === "on" && dockerOnBoot() === "disabled") {
    if (!jsonMode && process.stdin.isTTY) await turnOnDockerAtBoot();
    else ui.warn("Docker doesn't start at boot, so mybase won't either. Run `sudo systemctl enable docker`.");
  }
  // The restart policy is set when containers are created: recreate them (data is kept).
  const up = await compose(dir, ["up", "-d"]);
  if (!up.ok) throw new CliError(`docker compose up failed:\n${up.stderr}`);
  if (!(await waitHealthy(localUrl(values), 60_000))) ui.warn("mybase didn't answer yet; check `mybase server status`.");
  print({ dir, autostart: mode === "on", dockerOnBoot: dockerOnBoot() }, () =>
    console.log(mode === "on" ? "mybase now starts when this machine boots, and restarts if it crashes." : "mybase won't start on its own after a reboot. Start it with `mybase server update`."),
  );
}

/** Runs a `mybase server` command. Returns false when `command` isn't one. */
export async function server(command: string, args: string[]): Promise<boolean> {
  if (command === "setup") await setup(args);
  else if (command === "status") await status(args);
  else if (command === "update") await update(args);
  else if (command === "tunnel") await tunnel(args);
  else if (command === "database-public") await databasePublic(args);
  else if (command === "autostart") await autostart(args);
  else return false;
  return true;
}

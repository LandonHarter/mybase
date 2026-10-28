// `mybase server …`: install and run mybase itself on this machine (Docker Compose in ~/mybase).
// The setup wizard is in server-setup.ts; these are the day-two commands around it.
import * as p from "@clack/prompts";
import { join } from "node:path";
import { styleText } from "node:util";
import { CLI_VERSION } from "./api";
import { CliError, jsonMode, print, usageError } from "./output";
import { compose, dockerOnBoot, waitHealthy } from "./server-docker";
import { mergeEnv, parseEnv, tunnelEnv, tunnelIdFromToken } from "./server-env";
import { flag, localUrl, serverDir, setup, startStack, tunnelStep, turnOnDockerAtBoot, ui, writeCompose } from "./server-setup";

export const serverUsage = `  server setup [--dir <dir>]     Install mybase on this machine: checks Docker, generates keys, sets up
                                 LAN/Tailscale access, a Cloudflare Tunnel, start on boot, and the admin
    [--yes] [--public-host <h>] [--tunnel-token <t> --domain <d>] [--port <n>] [--no-autostart]
    [--admin-user <u> --admin-password-stdin]   Without a terminal: defaults plus these flags
  server status [--dir <dir>]    Containers, health, and whether mybase starts on boot
  server update [--dir <dir>]    Download new images and restart (also refreshes compose.yml)
  server tunnel [--dir <dir>]    Add or replace the Cloudflare Tunnel [--tunnel-token <t> --domain <d>] | --off
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
  else if (command === "autostart") await autostart(args);
  else return false;
  return true;
}

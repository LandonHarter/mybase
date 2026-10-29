// `mybase server setup`: installs mybase on this machine. Checks Docker, generates every key,
// asks how the server should be reached (LAN/Tailscale, Cloudflare Tunnel), writes .env and
// compose.yml, starts the stack, creates the admin, and signs the CLI in.
import * as p from "@clack/prompts";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { styleText } from "node:util";
import type { LoginResponse } from "@mybase/shared";
import { ADMIN_PASSWORD_MIN } from "@mybase/shared";
import composeYml from "../../../docker/compose.yml" with { type: "text" };
import { api, CLI_VERSION } from "./api";
import { CloudflareError, cloudflare, DNS_TOKEN_PERMISSIONS, pointsAtTunnel, TOKEN_PERMISSIONS, TOKEN_URL, zoneOf, type Zone } from "./cloudflare";
import { configPath, loadConfig, saveConfig, saveServerDir } from "./config";
import { CliError, jsonMode, print, usageError } from "./output";
import { addresses, checkDocker, compose, dockerOnBoot, enableDockerOnBoot, freeDiskGb, machine, otherInstall, portFree, stackExists, waitHealthy } from "./server-docker";
import { composeProfile, generateSecrets, isSecretKey, maskSecret, mergeEnv, parseEnv, renderEnv, SECRET_KEYS, tunnelEnv, tunnelIdFromToken } from "./server-env";
import { sandboxProfileOn } from "./server-sandbox-env";

export const DEFAULT_DIR = join(homedir(), "mybase");

const USERNAME_PATTERN = /^[a-zA-Z0-9_.@-]{1,64}$/;
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const TUNNEL_KEYS = ["COMPOSE_PROFILES", "CLOUDFLARE_TUNNEL_TOKEN", "MYBASE_PUBLIC_URL", "MYBASE_S3_PUBLIC_URL", "MYBASE_TRUST_PROXY"];
const BIND_KEYS = ["POSTGRES_BIND", "GARAGE_S3_BIND", "VALKEY_BIND"];

const bold = (s: string) => styleText("bold", s);
const dim = (s: string) => styleText("dim", s);
const cyan = (s: string) => styleText("cyan", s);
const yellow = (s: string) => styleText("yellow", s);
const tilde = (path: string) => path.replace(homedir(), "~");

/** The value after `--name`, or undefined. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw usageError(`${name} needs a value`);
  return value;
}

/** `--dir`, else where setup last installed, else ~/mybase. */
export async function serverDir(args: string[]): Promise<string> {
  const given = flag(args, "--dir");
  if (given) return resolve(given.replace(/^~(?=$|\/)/, homedir()));
  return (await loadConfig()).server ?? DEFAULT_DIR;
}

export const localUrl = (env: Record<string, string>) => `http://localhost:${env.MYBASE_PORT || "4000"}`;

/** Output that stays quiet with `--json` (only the final result is printed then). */
export const ui = {
  info: (m: string) => !jsonMode && p.log.info(m),
  success: (m: string) => !jsonMode && p.log.success(m),
  warn: (m: string) => !jsonMode && p.log.warn(m),
  error: (m: string) => !jsonMode && p.log.error(m),
  step: (m: string) => !jsonMode && p.log.step(m),
  note: (m: string, title?: string) => !jsonMode && p.note(m, title),
  spinner(): Pick<p.SpinnerResult, "start" | "stop" | "error" | "message"> {
    return jsonMode ? { start() {}, stop() {}, error() {}, message() {} } : p.spinner();
  },
};

/** Unwraps a prompt's answer; Ctrl-C/Esc leaves without changing anything. */
async function ask<T>(answer: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await answer;
  if (p.isCancel(value)) {
    p.cancel("Cancelled. Nothing was changed.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

const validPort = (v: string | undefined) => (/^\d+$/.test(v ?? "") && Number(v) >= 1 && Number(v) <= 65535 ? undefined : "a port number, 1–65535");

/** Last lines of a command's output, for showing what went wrong. */
const tail = (text: string, n = 25) => text.split("\n").slice(-n).join("\n");

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────

/** Docker, architecture, memory, disk. Throws when Docker can't run mybase. */
async function preflight(dir: string) {
  const s = ui.spinner();
  s.start("Checking this machine");
  const docker = checkDocker();
  const m = machine();
  const disk = await freeDiskGb(dir);
  if (!docker.ok) {
    s.error("This machine isn't ready");
    throw new CliError(docker.problem!);
  }
  s.stop("This machine is ready");
  const ok = styleText("green", "✔");
  const warn = yellow("▲");
  const lines = [
    `${ok} Docker ${docker.docker}, Compose ${docker.compose}`,
    `${ok} ${m.pi ?? m.hostname} (${m.arch})`,
    `${m.totalMemGb < 1.5 ? warn : ok} ${m.totalMemGb.toFixed(1)} GB memory${m.totalMemGb < 1.5 ? dim("  mybase uses ~600 MB; 2 GB+ recommended") : ""}`,
  ];
  if (disk !== null) lines.push(`${disk < 5 ? warn : ok} ${disk.toFixed(0)} GB free disk${disk < 5 ? dim("  images + data need a few GB") : ""}`);
  if (m.pi) lines.push(`${warn} ${dim("Raspberry Pi: put Docker's data on an SSD if you can. SD cards are slow and wear out.")}`);
  ui.note(lines.join("\n"), "This machine");
}

/** Where the server lives. Refuses to share the `mybase` compose project with another directory. */
async function chooseDir(args: string[], interactive: boolean): Promise<string> {
  let dir = await serverDir(args);
  if (interactive && !args.includes("--dir")) {
    const answer = await ask(
      p.text({
        message: "Where should mybase keep its files?",
        placeholder: tilde(dir),
        defaultValue: dir,
        validate: (v) => (v && !v.trim().startsWith("/") && !v.trim().startsWith("~") ? "use an absolute path (or ~/…)" : undefined),
      }),
    );
    dir = resolve(answer.trim().replace(/^~(?=$|\/)/, homedir()));
  }
  const other = otherInstall(dir);
  if (other) {
    throw new CliError(`mybase is already installed in ${other}. Run \`mybase server setup --dir ${other}\` to change it, or stop it first (\`docker compose down\` there).`);
  }
  return dir;
}

/** LAN/Tailscale address apps use to reach this machine. */
async function chooseHost(current: string | undefined): Promise<string> {
  const found = addresses();
  const options = found.map((a) => ({ value: a.value, label: a.value, hint: a.label }));
  if (current && !found.some((a) => a.value === current)) options.unshift({ value: current, label: current, hint: "current" });
  options.push({ value: "", label: "Something else…", hint: "type a name or IP" });
  const picked = await ask(p.select({ message: "Which address should apps on your network use?", options, initialValue: current ?? options[0]?.value }));
  if (picked) return picked;
  return (await ask(p.text({ message: "Address (hostname or IP)", validate: (v) => (v?.trim() ? undefined : "required") }))).trim();
}

/** Same hostname rules for both tunnel paths. */
const validHost = (v: string | undefined) => (HOST_PATTERN.test(v?.trim() ?? "") ? undefined : "a full hostname, like mybase.example.com");

/**
 * Sets up a Cloudflare Tunnel, automatically (API token) or by hand (dashboard + tunnel token).
 * Returns the .env keys for it.
 */
export async function tunnelStep(): Promise<{ env: Record<string, string>; apiHost: string; s3Host: string }> {
  const mode = await ask(
    p.select({
      message: "How do you want to set up the tunnel?",
      options: [
        { value: "auto", label: "Automatically", hint: "paste a Cloudflare API token; mybase creates the tunnel + DNS" },
        { value: "manual", label: "By hand", hint: "follow the steps in the Cloudflare dashboard, then paste the tunnel token" },
      ],
    }),
  );
  return mode === "auto" ? autoTunnel() : manualTunnel();
}

async function autoTunnel(): Promise<{ env: Record<string, string>; apiHost: string; s3Host: string }> {
  ui.note(
    [
      `1. Your domain has to be on Cloudflare (free plan is fine).`,
      `2. Create a token at ${cyan(TOKEN_URL)}`,
      `   ${dim("Create Token → Custom token, with these permissions:")}`,
      ...TOKEN_PERMISSIONS.map((perm) => `     • ${perm}`),
      ``,
      dim("The token is only used now, to create the tunnel and DNS records. It isn't saved."),
    ].join("\n"),
    "Cloudflare API token",
  );
  for (;;) {
    const token = await ask(p.password({ message: "Cloudflare API token", validate: (v) => (v?.trim() ? undefined : "required") }));
    const cf = cloudflare(token.trim());
    const s = ui.spinner();
    s.start("Looking up your domains");
    let zones: Zone[];
    try {
      zones = await cf.listZones();
    } catch (err) {
      s.error((err as Error).message);
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      return manualTunnel();
    }
    if (zones.length === 0) {
      s.error("No active domains on this token");
      ui.info("Add your domain at https://dash.cloudflare.com (Add a site), wait until it's active, then try again.");
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      return manualTunnel();
    }
    s.stop(`Found ${zones.length} domain${zones.length === 1 ? "" : "s"}`);

    const zoneId = zones.length === 1 ? zones[0]!.id : await ask(p.select({ message: "Which domain?", options: zones.map((z) => ({ value: z.id, label: z.name })) }));
    const zone = zones.find((z) => z.id === zoneId)!;

    const tunnelName = `mybase-${hostname()}`;
    s.start(`Creating tunnel ${tunnelName}`);
    let tunnel: { id: string; created: boolean };
    try {
      tunnel = await cf.ensureTunnel(zone.account.id, tunnelName);
    } catch (err) {
      s.error((err as Error).message);
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      return manualTunnel();
    }
    s.stop(tunnel.created ? `Created tunnel ${tunnelName}` : `Reusing tunnel ${tunnelName}`);

    // Hostnames: ask until both are free (or already ours), or the user agrees to replace them.
    let apiHost = "";
    let s3Host = "";
    for (;;) {
      const apiSub = await ask(p.text({ message: "Subdomain for the dashboard + API", placeholder: "mybase", defaultValue: "mybase" }));
      const s3Sub = await ask(p.text({ message: "Subdomain for S3 storage", placeholder: "s3", defaultValue: "s3" }));
      apiHost = `${apiSub.trim()}.${zone.name}`;
      s3Host = `${s3Sub.trim()}.${zone.name}`;
      if (validHost(apiHost) || validHost(s3Host) || apiHost === s3Host) {
        ui.warn("Use two different, valid subdomains.");
        continue;
      }
      const taken: string[] = [];
      for (const host of [apiHost, s3Host]) {
        const record = await cf.findRecord(zone.id, host).catch(() => null);
        if (record && !pointsAtTunnel(record, tunnel.id)) taken.push(`${host} (${record.type} → ${record.content})`);
      }
      if (taken.length === 0) break;
      const replace = await ask(p.confirm({ message: `Already in use: ${taken.join(", ")}. Replace ${taken.length === 1 ? "it" : "them"}?`, initialValue: false }));
      if (replace) break;
    }

    s.start("Routing hostnames to the tunnel");
    try {
      await cf.putIngress(zone.account.id, tunnel.id, [
        { hostname: apiHost, service: "http://mybase:4000" },
        { hostname: s3Host, service: "http://garage:3900" },
      ]);
      await cf.upsertCname(zone.id, apiHost, tunnel.id);
      await cf.upsertCname(zone.id, s3Host, tunnel.id);
      const tunnelToken = await cf.tunnelToken(zone.account.id, tunnel.id);
      s.stop(`${apiHost} and ${s3Host} → this machine`);
      return { env: tunnelEnv(tunnelToken, apiHost, s3Host), apiHost, s3Host };
    } catch (err) {
      s.error(err instanceof CloudflareError ? err.message : `Cloudflare: ${(err as Error).message}`);
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      return manualTunnel();
    }
  }
}

async function manualTunnel(): Promise<{ env: Record<string, string>; apiHost: string; s3Host: string }> {
  ui.note(
    [
      `1. Add your domain to Cloudflare (free plan) and switch its nameservers at your registrar.`,
      `2. Open ${cyan("https://one.dash.cloudflare.com")} → Networks → Tunnels → ${bold("Create a tunnel")}`,
      `   → Cloudflared. Name it ${bold("mybase")}.`,
      `3. Skip installing a connector (mybase runs it in Docker). Copy the token: the long`,
      `   string after ${bold("--token")} in any of the install commands.`,
      `4. Add two ${bold("public hostnames")} (Type: HTTP):`,
      `     mybase.<your domain>  →  ${cyan("mybase:4000")}   ${dim("dashboard, API, Postgres over WebSocket")}`,
      `     s3.<your domain>      →  ${cyan("garage:3900")}   ${dim("S3 for your apps")}`,
    ].join("\n"),
    "Cloudflare Tunnel, by hand",
  );
  const token = await ask(
    p.password({ message: "Tunnel token", validate: (v) => (tunnelIdFromToken(v ?? "") ? undefined : "that isn't a tunnel token (copy the part after --token)") }),
  );
  const apiHost = (await ask(p.text({ message: "Hostname for the dashboard + API", placeholder: "mybase.example.com", validate: validHost }))).trim();
  const defaultS3 = apiHost.replace(/^[^.]+/, "s3");
  const s3Host = (await ask(p.text({ message: "Hostname for S3", placeholder: defaultS3, defaultValue: defaultS3, validate: (v) => validHost(v || defaultS3) }))).trim();
  return { env: tunnelEnv(token.trim(), apiHost, s3Host), apiHost, s3Host };
}

/** Asks whether to close Postgres/S3/cache ports to the LAN (only the tunnel is used then). */
async function bindStep(lan: boolean, existing: Record<string, string>): Promise<Record<string, string | null>> {
  const locked = existing.POSTGRES_BIND === "127.0.0.1";
  const lock = await ask(
    p.confirm({
      message: "Close the Postgres, S3, and cache ports to your network? (apps then connect through the tunnel only)",
      initialValue: lan ? locked : true,
    }),
  );
  return Object.fromEntries(BIND_KEYS.map((k) => [k, lock ? "127.0.0.1" : null]));
}

/** The .env keys public Postgres reads; `--off` clears them. */
export const DB_PUBLIC_KEYS = ["MYBASE_DB_PUBLIC", "MYBASE_DB_PUBLIC_HOST", "MYBASE_DNS_TOKEN", "MYBASE_ACME_EMAIL", "MYBASE_ACME_STAGING"];

/**
 * Public Postgres: a Cloudflare token the server keeps (DNS only), the hostname, and its zone.
 * Clears any non-A record already at that name (the API keeps an A record there). Returns .env keys.
 */
export async function dbPublicStep(existing: Record<string, string>): Promise<Record<string, string | null>> {
  ui.note(
    [
      `Apps anywhere get a normal postgres:// URL, with any driver. You need:`,
      `• Your router to forward TCP port ${existing.POSTGRES_PORT || "5432"} to this machine. ${dim("Shows your home IP; not possible behind CGNAT.")}`,
      `• A Cloudflare token that mybase keeps, to point db.<domain> at your IP and get a TLS certificate.`,
      `  Create one at ${cyan(TOKEN_URL)} ${dim("(Custom token)")} with only:`,
      ...DNS_TOKEN_PERMISSIONS.map((perm) => `     • ${perm}`),
    ].join("\n"),
    "Public Postgres",
  );
  const tunnelHost = URL.parse(existing.MYBASE_PUBLIC_URL ?? "")?.hostname ?? "";
  for (;;) {
    const token = (await ask(p.password({ message: "Cloudflare API token (DNS edit)", validate: (v) => (v?.trim() ? undefined : "required") }))).trim();
    const cf = cloudflare(token, fetch, DNS_TOKEN_PERMISSIONS);
    const s = ui.spinner();
    s.start("Looking up your domains");
    let zones: Zone[];
    try {
      zones = await cf.listZones();
    } catch (err) {
      s.error((err as Error).message);
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      throw new CliError("public Postgres not set up: no working token");
    }
    if (zones.length === 0) {
      s.error("No active domains on this token");
      if (await ask(p.confirm({ message: "Try another token?" }))) continue;
      throw new CliError("public Postgres not set up: the token can't see any domain");
    }
    s.stop(`Found ${zones.length} domain${zones.length === 1 ? "" : "s"}`);

    // Default to the domain already in use (an earlier setup, or the tunnel's).
    const preferred = zoneOf(zones, existing.MYBASE_DB_PUBLIC_HOST || tunnelHost);
    const zoneId =
      zones.length === 1
        ? zones[0]!.id
        : await ask(p.select({ message: "Which domain?", options: zones.map((z) => ({ value: z.id, label: z.name })), initialValue: preferred?.id }));
    const chosen = zones.find((z) => z.id === zoneId)!;
    const suggested = existing.MYBASE_DB_PUBLIC_HOST && zoneOf([chosen], existing.MYBASE_DB_PUBLIC_HOST) ? existing.MYBASE_DB_PUBLIC_HOST : `db.${chosen.name}`;
    const host = (
      await ask(
        p.text({
          message: "Hostname for the database",
          placeholder: suggested,
          defaultValue: suggested,
          validate: (v) => {
            const h = (v || suggested).trim().toLowerCase();
            if (validHost(h)) return validHost(h);
            return zoneOf([chosen], h) ? undefined : `must end in ${chosen.name}`;
          },
        }),
      )
    )
      .trim()
      .toLowerCase() || suggested;

    const record = await cf.findRecord(chosen.id, host).catch(() => null);
    if (record && record.type !== "A") {
      const replace = await ask(p.confirm({ message: `${host} already has a ${record.type} record (${record.content}). Replace it?`, initialValue: false }));
      if (!replace) continue;
      await cf.deleteRecord(chosen.id, record.id);
    }
    const email = (await ask(p.text({ message: "Email for Let's Encrypt expiry notices (optional)", placeholder: "skip" }))).trim();
    return {
      MYBASE_DB_PUBLIC: "on",
      MYBASE_DB_PUBLIC_HOST: host,
      MYBASE_DNS_TOKEN: token,
      MYBASE_ACME_EMAIL: email || null,
      // The router forwards to this machine's port, so it has to listen on the network.
      POSTGRES_BIND: null,
    };
  }
}

async function adminStep(): Promise<{ username: string; password: string } | null> {
  const when = await ask(
    p.select({
      message: "Create the admin account now?",
      options: [
        { value: "now", label: "Yes", hint: "and sign this CLI in" },
        { value: "later", label: "Later, in the browser", hint: "from this machine or your network" },
      ],
    }),
  );
  if (when === "later") return null;
  const username = (await ask(p.text({ message: "Admin username", placeholder: "admin", defaultValue: "admin", validate: (v) => (!v || USERNAME_PATTERN.test(v) ? undefined : "letters, digits, or . _ @ -") }))).trim();
  for (;;) {
    const password = await ask(p.password({ message: `Password (at least ${ADMIN_PASSWORD_MIN} characters)`, validate: (v) => ((v?.length ?? 0) >= ADMIN_PASSWORD_MIN ? undefined : `at least ${ADMIN_PASSWORD_MIN} characters`) }));
    const again = await ask(p.password({ message: "Same password again" }));
    if (again === password) return { username, password };
    ui.warn("The passwords didn't match.");
  }
}

/**
 * Start on boot: the containers' restart policy (`MYBASE_RESTART`) brings mybase back whenever
 * Docker starts, so Docker itself has to start at boot. Returns whether to `systemctl enable` it.
 */
async function bootStep(existing: Record<string, string>, interactive: boolean, args: string[]): Promise<{ always: boolean; enableDocker: boolean }> {
  const docker = dockerOnBoot();
  if (!interactive) {
    const always = !args.includes("--no-autostart");
    if (always && docker === "disabled") ui.warn("Docker doesn't start at boot, so mybase won't either. Run `sudo systemctl enable docker`.");
    return { always, enableDocker: false };
  }
  const always = await ask(
    p.confirm({
      message: `Start mybase automatically when this machine turns on? ${dim("(and restart it if it crashes)")}`,
      initialValue: existing.MYBASE_RESTART !== "no",
    }),
  );
  if (!always) return { always, enableDocker: false };
  if (docker === "enabled") return { always, enableDocker: false };
  if (docker === "desktop") {
    ui.info(`Docker Desktop: turn on ${bold("Settings → General → Start Docker Desktop when you sign in")} too.`);
    return { always, enableDocker: false };
  }
  if (docker === "unknown") {
    ui.warn("Couldn't tell whether Docker starts at boot here (no systemd?). Make sure it does, or mybase won't either.");
    return { always, enableDocker: false };
  }
  const enableDocker = await ask(p.confirm({ message: `Docker doesn't start at boot yet. Turn that on? ${dim("(sudo systemctl enable docker)")}` }));
  if (!enableDocker) ui.warn("Then mybase only comes back after a reboot once you start Docker yourself.");
  return { always, enableDocker };
}

/** Turns on Docker at boot, saying what to run by hand if it fails. */
export async function turnOnDockerAtBoot() {
  ui.step("Turning on Docker at boot (sudo may ask for your password)");
  if (await enableDockerOnBoot()) ui.success("Docker starts at boot");
  else ui.warn("Couldn't enable it. Run `sudo systemctl enable docker` yourself.");
}

/** Ports, cache memory, storage capacity, log level. Keys equal to the default are left out. */
async function advancedStep(env: Record<string, string>): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const set = (key: string, value: string, fallback: string) => {
    if (value !== fallback) out[key] = value;
    else if (env[key] !== undefined) out[key] = null;
  };
  const port = (key: string, label: string, fallback: string) =>
    ask(p.text({ message: `${label} port`, placeholder: env[key] ?? fallback, defaultValue: env[key] ?? fallback, validate: (v) => (v ? validPort(v) : undefined) })).then((v) => set(key, v.trim(), fallback));
  await port("MYBASE_PORT", "Dashboard + API", "4000");
  await port("POSTGRES_PORT", "Postgres", "5432");
  await port("GARAGE_S3_PORT", "S3", "3900");
  await port("VALKEY_PORT", "Cache", "6379");
  const memory = await ask(
    p.select({
      message: "Cache memory (shared by every project; least recently used keys go first)",
      initialValue: env.CACHE_MAXMEMORY ?? "64mb",
      options: ["64mb", "128mb", "256mb", "512mb", "1gb"].map((v) => ({ value: v, label: v, hint: v === "64mb" ? "default, fine for a Pi" : undefined })),
    }),
  );
  set("CACHE_MAXMEMORY", memory, "64mb");
  const capacity = await ask(p.text({ message: "Storage capacity Garage advertises", placeholder: env.GARAGE_CAPACITY ?? "100G", defaultValue: env.GARAGE_CAPACITY ?? "100G", validate: (v) => (!v || /^\d+[KMGT]?$/i.test(v) ? undefined : "like 100G or 2T") }));
  set("GARAGE_CAPACITY", capacity.trim(), "100G");
  const level = await ask(p.select({ message: "Log level", initialValue: env.LOG_LEVEL ?? "info", options: ["debug", "info", "warn", "error"].map((v) => ({ value: v, label: v })) }));
  set("LOG_LEVEL", level, "info");
  return out;
}

/** Ports the stack publishes that something else already holds. Asks for others when it can. */
async function portStep(env: Record<string, string>, interactive: boolean): Promise<Record<string, string>> {
  const ports: [string, string, string][] = [
    ["MYBASE_PORT", "dashboard + API", "4000"],
    ["POSTGRES_PORT", "Postgres", "5432"],
    ["GARAGE_S3_PORT", "S3", "3900"],
    ["VALKEY_PORT", "cache", "6379"],
  ];
  const out: Record<string, string> = {};
  for (const [key, label, fallback] of ports) {
    const current = env[key] ?? fallback;
    if (portFree(Number(current))) continue;
    if (!interactive) throw new CliError(`port ${current} (${label}) is already in use. Free it, or set ${key} in the .env.`);
    let next = Number(current) + 1;
    while (!portFree(next) && next < 65535) next++;
    const answer = await ask(p.text({ message: `Port ${current} (${label}) is in use by something else. Use which port?`, placeholder: String(next), defaultValue: String(next), validate: (v) => (v ? validPort(v) : undefined) }));
    out[key] = answer.trim();
  }
  return out;
}

/** Writes .env (mode 600) and compose.yml. Asks before replacing a compose.yml that differs. */
export async function writeFiles(dir: string, envText: string, interactive: boolean, replaceCompose = interactive) {
  await mkdir(dir, { recursive: true });
  const envPath = join(dir, ".env");
  await Bun.write(envPath, envText);
  await chmod(envPath, 0o600);
  await writeCompose(dir, interactive, replaceCompose);
}

/** Puts this CLI's compose.yml in `dir`. An edited one is kept as compose.yml.bak. */
export async function writeCompose(dir: string, interactive: boolean, replace: boolean): Promise<boolean> {
  const file = Bun.file(join(dir, "compose.yml"));
  if (await file.exists()) {
    const current = await file.text();
    if (current === composeYml) return false;
    const ok = interactive
      ? await ask(p.confirm({ message: `${tilde(join(dir, "compose.yml"))} differs from this CLI's (${CLI_VERSION}). Replace it? (the old one is kept as compose.yml.bak)` }))
      : replace;
    if (!ok) return false;
    await Bun.write(join(dir, "compose.yml.bak"), current);
  }
  await Bun.write(file, composeYml);
  return true;
}

/** What to do about the usual pull failures. Compose stops at the first one, so it names that image. */
export function pullHint(output: string): string {
  const failed = /Image (\S+) Error/.exec(output)?.[1];
  if (/unauthorized|denied|requested access to the resource/i.test(output)) {
    const image = failed ?? "an image";
    return failed?.startsWith("ghcr.io/")
      ? `\n\n${image} is private on GitHub's registry (or doesn't exist). Its owner has to make the package public (GitHub → Packages → Package settings → Change visibility), or sign in first: docker login ghcr.io`
      : `\n\nThe registry refused ${image}: check the image name (MYBASE_IMAGE / MYBASE_POSTGRES_IMAGE in .env), or docker login.`;
  }
  if (/timeout|no such host|network|TLS handshake/i.test(output)) return "\n\nThis machine couldn't reach the registry. Check its internet connection and DNS, then run setup again.";
  return "";
}

/** Images the stack needs (active profiles only) that aren't on this machine. */
async function missingImages(dir: string): Promise<string[]> {
  const images = await compose(dir, ["config", "--images"]);
  const missing: string[] = [];
  for (const image of images.stdout.split("\n").filter(Boolean)) {
    if (!imageExists(image)) missing.push(image);
  }
  return missing;
}

const imageExists = (image: string) => Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/** Services that exited, are restarting, or failed their healthcheck. */
async function brokenServices(dir: string): Promise<string[]> {
  const ps = await compose(dir, ["ps", "-a", "--format", "json"]);
  if (!ps.ok || !ps.stdout) return [];
  const rows = (ps.stdout.startsWith("[") ? JSON.parse(ps.stdout) : ps.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l))) as { Service: string; State: string; Health?: string }[];
  return rows.filter((r) => r.State !== "running" || r.Health === "unhealthy").map((r) => r.Service);
}

/** Pulls images, starts the stack, and waits for /health. Throws with the API's last log lines. */
export async function startStack(dir: string, env: Record<string, string>, pull = true): Promise<string> {
  const s = ui.spinner();
  if (pull) {
    s.start("Downloading images (the first time takes a few minutes, longer on a Pi)");
    const pulled = await compose(dir, ["pull", "--quiet"]);
    if (!pulled.ok) {
      // Fine if every image is already here (a local build in MYBASE_IMAGE, or offline).
      const missing = await missingImages(dir);
      if (missing.length) {
        s.error("Couldn't download the images");
        throw new CliError(`couldn't download ${missing.join(", ")}:\n${tail(pulled.stderr || pulled.stdout)}${pullHint(pulled.stderr || pulled.stdout)}`);
      }
      s.stop("Using the images already on this machine (couldn't download newer ones)");
    } else s.stop("Images downloaded");
  }
  // Read the install's current settings: callers may just have changed profiles or URLs.
  const current = parseEnv(await Bun.file(join(dir, ".env")).text());
  if (sandboxProfileOn(current)) {
    s.start("Updating sandbox runtime images");
    const { refreshSandboxImages } = await import("./server-sandbox");
    await refreshSandboxImages(dir, current, pull);
    s.stop("Sandbox images ready");
  }
  s.start("Starting containers");
  const up = await compose(dir, ["up", "-d", "--remove-orphans"]);
  if (!up.ok) {
    s.error("Couldn't start the containers");
    throw new CliError(`docker compose up failed:\n${tail(up.stderr || up.stdout)}`);
  }
  s.message("Waiting for mybase to answer");
  const version = await waitHealthy(localUrl(env));
  if (!version) {
    s.error("mybase didn't come up");
    // Usually another container is crash-looping (the API just waits for it): show that one's logs.
    const broken = await brokenServices(dir);
    const sections: string[] = [];
    for (const service of broken.length ? broken : ["mybase"]) {
      const logs = await compose(dir, ["logs", "--no-log-prefix", "--tail", "25", service]);
      sections.push(`── ${service} ──\n${logs.stdout || logs.stderr || "(no output)"}`);
    }
    const which = broken.length ? `Not running: ${broken.join(", ")}.` : "Every container is up, but the API isn't answering.";
    throw new CliError(`mybase didn't answer at ${localUrl(env)}/health within 3 minutes. ${which}\n\n${sections.join("\n\n")}\n\nFix the problem, then run \`mybase server setup --dir ${dir}\` again (keys are kept). \`mybase server status\` shows every container.`);
  }
  s.stop(`mybase ${version} is running`);
  return version;
}

/** Creates the admin through the first-run route, then signs the CLI in as it. */
async function createAdmin(url: string, admin: { username: string; password: string }): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
    if (!res.ok) throw new CliError(data.error ?? res.statusText);
    return data;
  };
  await post("/auth/setup", admin);
  const login = await post("/auth/login", { ...admin, tokenName: `cli on ${hostname()}` });
  if (!login.token) throw new CliError("the server didn't return a token");
  const previous = await loadConfig();
  await saveConfig({ url, token: login.token });
  if (previous.token && previous.url) await api("/auth/logout", { method: "POST", url: previous.url, token: previous.token }).catch(() => {});
  return login.username;
}

/** Whether the server at `url` still needs its admin account. */
async function setupNeeded(url: string): Promise<boolean> {
  const res = await fetch(`${url}/auth/me`).catch(() => null);
  if (!res?.ok) return true;
  return ((await res.json()) as { setupNeeded?: boolean }).setupNeeded !== false;
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────────

export async function setup(args: string[]) {
  const yes = args.includes("--yes");
  const interactive = !yes && !jsonMode && process.stdin.isTTY === true;
  if (!interactive && !yes) throw usageError("refusing without --yes (no terminal to ask on). Pass --yes with flags: see `mybase help server`.");

  if (!jsonMode) p.intro(`${bold(" mybase ")} ${dim(`server setup · ${CLI_VERSION}`)}`);
  if (interactive) ui.info(`This sets up mybase on ${bold(hostname())}: Postgres, storage, cache, and the dashboard, in Docker.\n${dim("Nothing is changed until you confirm at the end. Ctrl-C leaves at any time.")}`);

  const dir = await chooseDir(args, interactive);
  await preflight(dir);

  const envFile = Bun.file(join(dir, ".env"));
  const envText = (await envFile.exists()) ? await envFile.text() : null;
  const existing = envText ? parseEnv(envText) : {};
  const running = await stackExists(dir);
  if (envText) {
    if (interactive) {
      const action = await ask(
        p.select({
          message: `mybase is already set up in ${tilde(dir)}.`,
          options: [
            { value: "reconfigure", label: "Change its settings", hint: "keys and data are kept" },
            { value: "cancel", label: "Leave it as it is" },
          ],
        }),
      );
      if (action === "cancel") {
        p.outro("Nothing changed.");
        return;
      }
    } else ui.info(`Updating the existing setup in ${dir} (keys are kept).`);
  }

  const updates: Record<string, string | null> = {};

  // Keys: only the missing ones are generated.
  const secrets = generateSecrets(existing);
  Object.assign(updates, secrets);
  ui.note(
    Object.keys(SECRET_KEYS)
      .map((key) => {
        const value = secrets[key as keyof typeof secrets] ?? existing[key]!;
        return `${key.padEnd(20)} ${dim(maskSecret(value))}  ${secrets[key as keyof typeof secrets] ? styleText("green", "new") : dim("kept")}`;
      })
      .join("\n"),
    "Keys",
  );

  // Access.
  let lan = Boolean(existing.MYBASE_PUBLIC_HOST);
  let tunnel: { apiHost: string; s3Host: string } | null = existing.CLOUDFLARE_TUNNEL_TOKEN
    ? { apiHost: (existing.MYBASE_PUBLIC_URL ?? "").replace(/^https?:\/\//, ""), s3Host: (existing.MYBASE_S3_PUBLIC_URL ?? "").replace(/^https?:\/\//, "") }
    : null;
  const tunnelToken = flag(args, "--tunnel-token");
  const publicHost = flag(args, "--public-host");
  if (interactive) {
    const port = existing.MYBASE_PORT || "4000";
    const reach = await ask(
      p.multiselect({
        message: `Who should reach mybase? ${dim(`(this machine always can, at localhost:${port})`)}`,
        required: false,
        initialValues: [...(lan ? ["lan"] : []), ...(tunnel ? ["tunnel"] : [])],
        options: [
          { value: "lan", label: "Devices on my network or Tailscale", hint: "apps on other machines at home" },
          { value: "tunnel", label: "The internet, through a Cloudflare Tunnel", hint: "HTTPS on your domain, no router ports, home IP hidden" },
        ],
      }),
    );
    lan = reach.includes("lan");
    updates.MYBASE_PUBLIC_HOST = lan ? await chooseHost(existing.MYBASE_PUBLIC_HOST) : null;

    if (reach.includes("tunnel")) {
      const keep =
        tunnel &&
        (await ask(
          p.select({
            message: `A tunnel is set up for ${tunnel.apiHost}.`,
            options: [
              { value: true, label: "Keep it" },
              { value: false, label: "Set it up again" },
            ],
          }),
        ));
      if (!keep) {
        const result = await tunnelStep();
        Object.assign(updates, result.env);
        tunnel = result;
      }
      Object.assign(updates, await bindStep(lan, existing));
    } else if (tunnel) {
      for (const key of [...TUNNEL_KEYS, ...BIND_KEYS]) updates[key] = null;
      tunnel = null;
    }
  } else {
    if (publicHost) {
      updates.MYBASE_PUBLIC_HOST = publicHost;
      lan = true;
    }
    if (tunnelToken) {
      const domain = flag(args, "--domain");
      if (!tunnelIdFromToken(tunnelToken)) throw usageError("--tunnel-token isn't a Cloudflare tunnel token");
      if (!domain) throw usageError("--tunnel-token needs --domain (serves mybase.<domain> and s3.<domain>)");
      tunnel = { apiHost: `mybase.${domain}`, s3Host: `s3.${domain}` };
      Object.assign(updates, tunnelEnv(tunnelToken, tunnel.apiHost, tunnel.s3Host));
    }
  }

  // Tunnel changes must not switch off another optional host service.
  updates.COMPOSE_PROFILES = composeProfile(existing.COMPOSE_PROFILES, "tunnel", !!tunnel);

  // Admin account: only while the server doesn't have one.
  const env = () => ({ ...existing, ...(Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== null)) as Record<string, string>) });
  const needsAdmin = !running || (await setupNeeded(localUrl(env())));
  let admin: { username: string; password: string } | null = null;
  if (needsAdmin && interactive) admin = await adminStep();
  else if (needsAdmin && args.includes("--admin-password-stdin")) {
    const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
    if (password.length < ADMIN_PASSWORD_MIN) throw usageError(`the admin password must be at least ${ADMIN_PASSWORD_MIN} characters`);
    admin = { username: flag(args, "--admin-user") ?? "admin", password };
  }

  const boot = await bootStep(existing, interactive, args);
  updates.MYBASE_RESTART = boot.always ? null : "no";

  let sandboxes = args.includes("--sandboxes") || sandboxProfileOn(existing);
  if (interactive && !sandboxes) sandboxes = await ask(p.confirm({ message: "Set up agent sandboxes too? Installs gVisor and Chromium; each running sandbox gets 1 GB memory.", initialValue: false }));
  if (sandboxes) updates.COMPOSE_PROFILES = composeProfile(updates.COMPOSE_PROFILES ?? undefined, "sandbox", true);

  if (interactive) {
    const advanced = await ask(p.confirm({ message: `Change advanced settings? ${dim("(ports, cache memory, storage size, log level)")}`, initialValue: false }));
    if (advanced) Object.assign(updates, await advancedStep(env()));
  } else {
    const port = flag(args, "--port");
    if (port) {
      if (validPort(port)) throw usageError("--port needs a port number");
      updates.MYBASE_PORT = port;
    }
  }
  if (!running) Object.assign(updates, await portStep(env(), interactive));

  // Review.
  const final = envText ? mergeEnv(envText, updates) : renderEnv(env());
  const values = parseEnv(final);
  ui.note(
    [
      ...Object.entries(values).map(([k, v]) => `${k.padEnd(24)} ${isSecretKey(k) ? dim(maskSecret(v)) : v}`),
      "",
      dim(`Writes ${tilde(join(dir, ".env"))} (only you can read it) and ${tilde(join(dir, "compose.yml"))}`),
    ].join("\n"),
    "Settings",
  );
  if (interactive && !(await ask(p.confirm({ message: running ? "Save and restart mybase?" : "Save and start mybase?" })))) {
    p.outro("Nothing changed.");
    return;
  }

  await writeFiles(dir, final, interactive, yes);
  await saveServerDir(dir);
  ui.success(`Saved ${tilde(dir)}`);
  if (boot.enableDocker) await turnOnDockerAtBoot();
  if (sandboxes) {
    const { prepareSandboxHost } = await import("./server-sandbox");
    await prepareSandboxHost(["--dir", dir, "--yes", ...args], { start: false, confirmed: true });
  }
  const version = await startStack(dir, values);

  const url = localUrl(values);
  let signedIn: string | null = null;
  if (admin) {
    const s = ui.spinner();
    s.start("Creating the admin account");
    signedIn = await createAdmin(url, admin);
    s.stop(`Admin ${signedIn} created, and this CLI is signed in`);
  }

  const port = values.MYBASE_PORT || "4000";
  const urls = {
    local: url,
    network: values.MYBASE_PUBLIC_HOST ? `http://${values.MYBASE_PUBLIC_HOST}:${port}` : null,
    public: tunnel ? `https://${tunnel.apiHost}` : null,
    s3: values.MYBASE_S3_PUBLIC_URL ?? (values.MYBASE_PUBLIC_HOST ? `http://${values.MYBASE_PUBLIC_HOST}:${values.GARAGE_S3_PORT || "3900"}` : null),
  };
  if (jsonMode) {
    return print({ dir, version, urls, autostart: boot.always, adminCreated: Boolean(signedIn), signedIn: Boolean(signedIn), secretsKeyGenerated: Boolean(secrets.MYBASE_SECRETS_KEY) }, () => {});
  }

  ui.note(
    [
      `${"Dashboard".padEnd(16)} ${cyan(url)}`,
      ...(urls.network ? [`${"On your network".padEnd(16)} ${cyan(urls.network)}`] : []),
      ...(urls.public ? [`${"On the internet".padEnd(16)} ${cyan(urls.public)}  ${dim(`(S3: ${urls.s3})`)}`] : []),
      `${"Starts on boot".padEnd(16)} ${boot.always ? (dockerOnBoot() === "disabled" ? yellow("no: Docker doesn't start at boot") : "yes") : "no"}`,
      `${"CLI".padEnd(16)} ${signedIn ? `signed in as ${signedIn}` : `run ${bold(`mybase login --url ${url}`)} after creating the admin`}`,
      "",
      bold("Next"),
      ...(signedIn ? [] : [`  Open ${cyan(url)} and create the admin account`]),
      `  ${bold("mybase project create my-app")}   a database + bucket + credentials`,
      `  ${bold("mybase agent init")}              teach your coding agent about it`,
      `  Turn on two-factor sign-in in Settings${tunnel ? yellow("  (do this before sharing the public URL)") : ""}`,
      `  ${bold("mybase server status")} · ${bold("mybase server update")}`,
    ].join("\n"),
    "mybase is running",
  );

  if (secrets.MYBASE_SECRETS_KEY) {
    ui.warn(
      `${bold("Back up MYBASE_SECRETS_KEY")} (in ${tilde(join(dir, ".env"))}) somewhere other than this machine,\nlike a password manager. If it's lost, every stored secret is lost with it.`,
    );
    if (interactive && (await ask(p.confirm({ message: "Show it now so you can copy it?", initialValue: false })))) {
      p.log.message(secrets.MYBASE_SECRETS_KEY);
    }
  }
  p.outro(`Done. Config for this CLI: ${dim(tilde(configPath))}`);
}

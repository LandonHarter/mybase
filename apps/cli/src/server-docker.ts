// What `mybase server` needs from this machine: Docker checks, `docker compose` in the install
// directory, and facts for the setup wizard (Pi, memory, disk, addresses, Tailscale).
import { existsSync, readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { freemem, hostname, networkInterfaces, totalmem } from "node:os";
import composeYml from "../../../docker/compose.yml" with { type: "text" };
import { versionAtLeast } from "./server-env";

/** compose.yml uses inline `configs.content`. */
export const MIN_COMPOSE = "2.23.1";

export const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";

interface Run {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], cwd?: string): Run {
  try {
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
    return { ok: proc.exitCode === 0, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString().trim() };
  } catch {
    return { ok: false, stdout: "", stderr: `${cmd[0]} not found` };
  }
}

export interface DockerCheck {
  ok: boolean;
  docker?: string;
  compose?: string;
  /** Why it isn't ok, with what to do. */
  problem?: string;
}

/**
 * The environment for `docker compose`, minus every variable compose.yml reads. Compose prefers
 * the shell's values over the install's .env, and Bun loads the .env of whatever directory the
 * CLI runs in, so an app's POSTGRES_PASSWORD would otherwise leak into the server.
 */
export function composeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [, name] of composeYml.matchAll(/\$\{([A-Z0-9_]+)/g)) delete env[name!];
  for (const name of Object.keys(env)) if (name.startsWith("COMPOSE_")) delete env[name];
  return env;
}

export function checkDocker(): DockerCheck {
  const client = run(["docker", "--version"]);
  if (!client.ok) return { ok: false, problem: `Docker isn't installed. Install it first: ${DOCKER_INSTALL_URL}` };
  const server = run(["docker", "version", "--format", "{{.Server.Version}}"]);
  if (!server.ok) {
    const denied = /permission denied/i.test(server.stderr);
    return {
      ok: false,
      problem: denied
        ? "Docker is installed, but this user can't use it. Run `sudo usermod -aG docker $USER`, log out and back in, then try again."
        : "Docker is installed, but its daemon isn't running. Start it (`sudo systemctl start docker`) and try again.",
    };
  }
  const compose = run(["docker", "compose", "version", "--short"]);
  if (!compose.ok) return { ok: false, docker: server.stdout, problem: "Docker Compose v2 is missing. Install the docker-compose-plugin package." };
  if (!versionAtLeast(compose.stdout, MIN_COMPOSE)) {
    return { ok: false, docker: server.stdout, compose: compose.stdout, problem: `Docker Compose ${compose.stdout} is too old: mybase needs ${MIN_COMPOSE} or newer.` };
  }
  return { ok: true, docker: server.stdout, compose: compose.stdout.replace(/^v/, "") };
}

/** Runs `docker compose <args>` in the install directory, capturing output. */
export async function compose(dir: string, args: string[]): Promise<Run> {
  const proc = Bun.spawn(["docker", "compose", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: composeEnv() });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Whether this directory's stack has any containers (running or not). */
export async function stackExists(dir: string): Promise<boolean> {
  if (!existsSync(`${dir}/compose.yml`)) return false;
  const ps = await compose(dir, ["ps", "-a", "-q"]);
  return ps.ok && ps.stdout.length > 0;
}

/** Another directory already runs a compose project called `mybase` (they'd share containers). */
export function otherInstall(dir: string): string | null {
  const ls = run(["docker", "compose", "ls", "--all", "--format", "json"]);
  if (!ls.ok) return null;
  try {
    const projects = JSON.parse(ls.stdout) as { Name: string; ConfigFiles: string }[];
    const mine = projects.find((p) => p.Name === "mybase");
    if (!mine) return null;
    const file = mine.ConfigFiles.split(",")[0] ?? "";
    return file.startsWith(`${dir}/`) ? null : file.replace(/\/[^/]+$/, "");
  } catch {
    return null;
  }
}

export function portFree(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Polls `<url>/health` until it answers, for up to `timeoutMs`. Returns the server version. */
export async function waitHealthy(url: string, timeoutMs = 180_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return ((await res.json()) as { version?: string }).version ?? "unknown";
    } catch {}
    await Bun.sleep(2000);
  }
  return null;
}

export interface Machine {
  hostname: string;
  arch: string;
  /** "Raspberry Pi 5 Model B Rev 1.0", when it is one. */
  pi: string | null;
  totalMemGb: number;
  freeMemGb: number;
}

export function machine(): Machine {
  let pi: string | null = null;
  try {
    const model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
    if (model.includes("Raspberry Pi")) pi = model;
  } catch {}
  return { hostname: hostname(), arch: process.arch, pi, totalMemGb: totalmem() / 2 ** 30, freeMemGb: freemem() / 2 ** 30 };
}

/** Free space (GB) on the filesystem holding `dir` (or its nearest existing parent). */
export async function freeDiskGb(dir: string): Promise<number | null> {
  for (let d = dir; ; d = d.replace(/\/[^/]*$/, "") || "/") {
    if (existsSync(d)) {
      try {
        const s = await statfs(d);
        return (s.bavail * s.bsize) / 2 ** 30;
      } catch {
        return null;
      }
    }
    if (d === "/") return null;
  }
}

export interface Address {
  value: string;
  label: string;
}

/** Names and addresses other machines might reach this one by, best first. */
export function addresses(): Address[] {
  const out: Address[] = [];
  const ts = run(["tailscale", "status", "--json"]);
  if (ts.ok) {
    try {
      const self = (JSON.parse(ts.stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
      const dns = self?.DNSName?.replace(/\.$/, "");
      if (dns) out.push({ value: dns, label: "Tailscale (MagicDNS)" });
      const ip = self?.TailscaleIPs?.find((a) => a.includes("."));
      if (ip) out.push({ value: ip, label: "Tailscale IP" });
    } catch {}
  }
  const host = hostname();
  out.push({ value: `${host}.local`, label: "mDNS name (most home networks)" });
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|tailscale|lo|cni|flannel)/.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ value: a.address, label: `LAN IP (${name})` });
    }
  }
  return out;
}

/**
 * Whether Docker itself starts at boot (the containers' restart policy brings mybase back with it).
 * `enabled`/`disabled` on systemd, `desktop` for Docker Desktop (a setting in its app), else `unknown`.
 */
export function dockerOnBoot(): "enabled" | "disabled" | "desktop" | "unknown" {
  if (process.platform === "darwin" || process.platform === "win32") return "desktop";
  const state = run(["systemctl", "is-enabled", "docker.service"]);
  if (state.stdout === "enabled") return "enabled";
  if (state.stdout === "disabled" || state.stdout === "masked") return "disabled";
  return "unknown";
}

/** `sudo systemctl enable docker` with the terminal attached, so sudo can ask for a password. */
export async function enableDockerOnBoot(): Promise<boolean> {
  const cmd = process.getuid?.() === 0 ? ["systemctl", "enable", "docker.service", "containerd.service"] : ["sudo", "systemctl", "enable", "docker.service", "containerd.service"];
  try {
    const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export interface TunnelConnection {
  index: number;
  /** Cloudflare data center, e.g. `ord08`. */
  location: string;
  protocol: string | null;
}

/** Connections cloudflared holds right now, from its logs (oldest line first). */
export function tunnelConnections(logs: string): TunnelConnection[] {
  const conns = new Map<number, TunnelConnection>();
  for (const line of logs.split("\n")) {
    // A restarted container keeps its old logs above the new run's.
    if (/Starting tunnel/.test(line)) conns.clear();
    const index = Number(/connIndex=(\d+)/.exec(line)?.[1]);
    if (Number.isNaN(index)) continue;
    if (/Registered tunnel connection/.test(line)) {
      const location = /location=(\S+)/.exec(line)?.[1];
      if (location) conns.set(index, { index, location, protocol: /protocol=(\S+)/.exec(line)?.[1] ?? null });
    } else if (/Unregistered tunnel connection|Connection terminated|Retrying connection|Serve tunnel error/.test(line)) {
      conns.delete(index);
    }
  }
  return [...conns.values()].sort((a, b) => a.index - b.index);
}

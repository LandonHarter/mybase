import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, jsonMode } from "./output";
import { versionAtLeast } from "./server-env";

export interface HostResult { ok: boolean; stdout: string; stderr: string }
export type HostRunner = (args: string[], options?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; inherit?: boolean }) => Promise<HostResult>;
async function tail(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text = (text + decoder.decode(chunk, { stream: true })).slice(-65536);
  return (text + decoder.decode()).trim();
}
export const hostRun: HostRunner = async (args, options = {}) => {
  try {
    const common = { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 30_000, killSignal: "SIGKILL" as const };
    if (options.inherit) {
      const child = Bun.spawn(args, { ...common, stdio: ["inherit", "inherit", "inherit"] });
      return { ok: (await child.exited) === 0, stdout: "", stderr: "" };
    }
    const child = Bun.spawn(args, { ...common, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([tail(child.stdout), tail(child.stderr), child.exited]);
    return { ok: code === 0, stdout, stderr };
  } catch { return { ok: false, stdout: "", stderr: `${args[0]} could not be started or timed out` }; }
};

export interface SandboxDockerInfo {
  Architecture: string; OperatingSystem: string; KernelVersion: string; CgroupVersion: string;
  MemoryLimit: boolean; SwapLimit: boolean; CpuCfsQuota?: boolean; PidsLimit: boolean;
  Runtimes: Record<string, unknown>; SecurityOptions?: string[];
}
export function checkSandboxDocker(info: SandboxDockerInfo, endpoint: string, platform = process.platform) {
  if (platform !== "linux" || /docker desktop/i.test(info.OperatingSystem)) throw new CliError("automatic sandbox setup needs a Linux Docker host, not Docker Desktop. Run this command on the machine running the Linux Docker daemon");
  if (!endpoint.startsWith("unix://")) throw new CliError("Docker points at a remote daemon. Run `mybase server sandbox` on that Docker host; local setup cannot install a runtime on a remote machine");
  if (info.SecurityOptions?.some(s => /rootless/i.test(s))) throw new CliError("sandbox Compose setup needs rootful Docker with cgroup v2; this Docker daemon is rootless");
  if (!["amd64", "x86_64", "arm64", "aarch64"].includes(info.Architecture)) throw new CliError("sandboxes support Linux amd64 and arm64 hosts only (use a 64-bit OS on a Raspberry Pi)");
  if (!versionAtLeast(info.KernelVersion, "5.6.0")) throw new CliError("gVisor requires Linux 5.6 or newer");
  // Some Docker versions omit CpuCfsQuota entirely. The bounded Chromium probe below
  // verifies the actual --cpus enforcement instead of rejecting a missing informational field.
  const missing = [
    info.CgroupVersion !== "2" ? "cgroup v2" : null,
    !info.MemoryLimit ? "memory limits" : null,
    !info.SwapLimit ? "swap accounting" : null,
    info.CpuCfsQuota === false ? "CPU quotas" : null,
    !info.PidsLimit ? "process limits" : null,
  ].filter(Boolean);
  if (missing.length) throw new CliError(`sandboxes require working cgroup v2 resource controllers; missing: ${missing.join(", ")}. The host kernel/Docker configuration needs those enabled first`);
}
export function gvisorChecksum(text: string): string {
  const match = /^([a-f0-9]{128})\s+\*?gvisor\.tar\.bz2\s*$/i.exec(text.trim());
  if (!match) throw new CliError("gVisor release checksum has an unexpected format");
  return match[1]!.toLowerCase();
}
export function gvisorArchiveMembers(text: string) {
  const members = text.trim().split("\n").map(s => s.replace(/^\.\//, ""));
  if (!members.includes("runsc") || !members.includes("gvisor-bin/gvisor_sentry")) throw new CliError("gVisor release is missing runsc or its required sidecars");
  if (members.some(s => s.startsWith("/") || s.split("/").includes("..") || !/^(runsc|containerd-shim-runsc-v1|gvisor-bin\/?|gvisor-bin\/[a-zA-Z0-9_-]+)$/.test(s))) throw new CliError("gVisor release has unexpected archive paths");
}

/** Installs only when missing. Docker reload supports runtimes without restarting existing containers. */
export async function installGvisor(info: SandboxDockerInfo, run: HostRunner = hostRun) {
  if (info.Runtimes.runsc) return false;
  let binary: string | null = null;
  for (const path of ["/usr/local/bin/runsc", "/usr/bin/runsc"]) {
    try { await access(path, constants.X_OK); binary = path; break; } catch {}
  }
  const root = await mkdtemp(join(tmpdir(), "mybase-gvisor-"));
  try {
    let archive: string | null = null;
    if (!binary) {
      const arch = ["arm64", "aarch64"].includes(info.Architecture) ? "aarch64" : "x86_64";
      const base = `https://storage.googleapis.com/gvisor/releases/release/latest/${arch}`;
      const checksum = await fetch(`${base}/gvisor.tar.bz2.sha512`, { signal: AbortSignal.timeout(30_000) });
      if (!checksum.ok) throw new CliError("couldn't download the gVisor release checksum");
      const expected = gvisorChecksum(await checksum.text());
      const response = await fetch(`${base}/gvisor.tar.bz2`, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new CliError("couldn't download the gVisor release bundle");
      archive = join(root, "gvisor.tar.bz2");
      const sink = Bun.file(archive).writer();
      const hash = createHash("sha512");
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 128 * 1024 * 1024) throw new CliError("gVisor release exceeds the download limit");
          hash.update(chunk); sink.write(chunk); await sink.flush();
        }
      } finally { await sink.end(); }
      if (hash.digest("hex") !== expected) throw new CliError("gVisor checksum mismatch; nothing was installed. Retry the command to download a fresh release");
      const contents = await run(["tar", "-tjf", archive]);
      if (!contents.ok) throw new CliError("couldn't read the gVisor release bundle; install tar and bzip2 on this host");
      gvisorArchiveMembers(contents.stdout);
      binary = "/usr/local/bin/runsc";
    }
    const sudo = process.getuid?.() === 0 ? [] : ["sudo", "-n", "--"];
    if (sudo.length) {
      let auth = await run(["sudo", "-n", "true"]);
      if (!auth.ok && process.stdin.isTTY && !jsonMode) auth = await run(["sudo", "-v"], { inherit: true, timeoutMs: 300_000 });
      if (!auth.ok) throw new CliError("installing/registering gVisor needs host administrator privileges. Run `sudo -v` on this host, then retry (use --yes without a terminal). No Docker commands or manual configuration are needed");
    }
    if (archive) {
      const unpack = await run([...sudo, "tar", "-xjf", archive, "-C", "/usr/local/bin"]);
      if (!unpack.ok) throw new CliError(`couldn't install gVisor: ${unpack.stderr}`);
    }
    const registered = await run([...sudo, binary!, "install"]);
    if (!registered.ok) throw new CliError(`couldn't register gVisor with Docker: ${registered.stderr}`);
    const reloaded = await run([...sudo, "systemctl", "reload", "docker"]);
    if (!reloaded.ok) throw new CliError("gVisor was installed, but Docker's systemd service couldn't reload. Reload the daemon's runtime configuration on this host, then rerun this command; existing containers were not restarted");
    return true;
  } finally { await rm(root, { recursive: true, force: true }); }
}

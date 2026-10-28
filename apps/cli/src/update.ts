// `mybase update`: replaces this CLI binary with the latest GitHub release, then updates the server
// on this machine (if `mybase server setup` installed one) with the new binary, so its compose.yml is current.
import { chmod, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "./api";
import { loadConfig } from "./config";
import { CliError, jsonMode, print } from "./output";

export const updateUsage = `  update [--version <v>] [--cli] [--yes]
                                 Update this CLI to the latest release (or <v>), then the server on this
                                 machine, if there is one. --cli: only the CLI`;

const REPO = "landonharter/mybase";

/** Compiled binaries run from Bun's embedded filesystem; the npm bundle runs from a real path. */
export const isCompiled = () => Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");

/** The release asset for this machine, e.g. `mybase-linux-arm64`. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["linux", "darwin", "windows"].includes(os)) throw new CliError(`no mybase binary for ${platform}`);
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!cpu) throw new CliError(`no mybase binary for ${arch} CPUs`);
  return `mybase-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** The latest release's version, from where /releases/latest redirects (no API rate limit). */
async function latestVersion(): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" }).catch(() => {
    throw new CliError("can't reach github.com to check for updates");
  });
  const tag = /\/tag\/v?([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1];
  if (!tag) throw new CliError(`couldn't find the latest release (GitHub answered ${res.status})`);
  return tag;
}

/** `1.0.10` > `1.0.9`. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Downloads `version` next to the running binary, checks it starts, and swaps it in. */
async function replaceBinary(version: string) {
  const target = process.execPath;
  const url = `https://github.com/${REPO}/releases/download/v${version}/${assetName()}`;
  const res = await fetch(url).catch(() => {
    throw new CliError(`can't download ${url}`);
  });
  if (!res.ok) throw new CliError(`can't download ${url} (${res.status})`);
  const temp = `${target}.new`;
  try {
    // Streamed by hand: `Bun.write(path, response)` stalls on large downloads.
    const writer = Bun.file(temp).writer();
    for await (const chunk of res.body!) writer.write(chunk);
    await writer.end();
    await chmod(temp, 0o755);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new CliError(`can't write next to ${target}. Run it with sudo, or reinstall: curl -fsSL https://raw.githubusercontent.com/${REPO}/master/scripts/install.sh | sh`);
    throw err;
  }
  const check = Bun.spawnSync([temp, "help"], { stdout: "ignore", stderr: "ignore" });
  if (check.exitCode !== 0) {
    await rm(temp, { force: true });
    throw new CliError(`the downloaded binary doesn't run on this machine; kept ${CLI_VERSION}`);
  }
  // Windows can't overwrite a running .exe, but it can rename it.
  if (process.platform === "win32") {
    await rm(`${target}.old`, { force: true });
    await rename(target, `${target}.old`);
  }
  await rename(temp, target);
}

/** Runs `server update` with the given binary (the new one, so its compose.yml is used). */
async function updateServer(bin: string[], dir: string): Promise<boolean> {
  const args = [...bin, "server", "update", "--dir", dir, ...(jsonMode ? ["--json", "--yes"] : [])];
  const proc = Bun.spawn(args, { stdio: [jsonMode ? "ignore" : "inherit", jsonMode ? "ignore" : "inherit", "inherit"] });
  return (await proc.exited) === 0;
}

export async function update(args: string[]) {
  const versionIndex = args.indexOf("--version");
  const wanted = versionIndex === -1 ? null : args[versionIndex + 1]?.replace(/^v/, "");
  if (versionIndex !== -1 && !wanted) throw new CliError("--version needs a value", 2);
  const yes = args.includes("--yes");
  const result: { cli: { from: string; to: string; updated: boolean }; server: { dir: string; updated: boolean } | null } = {
    cli: { from: CLI_VERSION, to: CLI_VERSION, updated: false },
    server: null,
  };

  // The CLI.
  if (!isCompiled()) {
    if (!jsonMode) console.log("This CLI was installed with npm/bun. Update it with: bun add -g @mybase-dev/cli@latest (or npm i -g)");
  } else {
    const target = wanted ?? (await latestVersion());
    result.cli.to = target;
    if (target === CLI_VERSION || (!wanted && !newer(target, CLI_VERSION))) {
      if (!jsonMode) console.log(`CLI ${CLI_VERSION} is up to date.`);
    } else {
      if (!jsonMode) console.log(`Updating the CLI: ${CLI_VERSION} → ${target}`);
      await replaceBinary(target);
      result.cli.updated = true;
      if (!jsonMode) console.log(`CLI ${target} installed at ${process.execPath}`);
    }
  }

  // The server on this machine, if setup installed one.
  const dir = (await loadConfig()).server;
  const installed = dir && (await Bun.file(join(dir, "compose.yml")).exists());
  if (installed && !args.includes("--cli")) {
    let go = yes || jsonMode;
    if (!go && process.stdin.isTTY) {
      const answer = prompt(`Update the server in ${dir} too? (new images, restart) [Y/n]`);
      go = answer === null || /^(y|yes|)$/i.test(answer.trim());
    }
    if (go) {
      // A compiled binary re-runs itself (now the new version); the npm bundle runs its own entry.
      const bin = isCompiled() ? [process.execPath] : [process.execPath, Bun.main];
      const ok = await updateServer(bin, dir);
      result.server = { dir, updated: ok };
      if (!ok) throw new CliError(`the server update failed${result.cli.updated ? ` (the CLI is ${result.cli.to} now)` : ""}. Run \`mybase server update\` to see why.`);
    } else if (!jsonMode) console.log("Server left as it is. Update it later with: mybase server update");
  }

  print(result, () => {});
}

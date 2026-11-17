// `mybase update`: replaces this CLI binary with the latest GitHub release, then updates the server
// on this machine (if `mybase server setup` installed one) with the new binary, so its compose.yml is current.
// `--edge` instead runs the server on a master commit's images (`:sha-<7>`, built by docker.yml on every
// push) with that commit's compose.yml, for testing without a release.
import { chmod, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "./api";
import { loadConfig } from "./config";
import { CliError, jsonMode, print } from "./output";
import { mergeEnv, parseEnv } from "./server-env";
import { writeCompose } from "./server-setup";

export const updateUsage = `  update [--version <v>] [--cli] [--yes]
                                 Update this CLI to the latest release (or <v>), then the server on this
                                 machine, if there is one. --cli: only the CLI
  update --edge [--ref <branch|sha>]
                                 Run the server on the newest master commit's images and compose.yml
                                 (no release needed; the CLI stays). A plain \`update\` switches back`;

const REPO = "landonharter/mybase";
const GHCR = "ghcr.io/landonharter";
/** Images docker.yml tags `sha-<7>` on every master push. Sandbox images follow MYBASE_IMAGE's tag on their own. */
const EDGE_IMAGES = { MYBASE_IMAGE: "mybase", MYBASE_HOSTING_WORKER_IMAGE: "mybase-hosting-worker" } as const;
const CHECK_IMAGES = ["mybase", "mybase-hosting-worker", "mybase-sandbox", "mybase-sandbox-worker"];

const isEdgeImage = (value: string | undefined, name: string) => !!value?.startsWith(`${GHCR}/${name}:`) && /:sha-[a-f0-9]{7,40}$/.test(value);

/**
 * .env changes for `--edge` at `sha` (or null: back to releases). Only official images are switched;
 * a custom MYBASE_IMAGE (a local build) is refused rather than silently replaced.
 */
export function edgeEnv(values: Record<string, string>, sha: string | null): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  if (sha === null) {
    if (values.MYBASE_EDGE) updates.MYBASE_EDGE = null;
    for (const [key, name] of Object.entries(EDGE_IMAGES)) if (isEdgeImage(values[key], name)) updates[key] = null;
    return updates;
  }
  const tag = `sha-${sha.slice(0, 7)}`;
  for (const [key, name] of Object.entries(EDGE_IMAGES)) {
    const current = values[key];
    if (current && !isEdgeImage(current, name) && current !== `${GHCR}/${name}:latest`) {
      throw new CliError(`${key} is set to ${current} in .env; remove it to use --edge`);
    }
    updates[key] = `${GHCR}/${name}:${tag}`;
  }
  updates.MYBASE_EDGE = sha;
  return updates;
}

/** The full sha `ref` (a branch or sha) points at on GitHub. */
async function resolveRef(ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: "application/vnd.github.sha", "user-agent": "mybase-cli" },
  }).catch(() => {
    throw new CliError("can't reach api.github.com to find the commit");
  });
  const body = (await res.text()).trim();
  if (res.status === 403 || res.status === 429) throw new CliError("GitHub's API rate limit is used up (60/hour without a token); try again later, or pass --ref <sha>");
  if (!res.ok || !/^[a-f0-9]{40}$/.test(body)) throw new CliError(`couldn't find ${ref} on GitHub (${res.status})`, 4);
  return body;
}

/** Whether GHCR has `name:tag` (anonymous pull token, manifest HEAD). */
async function imagePublished(name: string, tag: string): Promise<boolean> {
  const repo = `landonharter/${name}`;
  try {
    const auth = (await (await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json()) as { token?: string };
    const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${auth.token ?? ""}`,
        accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new Error(String(res.status));
  } catch (err) {
    throw new CliError(`can't check ghcr.io for ${name}:${tag} (${(err as Error).message})`);
  }
}

/** That commit's docker/compose.yml. */
async function fetchCompose(sha: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/docker/compose.yml`;
  const res = await fetch(url).catch(() => {
    throw new CliError(`can't download ${url}`);
  });
  const text = await res.text();
  if (!res.ok || !/^services:/m.test(text)) throw new CliError(`can't download ${url} (${res.status})`);
  return text;
}

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
    if (code === "EACCES" || code === "EPERM") throw new CliError(`can't write next to ${target}. Run it with sudo, or reinstall: curl -fsSL https://usemybase.dev/install.sh | sh`);
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

/** The installed server's directory, or null. */
async function serverInstall(): Promise<string | null> {
  const dir = (await loadConfig()).server;
  return dir && (await Bun.file(join(dir, "compose.yml")).exists()) ? dir : null;
}

async function edge(args: string[]) {
  if (args.includes("--cli") || args.includes("--version")) throw new CliError("--edge updates only the server; it can't be combined with --cli or --version", 2);
  const refIndex = args.indexOf("--ref");
  const ref = refIndex === -1 ? "master" : args[refIndex + 1];
  if (!ref) throw new CliError("--ref needs a value", 2);
  const dir = await serverInstall();
  if (!dir) throw new CliError("no server on this machine (install one with `mybase server setup`)", 4);

  const sha = await resolveRef(ref);
  const tag = `sha-${sha.slice(0, 7)}`;
  if (!jsonMode) console.log(`Commit ${sha.slice(0, 7)} (${ref})`);
  const missing: string[] = [];
  for (const name of CHECK_IMAGES) if (!(await imagePublished(name, tag))) missing.push(name);
  if (missing.length) {
    throw new CliError(`images for ${sha.slice(0, 7)} aren't on ghcr.io yet (${missing.join(", ")}). The docker workflow is probably still running; try again when it's done.`, 4);
  }

  const envPath = join(dir, ".env");
  const envText = await Bun.file(envPath).text();
  const updates = edgeEnv(parseEnv(envText), sha);
  const composeText = await fetchCompose(sha);
  const composePath = join(dir, "compose.yml");
  const current = await Bun.file(composePath).text();
  if (current !== composeText) {
    await Bun.write(join(dir, "compose.yml.bak"), current);
    await Bun.write(composePath, composeText);
  }
  await Bun.write(envPath, mergeEnv(envText, updates));
  if (!jsonMode) console.log(`Server set to ${tag} images and that commit's compose.yml (switch back: mybase update)`);

  const bin = isCompiled() ? [process.execPath] : [process.execPath, Bun.main];
  const ok = await updateServer(bin, dir);
  if (!ok) throw new CliError("the server update failed. Run `mybase server update` to see why.");
  print({ edge: { ref, sha, tag }, server: { dir, updated: ok } }, () => {});
}

/** Undoes `--edge` before a normal update: release images and this CLI's compose.yml again. */
async function leaveEdge(dir: string) {
  const envPath = join(dir, ".env");
  const envText = await Bun.file(envPath).text();
  const updates = edgeEnv(parseEnv(envText), null);
  if (!Object.keys(updates).length) return;
  await Bun.write(envPath, mergeEnv(envText, updates));
  await writeCompose(dir, false, true);
  if (!jsonMode) console.log("Switching the server back to release images.");
}

export async function update(args: string[]) {
  if (args.includes("--edge")) return edge(args);
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
  const dir = await serverInstall();
  if (dir && !args.includes("--cli")) {
    let go = yes || jsonMode;
    if (!go && process.stdin.isTTY) {
      const answer = prompt(`Update the server in ${dir} too? (new images, restart) [Y/n]`);
      go = answer === null || /^(y|yes|)$/i.test(answer.trim());
    }
    if (go) {
      await leaveEdge(dir);
      // A compiled binary re-runs itself (now the new version); the npm bundle runs its own entry.
      const bin = isCompiled() ? [process.execPath] : [process.execPath, Bun.main];
      const ok = await updateServer(bin, dir);
      result.server = { dir, updated: ok };
      if (!ok) throw new CliError(`the server update failed${result.cli.updated ? ` (the CLI is ${result.cli.to} now)` : ""}. Run \`mybase server update\` to see why.`);
    } else if (!jsonMode) console.log("Server left as it is. Update it later with: mybase server update");
  }

  print(result, () => {});
}

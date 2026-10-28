// Where `mybase login` keeps the API URL and token: ~/.config/mybase/config.json, readable only by you.
// `mybase secrets setup` keeps a project + env per directory there too (nothing goes in the repo).
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** What `mybase run` and `mybase secrets …` use in a directory (and its subdirectories). */
export interface DirSetup {
  project: string;
  env: string;
}

export interface CliConfig {
  url: string;
  token: string;
  /** By absolute directory. */
  dirs?: Record<string, DirSetup>;
  /** Where `mybase server setup` installed the server on this machine. */
  server?: string;
}

export const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mybase", "config.json");

export async function loadConfig(): Promise<Partial<CliConfig>> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return {};
  try {
    return (await file.json()) as Partial<CliConfig>;
  } catch {
    throw new Error(`${configPath} isn't valid JSON. Fix it, or delete it and run \`mybase login\` again.`);
  }
}

async function writeConfig(config: Partial<CliConfig>) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await chmod(configPath, 0o600);
}

/** Saves a login, keeping directory setups and the server directory. */
export async function saveConfig(config: Pick<CliConfig, "url" | "token">) {
  const { url: _url, token: _token, ...rest } = await loadConfig();
  await writeConfig({ ...config, ...rest });
}

/** Forgets the login, keeping directory setups and the server directory. */
export async function clearConfig() {
  const { url: _url, token: _token, ...rest } = await loadConfig();
  await writeConfig(rest);
}

/** Remembers where the server is installed, for `mybase server status|update|tunnel`. */
export async function saveServerDir(dir: string) {
  await writeConfig({ ...(await loadConfig()), server: resolve(dir) });
}

/** The setup for `dir` or its nearest parent that has one. */
export async function dirSetup(dir = process.cwd()): Promise<(DirSetup & { dir: string }) | null> {
  const { dirs = {} } = await loadConfig();
  for (let d = resolve(dir); ; d = dirname(d)) {
    const setup = dirs[d];
    if (setup) return { ...setup, dir: d };
    if (d === dirname(d)) return null;
  }
}

export async function saveDirSetup(dir: string, setup: DirSetup) {
  const config = await loadConfig();
  await writeConfig({ ...config, dirs: { ...config.dirs, [resolve(dir).replace(new RegExp(`\\${sep}$`), "") || sep]: setup } });
}

// Where `mybase login` keeps the API URL and token: ~/.config/mybase/config.json, readable only by you.
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  url: string;
  token: string;
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

export async function saveConfig(config: CliConfig) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await chmod(configPath, 0o600);
}

export async function clearConfig() {
  await rm(configPath, { force: true });
}

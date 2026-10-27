// `mybase run -- <command>`: starts a command with an env's secrets as environment variables.
// Fails closed: if the secrets can't be fetched, the command doesn't start.
import { constants } from "node:os";
import { parseArgs } from "./cron";
import { CliError, splitRunArgs, usageError } from "./output";
import { expandShortFlags, fetchSecrets, target } from "./secrets";

export const runUsage = `  run [-p <project>] [-e <env>] [--preserve-env] -- <command> [args…]
                                 Start <command> with the env's secrets as env vars
                                 (--preserve-env: vars already set win over secrets)`;

export async function run(args: string[]) {
  const { options, command } = splitRunArgs(args);
  if (command.length === 0) throw usageError(`missing command\n\n${runUsage}`);
  const { flags } = parseArgs(expandShortFlags(options));
  const { project, env } = await target(flags);

  const { secrets } = await fetchSecrets(project, env);
  const vars: Record<string, string | undefined> = flags.has("preserve-env") ? { ...secrets, ...process.env } : { ...process.env, ...secrets };
  vars.MYBASE_PROJECT ??= project;
  vars.MYBASE_ENV = env;

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(command, { env: vars, stdio: ["inherit", "inherit", "inherit"] });
  } catch {
    throw new CliError(`command not found: ${command[0]}`, 127);
  }
  // Ctrl-C already reaches the child (same process group); stay alive until it exits.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => proc.kill(signal));
  const code = await proc.exited;
  const signal = proc.signalCode;
  process.exit(signal ? 128 + (constants.signals[signal as keyof typeof constants.signals] ?? 0) : code);
}

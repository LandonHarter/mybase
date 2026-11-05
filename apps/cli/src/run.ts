// `mybase run -- <command>`: starts a command with an env's secrets as environment variables.
// Fails closed: if the secrets can't be fetched, the command doesn't start.
// Linked keys (`secrets link --database` …) resolve for this machine: the routes are probed
// first (reach.ts), and when the database is only reachable through the API's WebSocket, a local
// proxy (`mybase db proxy`) runs for as long as the command does.
import { constants } from "node:os";
import { parseArgs } from "./cron";
import { CliError, splitRunArgs, usageError } from "./output";
import { startDbProxy, type DbProxy } from "./db-proxy";
import { planReach, reachQuery } from "./reach";
import { expandShortFlags, fetchSecrets, target } from "./secrets";

export const runUsage = `  run [-p <project>] [-e <env>] [--preserve-env] -- <command> [args…]
                                 Start <command> with the env's secrets as env vars
                                 (--preserve-env: vars already set win over secrets)`;

export async function run(args: string[]) {
  const { options, command } = splitRunArgs(args);
  if (command.length === 0) throw usageError(`missing command\n\n${runUsage}`);
  const { flags } = parseArgs(expandShortFlags(options));
  const { project, env } = await target(flags);

  const plan = await planReach(project, env);
  let proxy: DbProxy | null = null;
  if (plan.needsProxy) proxy = await startDbProxy(0, { onError: (m) => console.error(`mybase run: database proxy: ${m}`) });
  let secrets: Record<string, string>;
  try {
    const res = await fetchSecrets(project, env, reachQuery(plan, proxy?.port ?? null));
    secrets = res.secrets;
    // An env route override may have made the proxy unnecessary.
    if (proxy && !Object.values(res.links ?? {}).some((l) => l.route === "proxy")) {
      proxy.stop();
      proxy = null;
    }
  } catch (err) {
    proxy?.stop();
    throw err;
  }
  if (proxy) console.error(`mybase run: database through the local proxy on 127.0.0.1:${proxy.port} (no direct route from this machine)`);
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
  proxy?.stop();
  const signal = proc.signalCode;
  process.exit(signal ? 128 + (constants.signals[signal as keyof typeof constants.signals] ?? 0) : code);
}

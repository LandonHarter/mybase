// How the CLI talks back: human lines by default, JSON with `--json` (for scripts and agents).
// Exit codes: 1 failure, 2 usage, 3 not signed in / bad token, 4 not found.

/** `mybase run` options that take a value. */
const RUN_VALUE_FLAGS = new Set(["-p", "-e", "--project", "--env"]);

/**
 * `mybase run` args: its own options, then the command, which starts after a `--` or at the
 * first non-option, whichever comes first (so `mybase run npm test -- --watch` keeps its `--`).
 */
export function splitRunArgs(args: string[]): { options: string[]; command: string[] } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (args[i] === "--") return { options: args.slice(0, i), command: args.slice(i + 1) };
    i += RUN_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
  }
  return { options: args.slice(0, i), command: args.slice(i) };
}

/** The args that are ours: not the command `mybase run` starts, nor anything after a `--`. */
export function ownArgs(args: string[]): string[] {
  if (args[0] === "run") return ["run", ...splitRunArgs(args.slice(1)).options];
  const dash = args.indexOf("--");
  return dash === -1 ? args : args.slice(0, dash);
}

/** `--json` anywhere in our own args. index.ts strips it before parsing. */
export const jsonMode = ownArgs(Bun.argv.slice(2)).includes("--json");

/** An error with its own exit code (and HTTP status, when it came from the API). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, 2);

/** Prints `data` as JSON with `--json`, else runs `human`. */
export function print(data: unknown, human: () => void) {
  if (jsonMode) console.log(JSON.stringify(data ?? null, null, 2));
  else human();
}

/**
 * Asks the user to type `expected` before something destructive. Without a terminal to ask on
 * (piped, CI, an agent) or with `--json`, it fails instead of waiting: pass `--yes`.
 */
export function confirm(yes: boolean, warning: string, expected: string, what = expected) {
  if (yes) return;
  if (jsonMode || !process.stdin.isTTY) throw usageError(`refusing without --yes (no terminal to confirm): ${warning}`);
  console.log(warning);
  if (prompt(`Type ${what} to confirm:`) !== expected) throw new CliError("confirmation did not match, nothing changed");
}

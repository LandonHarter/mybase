// How the CLI talks back: human lines by default, JSON with `--json` (for scripts and agents).
// Exit codes: 1 failure, 2 usage, 3 not signed in / bad token, 4 not found.

/** `--json` anywhere on the command line. index.ts strips it before parsing. */
export const jsonMode = process.argv.includes("--json");

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

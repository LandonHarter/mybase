// `mybase login|logout|whoami`: signs the CLI in with an API token kept in config.json.
import { hostname } from "node:os";
import type { AuthStatus, LoginResponse } from "@mybase/shared";
import { api, API_URL, CLI_VERSION } from "./api";
import { clearConfig, configPath, loadConfig, saveConfig } from "./config";
import { print } from "./output";
import { describeGrant } from "./token";

export const authUsage = `  login [--url <url>]            Sign in (saves an API token to ${configPath.replace(process.env.HOME ?? "~", "~")})
  logout                         Revoke the saved token and forget it
  whoami                         Show which server and account the CLI uses
  version                        Show the CLI and server versions`;

// Piped input (`printf 'admin\npw\n' | mybase login`): read it all once, hand out a line per question.
let piped: string[] | null = null;
async function pipedLine(): Promise<string> {
  piped ??= (await Bun.stdin.text()).split(/\r?\n/);
  return piped.shift() ?? "";
}

async function readLine(label: string): Promise<string> {
  return process.stdin.isTTY ? (prompt(label) ?? "") : pipedLine();
}

/** Reads a line without echoing it. */
async function readSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return pipedLine();
  process.stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        }
        if (ch === "\u0003") {
          done();
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function login(args: string[]) {
  const urlIndex = args.indexOf("--url");
  const url = (urlIndex === -1 ? API_URL : args[urlIndex + 1])?.replace(/\/$/, "");
  if (!url) throw new Error("--url needs a value");
  const username = (await readLine("Username:")).trim();
  if (!username) throw new Error("missing username");
  const password = await readSecret("Password: ");
  const tokenName = `cli on ${hostname()}`;

  const res = await fetch(`${url}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, tokenName }),
  }).catch(() => {
    throw new Error(`can't reach the API at ${url}`);
  });
  const body = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? res.statusText);

  // Replace any earlier login, and revoke its token so tokens don't pile up.
  const previous = await loadConfig();
  await saveConfig({ url, token: body.token });
  if (previous.token && previous.url) await api("/auth/logout", { method: "POST", url: previous.url, token: previous.token }).catch(() => {});
  console.log(`Signed in to ${url} as ${body.username}. Token "${tokenName}" saved to ${configPath}.`);
  if (process.env.MYBASE_API_URL && process.env.MYBASE_API_URL.replace(/\/$/, "") !== url) {
    console.log(`Note: MYBASE_API_URL is set to ${process.env.MYBASE_API_URL}, and it overrides the saved URL.`);
  }
}

async function logout() {
  const config = await loadConfig();
  if (!config.token) {
    console.log("Not signed in.");
    return;
  }
  // Revoke first; forget it locally either way.
  await api("/auth/logout", { method: "POST", url: config.url, token: config.token }).catch((err: Error) => console.error(`warning: couldn't revoke the token: ${err.message}`));
  await clearConfig();
  console.log("Signed out.");
}

/** The server's version, or null when it's too old to say. */
async function serverVersion(): Promise<string | null> {
  const health = await api<{ version?: string }>("/health");
  return health.version ?? null;
}

/** A warning when the CLI and server differ in major or minor version. */
function versionSkew(server: string | null): string | null {
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  if (server === null) return `the server doesn't report a version; it's older than this CLI (${CLI_VERSION}).`;
  if (minor(server) === minor(CLI_VERSION)) return null;
  const [sMajor = 0, sMinor = 0] = server.split(".").map(Number);
  const [cMajor = 0, cMinor = 0] = CLI_VERSION.split(".").map(Number);
  const older = sMajor > cMajor || (sMajor === cMajor && sMinor > cMinor) ? "CLI" : "server";
  return `CLI ${CLI_VERSION} and server ${server} differ. Update the ${older} (see ${API_URL}/docs/quickstart.md).`;
}

async function whoami() {
  const [status, server] = await Promise.all([api<AuthStatus>("/auth/me"), serverVersion()]);
  const warning = versionSkew(server);
  print({ url: API_URL, cliVersion: CLI_VERSION, serverVersion: server, ...status }, () => {
    if (!status.authenticated) console.log(`not signed in to ${API_URL}. Run \`mybase login\`.`);
    else {
      const grant = status.permissions ? ` (${describeGrant({ permissions: status.permissions, projects: status.projects })})` : "";
      console.log(`${status.username} on ${API_URL}${grant}`);
    }
    if (warning) console.error(`warning: ${warning}`);
  });
}

async function version() {
  const server = await serverVersion().catch(() => null);
  const warning = server ? versionSkew(server) : null;
  print({ cli: CLI_VERSION, server, url: API_URL }, () => {
    console.log(`mybase CLI ${CLI_VERSION}`);
    console.log(server ? `server ${server} at ${API_URL}` : `server at ${API_URL}: unreachable or too old to report a version`);
    if (warning) console.error(`warning: ${warning}`);
  });
}

/** Runs an auth command. Returns false when `command` isn't one. */
export async function auth(command: string, args: string[]): Promise<boolean> {
  if (command === "login") await login(args);
  else if (command === "logout") await logout();
  else if (command === "whoami") await whoami();
  else if (command === "version" || command === "--version" || command === "-v") await version();
  else return false;
  return true;
}

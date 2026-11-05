// `mybase server backup | restore | migrate`: copies a whole instance (every project and its data)
// to a file or straight to another machine, in a form that works across CPU types (Pi ↔ x86).
//
//   env       the install's .env (keys: MYBASE_SECRETS_KEY decrypts stored secrets)
//   postgres  pg_dumpall, gzipped: every project database, roles (same passwords), the mybase schema
//   garage    keys (same ids and secrets), buckets, objects, via migrate.js in the API image
//   valkey    the RDB snapshot (cache, rate limit counters, sessions), as `docker cp` makes it
//   registry  hosted sites' images: only restored onto the same CPU type (they're built for it)
//
// The source's API is stopped while it's read, so nothing changes halfway.
import * as p from "@clack/prompts";
import { open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { styleText } from "node:util";
import { CLI_VERSION } from "./api";
import { ArchiveError, ArchiveReader, ArchiveWriter, collect, compatible, dropSuperuserCreate, type Manifest, newCode, normalizeCode, type SectionName, skip, streamSink } from "./archive";
import { saveServerDir } from "./config";
import { CliError, confirm, jsonMode, print, usageError } from "./output";
import { addresses, checkDocker, compose, composeEnv, machine, otherInstall, portFree, stackExists } from "./server-docker";
import { mergeEnv, parseEnv } from "./server-env";
import { sandboxProfileOn } from "./server-sandbox-env";
import { flag, localUrl, serverDir, startStack, ui, writeFiles } from "./server-setup";

export const backupUsage = `  server backup [--dir <dir>] [--out <file>]   Copy every project and its data into one file (.mbk)
    [--encrypt | --passphrase-stdin] [--no-cache]
                                 The API stops while it's read. Without a passphrase the file holds
                                 MYBASE_SECRETS_KEY and every database in the clear: keep it safe
  server restore <file|-> [--dir <dir>] [--public-host <h>] [--passphrase-stdin] [--yes]
                                 Rebuild an instance from a backup on a machine without one
  server migrate receive [--dir <dir>] [--port 4100] [--public-host <h>] [--yes]
                                 On the new machine: wait for an instance sent over the network
  server migrate send <host[:port]> --code <code> [--dir <dir>] [--no-cache] [--yes]
                                 On the old machine: send this instance (encrypted with the code),
                                 then stop it here. Works between CPU types (Pi ↔ x86)`;

const DEFAULT_PORT = 4100;
const dim = (s: string) => styleText("dim", s);
const bold = (s: string) => styleText("bold", s);
const tail = (text: string, n = 15) => text.trim().split("\n").slice(-n).join("\n");

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const SECTION_LABEL: Record<SectionName, string> = {
  env: "settings and keys (.env)",
  postgres: "Postgres (every project database)",
  garage: "storage (buckets and files)",
  valkey: "cache",
  registry: "hosted sites' images",
};

// ── Docker plumbing ──────────────────────────────────────────────────────────────────────────────

function spawn(dir: string, cmd: string[], stdin: "pipe" | "ignore" = "ignore") {
  return Bun.spawn(cmd, { cwd: dir, env: composeEnv(), stdin, stdout: "pipe", stderr: "pipe" });
}
const spawnCompose = (dir: string, args: string[], stdin: "pipe" | "ignore" = "ignore") => spawn(dir, ["docker", "compose", ...args], stdin);

/** A command's stdout as it comes; throws with its stderr if it fails. */
async function* output(proc: ReturnType<typeof spawn>, what: string, transform?: TransformStream<Uint8Array, Uint8Array>): AsyncGenerator<Uint8Array> {
  const stderr = new Response(proc.stderr).text();
  const stdout = (transform ? proc.stdout.pipeThrough(transform) : proc.stdout) as ReadableStream<Uint8Array>;
  for await (const chunk of stdout) yield chunk;
  if ((await proc.exited) !== 0) throw new CliError(`${what} failed:\n${tail(await stderr)}`);
}

/** Feeds `data` to a command's stdin; throws with its stderr if it fails. Returns its stdout. */
async function feed(proc: ReturnType<typeof spawn>, what: string, data: AsyncIterable<Uint8Array>): Promise<string> {
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const sink = proc.stdin!;
  try {
    for await (const chunk of data) {
      sink.write(chunk);
      await sink.flush();
    }
    await sink.end();
  } catch (err) {
    // The command stopped reading (it failed): its error says more than the broken pipe.
    proc.kill();
    if ((await proc.exited) !== 0) throw new CliError(`${what} failed:\n${tail(await stderr)}`);
    throw err;
  }
  if ((await proc.exited) !== 0) throw new CliError(`${what} failed:\n${tail(await stderr)}`);
  return stdout;
}

async function run(dir: string, args: string[], what: string): Promise<string> {
  const r = await compose(dir, args);
  if (!r.ok) throw new CliError(`${what} failed:\n${tail(r.stderr || r.stdout)}`);
  return r.stdout;
}

async function containerId(dir: string, service: string): Promise<string | null> {
  const r = await compose(dir, ["ps", "-a", "-q", service]);
  return r.ok && r.stdout ? r.stdout.split("\n")[0]! : null;
}

async function running(dir: string): Promise<Set<string>> {
  const r = await compose(dir, ["ps", "--status", "running", "--services"]);
  return new Set(r.ok ? r.stdout.split("\n").filter(Boolean) : []);
}

const pgUser = (env: Record<string, string>) => env.POSTGRES_USER || "mybase";

async function psql(dir: string, env: Record<string, string>, sql: string): Promise<string> {
  return run(dir, ["exec", "-T", "postgres", "psql", "-X", "-At", "-U", pgUser(env), "-d", "postgres", "-c", sql], "psql");
}

const COUNT_PROJECTS = `select count(*) from pg_database where shobj_description(oid, 'pg_database') like '{"mybase":%'`;

async function readEnv(dir: string): Promise<Record<string, string>> {
  const file = Bun.file(join(dir, ".env"));
  if (!(await file.exists()) || !(await Bun.file(join(dir, "compose.yml")).exists())) {
    throw new CliError(`no mybase server in ${dir}. Pass --dir, or run this on the machine that has it.`, 4);
  }
  return parseEnv(await file.text());
}

function toStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await it.return?.(reason);
    },
  });
}

// ── Export ───────────────────────────────────────────────────────────────────────────────────────

interface Source {
  dir: string;
  env: Record<string, string>;
  manifest: Manifest;
  /** Whether the API was running before (and should be started again after a backup). */
  apiWasRunning: boolean;
}

/** Checks the stack, writes down what's there, and stops the API so nothing changes while it's read. */
async function prepareSource(args: string[]): Promise<Source> {
  const dir = await serverDir(args);
  const env = await readEnv(dir);
  const up = await running(dir);
  for (const service of ["postgres", "garage", "valkey"]) {
    if (!up.has(service)) throw new CliError(`${service} isn't running in ${dir}. Start mybase first (\`mybase server restart\`).`);
  }
  const version = await fetch(`${localUrl(env)}/health`, { signal: AbortSignal.timeout(3000) })
    .then(async (r) => (r.ok ? ((await r.json()) as { version?: string }).version : undefined))
    .catch(() => undefined);
  const projects = Number(await psql(dir, env, COUNT_PROJECTS));
  const sections: SectionName[] = ["env", "postgres", "garage"];
  if (!args.includes("--no-cache")) sections.push("valkey");
  if (await containerId(dir, "registry")) sections.push("registry");

  const apiWasRunning = up.has("mybase");
  if (apiWasRunning) {
    const s = ui.spinner();
    s.start("Stopping the API so nothing changes while it's copied");
    await run(dir, ["stop", "mybase"], "stopping the API");
    s.stop("API stopped (Postgres, storage, and cache keep running)");
  }
  const manifest: Manifest = {
    format: 1,
    version: version ?? CLI_VERSION,
    arch: machine().arch,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    projects,
    sections,
  };
  return { dir, env, manifest, apiWasRunning };
}

async function startApi(dir: string) {
  await compose(dir, ["start", "mybase"]);
}

function sectionSource(src: Source, name: SectionName): AsyncIterable<Uint8Array> {
  const { dir, env } = src;
  switch (name) {
    case "env":
      return (async function* () {
        yield await Bun.file(join(dir, ".env")).bytes();
      })();
    case "postgres":
      return output(spawnCompose(dir, ["exec", "-T", "postgres", "pg_dumpall", "-U", pgUser(env)]), "pg_dumpall", new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
    case "garage":
      return output(spawnCompose(dir, ["run", "--rm", "--no-deps", "-T", "mybase", "bun", "migrate.js", "garage-export"]), "storage export (garage-export)");
    case "valkey":
      return (async function* () {
        await run(dir, ["exec", "-T", "valkey", "sh", "-c", 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli SAVE'], "saving the cache");
        const id = await containerId(dir, "valkey");
        yield* output(spawn(dir, ["docker", "cp", `${id}:/data/dump.rdb`, "-"]), "copying the cache");
      })();
    case "registry":
      return (async function* () {
        const id = await containerId(dir, "registry");
        yield* output(spawn(dir, ["docker", "cp", `${id}:/var/lib/registry`, "-"]), "copying the image registry");
      })();
  }
}

/** Writes the whole archive. */
async function writeArchive(src: Source, writer: ArchiveWriter, secret?: string) {
  await writer.start(secret);
  await writer.manifest(src.manifest);
  for (const name of src.manifest.sections) {
    const s = ui.spinner();
    s.start(`Copying ${SECTION_LABEL[name]}`);
    let last = 0;
    try {
      await writer.section(name, sectionSource(src, name), (bytes) => {
        if (bytes - last < 4 * 1024 * 1024) return;
        last = bytes;
        s.message(`Copying ${SECTION_LABEL[name]} ${dim(formatBytes(bytes))}`);
      });
    } catch (err) {
      s.error(`Couldn't copy ${SECTION_LABEL[name]}`);
      throw err;
    }
    s.stop(`Copied ${SECTION_LABEL[name]} ${dim(formatBytes(writer.sizes[name] ?? 0))}`);
  }
  await writer.end();
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────

/** A machine can take a restore: Docker works, and no mybase is installed in (or outside) `dir`. */
async function checkTarget(dir: string) {
  const docker = checkDocker();
  if (!docker.ok) throw new CliError(docker.problem!);
  const other = otherInstall(dir);
  if (other) throw new CliError(`mybase is already installed in ${other}. A restore needs a machine without one (or remove it: \`docker compose down -v\` there deletes its data).`);
  if ((await stackExists(dir)) || (await Bun.file(join(dir, ".env")).exists())) {
    throw new CliError(`${dir} already has a mybase install. Restore into an empty directory (--dir), or remove that one first.`);
  }
}

function checkManifest(m: Manifest) {
  if (!compatible(m.version, CLI_VERSION)) {
    throw new CliError(`this backup is from mybase ${m.version}, and this CLI is ${CLI_VERSION}. Use the same version on both machines (\`mybase update --cli\`), then try again.`);
  }
}

export interface RestoreResult {
  dir: string;
  version: string;
  from: { hostname: string; arch: string; createdAt: string };
  projects: number;
  storage: { keys: number; buckets: number; objects: number; bytes: number } | null;
  skipped: string[];
  sitesToRedeploy: string[];
  /** Sandboxes are on, and need gVisor set up on this machine. */
  sandbox: boolean;
  url: string;
}

/** Postgres: a fresh server, then the dump, minus the CREATE ROLE for the superuser it already has. */
async function importPostgres(dir: string, env: Record<string, string>, data: AsyncIterable<Uint8Array>) {
  await run(dir, ["up", "-d", "--wait", "postgres"], "starting Postgres");
  const user = pgUser(env);
  // The image made an empty database named after the superuser at first boot; the dump has its
  // own (pg_dumpall recreates it). This server is brand new (checkTarget), so nothing is lost.
  if (user !== "postgres") await psql(dir, env, `drop database if exists "${user.replace(/"/g, '""')}"`);
  const sql = toStream(data).pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  const HEAD = 4 * 1024 * 1024;
  async function* filtered() {
    const head: Uint8Array[] = [];
    let size = 0;
    let passed = false;
    for await (const chunk of sql) {
      if (passed) {
        yield chunk;
        continue;
      }
      head.push(chunk);
      size += chunk.length;
      if (size >= HEAD) {
        passed = true;
        yield Buffer.from(dropSuperuserCreate(Buffer.concat(head).toString("latin1"), user), "latin1");
      }
    }
    if (!passed) yield Buffer.from(dropSuperuserCreate(Buffer.concat(head).toString("latin1"), user), "latin1");
  }
  const proc = spawnCompose(dir, ["exec", "-T", "postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], "pipe");
  await feed(proc, "loading the Postgres dump", filtered());
}

async function importGarage(dir: string, data: AsyncIterable<Uint8Array>): Promise<RestoreResult["storage"]> {
  await run(dir, ["up", "-d", "garage"], "starting storage");
  const proc = spawnCompose(dir, ["run", "--rm", "--no-deps", "-T", "mybase", "bun", "migrate.js", "garage-import"], "pipe");
  const out = await feed(proc, "storage import (garage-import)", data);
  const last = out.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/** Puts a `docker cp` tar stream into a (created, not started) service's container. */
async function importTar(dir: string, service: string, target: string, data: AsyncIterable<Uint8Array>) {
  await run(dir, ["create", service], `creating ${service}`);
  const id = await containerId(dir, service);
  if (!id) throw new CliError(`no ${service} container after docker compose create`);
  await feed(spawn(dir, ["docker", "cp", "-", `${id}:${target}`], "pipe"), `copying into ${service}`, data);
}

/** Rebuilds an instance from an opened archive in `dir` (checked with checkTarget first). */
async function restoreArchive(reader: ArchiveReader, manifest: Manifest, dir: string, publicHost: string | null): Promise<RestoreResult> {
  const sameArch = manifest.arch === machine().arch;
  let env: Record<string, string> | null = null;
  let storage: RestoreResult["storage"] = null;
  const skipped: string[] = [];

  for (let section = await reader.next(); section; section = await reader.next()) {
    const { name, data } = section;
    const s = ui.spinner();
    s.start(`Restoring ${SECTION_LABEL[name] ?? name}`);
    try {
      if (name === "env") {
        let text = new TextDecoder().decode(await collect(data));
        if (publicHost) text = mergeEnv(text, { MYBASE_PUBLIC_HOST: publicHost });
        await writeFiles(dir, text, false, true);
        await saveServerDir(dir);
        env = parseEnv(text);
      } else if (!env) {
        throw new ArchiveError("damaged backup: settings (.env) must come first");
      } else if (name === "postgres") {
        await importPostgres(dir, env, data);
      } else if (name === "garage") {
        storage = await importGarage(dir, data);
      } else if (name === "valkey") {
        await importTar(dir, "valkey", "/data", data);
      } else if (name === "registry") {
        const hosting = (env.COMPOSE_PROFILES ?? "").split(",").some((p) => p.trim() === "hosting");
        if (sameArch && hosting) await importTar(dir, "registry", "/var/lib", data);
        else {
          await skip(data);
          skipped.push("registry");
        }
      } else {
        await skip(data);
        skipped.push(name);
      }
    } catch (err) {
      s.error(`Couldn't restore ${SECTION_LABEL[name] ?? name}`);
      throw err;
    }
    s.stop(skipped.includes(name) ? `Skipped ${SECTION_LABEL[name] ?? name}` : `Restored ${SECTION_LABEL[name] ?? name}`);
  }
  if (!env) throw new ArchiveError("damaged backup: no settings (.env)");

  const version = await startStack(dir, env, false);
  const projects = Number(await psql(dir, env, COUNT_PROJECTS));
  if (projects !== manifest.projects) throw new CliError(`restored ${projects} projects, the backup had ${manifest.projects}. Check \`mybase server logs\`.`);

  let sitesToRedeploy: string[] = [];
  if (!sameArch || skipped.includes("registry")) {
    const rows = await psql(dir, env, "select project || '/' || name from mybase.hosting_sites where live_deploy is not null order by 1").catch(() => "");
    sitesToRedeploy = rows.split("\n").filter(Boolean);
  }
  return {
    dir,
    version,
    from: { hostname: manifest.hostname, arch: manifest.arch, createdAt: manifest.createdAt },
    projects,
    storage,
    skipped,
    sitesToRedeploy,
    sandbox: sandboxProfileOn(env),
    url: localUrl(env),
  };
}

function printRestore(r: RestoreResult) {
  print(r, () => {
    const lines = [
      `${bold(String(r.projects))} projects from ${r.from.hostname} (${r.from.arch}, ${new Date(r.from.createdAt).toLocaleString()})`,
      r.storage ? `${r.storage.objects} files (${formatBytes(r.storage.bytes)}) in ${r.storage.buckets} buckets` : "",
      `mybase ${r.version} is running at ${r.url}`,
    ].filter(Boolean);
    ui.note(lines.join("\n"), "Restored");
    const next = [`Sign the CLI in: ${bold(`mybase login --url ${r.url}`)} (same admin and password as before)`];
    next.push("Apps that reached the old machine by its LAN address need this machine's address. Ones on the Cloudflare Tunnel URL keep working.");
    if (r.sitesToRedeploy.length) next.push(`Hosted sites need a new deploy here (their images were built for ${r.from.arch}): ${r.sitesToRedeploy.join(", ")}. Run \`mybase deploy\` for each.`);
    if (r.sandbox) next.push("Sandboxes need gVisor on this machine: run `mybase server sandbox`.");
    if (r.skipped.length) next.push(`Not restored: ${r.skipped.join(", ")}.`);
    ui.note(next.join("\n"), "Next");
    if (!jsonMode) p.outro("Done");
  });
}

/** Address apps should use for this machine: --public-host, a choice, or keep the old one. */
async function choosePublicHost(args: string[], interactive: boolean): Promise<string | null> {
  const given = flag(args, "--public-host");
  if (given || !interactive) return given ?? null;
  const KEEP = "\0keep";
  const options = addresses().map((a) => ({ value: a.value, label: a.value, hint: a.label }));
  const answer = await p.select({
    message: "Which address should apps use to reach this machine? (MYBASE_PUBLIC_HOST)",
    options: [...options, { value: KEEP, label: "Keep the old server's setting", hint: "e.g. a Tunnel-only setup" }],
  });
  if (p.isCancel(answer)) throw new CliError("cancelled, nothing changed");
  return answer === KEEP ? null : (answer as string);
}

async function readPassphrase(args: string[], interactive: boolean, confirmTwice: boolean): Promise<string | undefined> {
  if (args.includes("--passphrase-stdin")) {
    const value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
    if (value.length < 8) throw usageError("the passphrase must be at least 8 characters");
    return value;
  }
  if (!interactive) return undefined;
  const first = await p.password({ message: "Passphrase", validate: (v) => (!v || v.length < 8 ? "at least 8 characters" : undefined) });
  if (p.isCancel(first)) throw new CliError("cancelled, nothing changed");
  if (confirmTwice) {
    const again = await p.password({ message: "Same passphrase again" });
    if (p.isCancel(again)) throw new CliError("cancelled, nothing changed");
    if (again !== first) throw new CliError("the passphrases don't match");
  }
  return first;
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

async function backup(args: string[]) {
  const interactive = !jsonMode && process.stdin.isTTY === true;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = resolve(flag(args, "--out") ?? `mybase-backup-${hostname()}-${stamp}.mbk`);
  if (await Bun.file(out).exists()) throw new CliError(`${out} already exists`);
  if (args.includes("--encrypt") && !interactive) throw usageError("--encrypt asks for a passphrase: without a terminal use --passphrase-stdin");
  const secret = args.includes("--encrypt") || args.includes("--passphrase-stdin") ? await readPassphrase(args, interactive, true) : undefined;
  if (!jsonMode) p.intro(`${bold(" mybase ")} ${dim("server backup")}`);

  const src = await prepareSource(args);
  const file = await open(out, "wx", 0o600);
  let ok = false;
  try {
    const writer = new ArchiveWriter(async (bytes) => void (await file.write(bytes)));
    await writeArchive(src, writer, secret);
    ok = true;
  } finally {
    await file.close();
    if (!ok) await rm(out, { force: true });
    if (src.apiWasRunning) await startApi(src.dir);
  }
  const size = Bun.file(out).size;
  print({ file: out, bytes: size, encrypted: !!secret, ...src.manifest }, () => {
    ui.success(`Saved ${out} ${dim(formatBytes(size))}`);
    if (!secret) ui.warn("This file holds MYBASE_SECRETS_KEY and every database, unencrypted. Keep it somewhere safe, or use --encrypt next time.");
    ui.info(`Restore it on another machine with: mybase server restore ${out}`);
    p.outro("Done");
  });
}

async function restore(args: string[]) {
  const yes = args.includes("--yes");
  const interactive = !yes && !jsonMode && process.stdin.isTTY === true;
  const path = args.find((a, i) => !a.startsWith("--") && !["--dir", "--public-host"].includes(args[i - 1] ?? ""));
  if (!path) throw usageError("usage: mybase server restore <file|-> [--dir <dir>]");
  if (path === "-" && args.includes("--passphrase-stdin")) throw usageError("--passphrase-stdin can't be used when the backup comes from stdin");
  if (!interactive && !yes) throw usageError("refusing without --yes (no terminal to confirm)");
  if (path !== "-" && !(await Bun.file(path).exists())) throw new CliError(`${path} not found`, 4);

  const dir = await serverDir(args);
  if (!jsonMode) p.intro(`${bold(" mybase ")} ${dim("server restore")}`);
  await checkTarget(dir);
  const reader = new ArchiveReader(path === "-" ? Bun.stdin.stream() : Bun.file(path).stream());
  const { encrypted } = await reader.readHeader();
  const manifest = await reader.open(encrypted ? await readPassphrase(args, interactive && path !== "-", false) : undefined);
  checkManifest(manifest);
  ui.note(
    `${manifest.projects} projects from ${manifest.hostname} (${manifest.arch}), mybase ${manifest.version}, made ${new Date(manifest.createdAt).toLocaleString()}\nInto ${dir}`,
    "Backup",
  );
  const publicHost = await choosePublicHost(args, interactive);
  if (interactive) {
    const go = await p.confirm({ message: "Restore it here?" });
    if (p.isCancel(go) || !go) throw new CliError("cancelled, nothing changed");
  }
  try {
    printRestore(await restoreArchive(reader, manifest, dir, publicHost));
  } catch (err) {
    throw restoreFailed(err, dir);
  }
}

function restoreFailed(err: unknown, dir: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new CliError(`${message}\n\nThe restore stopped partway. Clear it with \`docker compose down -v\` in ${dir} (and delete its .env), then try again. The backup and the old server are unchanged.`);
}

async function receive(args: string[]) {
  const yes = args.includes("--yes");
  const interactive = !yes && !jsonMode && process.stdin.isTTY === true;
  if (!interactive && !yes) throw usageError("refusing without --yes (no terminal to confirm)");
  const port = Number(flag(args, "--port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError("--port needs a port number");
  const dir = await serverDir(args);
  if (!jsonMode) p.intro(`${bold(" mybase ")} ${dim("server migrate receive")}`);
  await checkTarget(dir);
  if (!portFree(port)) throw new CliError(`port ${port} is in use: pick another with --port`);
  const publicHost = await choosePublicHost(args, interactive);

  const code = newCode();
  const secret = normalizeCode(code);
  const lan = addresses();
  const target = (h: string) => (port === DEFAULT_PORT ? h : `${h}:${port}`);
  const commands = lan.map((a) => `mybase server migrate send ${target(a.value)} --code ${code}   ${dim(`# ${a.label}`)}`);
  if (jsonMode) console.log(JSON.stringify({ waiting: true, port, code, addresses: lan.map((a) => a.value) }));
  else ui.note(`Run one of these on the old machine (any address it can reach):\n\n${commands.join("\n")}`, `Waiting on port ${port}`);

  const result = await new Promise<RestoreResult>((resolveResult, rejectResult) => {
    let busy = false;
    const server = Bun.serve({
      port,
      hostname: "0.0.0.0",
      idleTimeout: 0,
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/") return Response.json({ mybase: "migrate", version: CLI_VERSION });
        if (req.method !== "POST" || url.pathname !== "/migrate" || !req.body) return Response.json({ error: "not found" }, { status: 404 });
        if (busy) return Response.json({ error: "a migration is already running" }, { status: 409 });
        busy = true;
        const reader = new ArchiveReader(req.body);
        let manifest: Manifest;
        try {
          manifest = await reader.open(secret);
          checkManifest(manifest);
        } catch (err) {
          busy = false;
          await reader.cancel();
          const wrong = err instanceof ArchiveError;
          ui.warn(`Refused a transfer from ${server.requestIP(req)?.address ?? "?"}: ${(err as Error).message}`);
          return Response.json({ error: (err as Error).message }, { status: wrong ? 401 : 409 });
        }
        ui.info(`Receiving ${manifest.projects} projects from ${manifest.hostname} (${manifest.arch})`);
        try {
          const r = await restoreArchive(reader, manifest, dir, publicHost);
          setTimeout(() => {
            server.stop();
            resolveResult(r);
          }, 500);
          return Response.json(r);
        } catch (err) {
          const failed = restoreFailed(err, dir);
          setTimeout(() => {
            server.stop(true);
            rejectResult(failed);
          }, 500);
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      },
    });
  });
  printRestore(result);
}

async function send(args: string[]) {
  const yes = args.includes("--yes");
  const to = args.find((a, i) => !a.startsWith("--") && !["--dir", "--code"].includes(args[i - 1] ?? ""));
  const code = flag(args, "--code");
  if (!to || !code) throw usageError("usage: mybase server migrate send <host[:port]> --code <code>   (the new machine prints both: `mybase server migrate receive`)");
  const base = `http://${/:\d+$/.test(to) && !to.endsWith("]") ? to : `${to}:${DEFAULT_PORT}`}`;
  const hello = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json() as Promise<{ mybase?: string; version?: string }>)
    .catch(() => null);
  if (hello?.mybase !== "migrate") throw new CliError(`nothing is waiting at ${base}. Run \`mybase server migrate receive\` on the new machine first, and check the address.`);
  if (hello.version && !compatible(hello.version, CLI_VERSION)) throw new CliError(`the new machine's CLI is ${hello.version}, this one is ${CLI_VERSION}. Use the same version on both (\`mybase update --cli\`).`);
  confirm(yes, `This copies every project to ${to}, then stops mybase on this machine (its data stays here).`, to);
  if (!jsonMode) p.intro(`${bold(" mybase ")} ${dim(`server migrate send → ${to}`)}`);

  const src = await prepareSource(args);
  const pipe = new TransformStream<Uint8Array, Uint8Array>();
  const sink = streamSink(pipe.writable);
  let response: Response | null = null;
  const request = fetch(`${base}/migrate`, {
    method: "POST",
    body: pipe.readable,
    headers: { "Content-Type": "application/octet-stream" },
    duplex: "half",
    timeout: false,
  } as RequestInit).then((res) => {
    response = res;
    if (!res.ok) sink.abort(new Error("the new machine refused the transfer"));
    return res;
  });
  request.catch((err) => sink.abort(err));

  let done = false;
  try {
    try {
      await writeArchive(src, new ArchiveWriter(sink.sink), normalizeCode(code));
      await sink.close();
    } catch (err) {
      await sink.abort(err);
      const res = await request.catch(() => null);
      const remote = res && !res.ok ? ((await res.json().catch(() => ({}))) as { error?: string }).error : undefined;
      throw remote ? new CliError(`the new machine: ${remote}`) : err;
    }
    const s = ui.spinner();
    s.start("Waiting for the new machine to start mybase");
    const res = (response as Response | null) ?? (await request);
    const body = (await res.json().catch(() => ({}))) as RestoreResult & { error?: string };
    if (!res.ok) {
      s.error("The new machine couldn't restore it");
      throw new CliError(`the new machine: ${body.error ?? res.statusText}`);
    }
    s.stop(`mybase ${body.version} is running on the new machine with ${body.projects} projects`);
    done = true;
    const stop = ui.spinner();
    stop.start("Stopping mybase on this machine");
    await run(src.dir, ["stop"], "stopping mybase");
    stop.stop("Stopped here (the data is still in this machine's volumes)");
    print({ to, ...body }, () => {
      ui.note(
        [
          "Containers here are stopped, so cron jobs, the tunnel, and sites don't run twice.",
          `Bring this one back with \`mybase server restart\`, or remove it with \`docker compose down -v\` in ${src.dir} once you're happy.`,
          "Restarting this machine starts it again if autostart is on: run `mybase server autostart off` here.",
        ].join("\n"),
        "This machine",
      );
      p.outro("Moved");
    });
  } finally {
    if (!done && src.apiWasRunning) await startApi(src.dir);
  }
}

/** Runs backup/restore/migrate. Returns false when `command` isn't one of them. */
export async function backupCommand(command: string, args: string[]): Promise<boolean> {
  if (command === "backup") await backup(args);
  else if (command === "restore") await restore(args);
  else if (command === "migrate") {
    const [sub, ...rest] = args;
    if (sub === "receive") await receive(rest);
    else if (sub === "send") await send(rest);
    else throw usageError("usage: mybase server migrate receive | send <host[:port]> --code <code>");
  } else return false;
  return true;
}

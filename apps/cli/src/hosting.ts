// `mybase hosting …` and `mybase deploy`: sites run as containers on the mybase host.
// Deploys build on this machine (docker build for the server's platform), push through the
// API in chunks (oci-push.ts), then wait for the new container to answer before it goes live.
import type { CreateDeployRequest, HostingDeploy, HostingOverview, HostingSite } from "@mybase/shared";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { api, API_URL, apiToken } from "./api";
import { flagInt, flagString, need, parseArgs, readConfigFile, type ConfigFile } from "./cron";
import { CHUNK_BYTES, pushImage } from "./oci-push";
import { CliError, confirm, jsonMode, print, usageError } from "./output";
import { configFile, DOCKERFILES, DOCKERIGNORE, TEMPLATES, type Template } from "./hosting-templates";
import { enableService } from "./service-enable";

export const hostingUsage = `  hosting enable <project>       Turn on hosting (sites at <site>.<domain>; needs \`mybase server hosting\` once)
  hosting sites <project>        List sites, their URLs, and the latest deploy
  hosting create <project> <site> [--port 3000] [--health /]  Add a site (names are unique across projects)
  hosting set <project> <site> [--port n] [--health /path] [--secrets-env <env> | --no-secrets-env]
  hosting env list|set|unset <project> <site> [KEY=VALUE… | KEY…]  The site's own env vars (applied on the next deploy)
  hosting deploys <project> <site>  Deploy history
  hosting redeploy <project> <site>  Restart the live image (picks up env changes)
  hosting rollback <project> <site> [<deploy id>]  Go back to the previous (or a given) deploy
  hosting logs <project> <site> [--deploy <id>] [--tail 200] [--no-follow]  Container output
  hosting delete <project> <site> [--yes]  Remove a site, its containers, and its images
  hosting init [--template nextjs|static|node] [--project p] [--site s]  Write a Dockerfile, .dockerignore, and mybase.config.ts
  hosting disable <project> [--yes]  Turn hosting off: every site goes down
  deploy [--project p] [--site s] [--config mybase.config.ts] [--no-wait]  Build here, push, and go live`;

const base = (p: string) => `/projects/${encodeURIComponent(p)}/hosting`;
const sitePath = (p: string, s: string) => `${base(p)}/sites/${encodeURIComponent(s)}`;

const short = (id: string) => id.slice(0, 8);
const ago = (iso: string) => {
  const s = Math.round((Date.now() - +new Date(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

function printDeploy(d: HostingDeploy) {
  console.log([short(d.id), d.status.padEnd(8), d.digest.slice(7, 19), ago(d.createdAt).padEnd(8), d.createdBy, d.rollbackOf ? `rollback of ${short(d.rollbackOf)}` : "", d.error ?? ""].join("  ").trimEnd());
}

function printSite(s: HostingSite) {
  const status = s.latest ? `${s.latest.status}${s.latest.id !== s.liveDeploy && s.liveDeploy ? ` (live: ${short(s.liveDeploy)})` : ""}` : "never deployed";
  console.log(`${s.name.padEnd(16)} ${(s.url ?? `http://${s.name}.localhost`).padEnd(36)} :${String(s.port).padEnd(5)} ${status}`);
}

/** Handles `mybase hosting <sub> …`. False when `sub` isn't a hosting command. */
export async function hosting(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, site] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      await enableService(p, "hosting", flags);
      const o = await api<HostingOverview>(base(p));
      print({ enabled: "hosting", project: p, ...o }, () => {
        console.log(`Hosting enabled for "${p}".`);
        if (!o.domain) console.log("No MYBASE_HOSTING_DOMAIN on the server: sites answer at http://<site>.localhost only (run `mybase server hosting`).");
        console.log(`\nNext, in your app's directory:\n  mybase hosting init --project ${p} --site <name>\n  mybase deploy`);
      });
      return true;
    }
    case "sites": {
      const p = need(project, "project name");
      const o = await api<HostingOverview>(base(p));
      print(o, () => {
        if (!o.sites.length) return console.log(`No sites yet. Create one: mybase hosting create ${p} <site>`);
        for (const s of o.sites) printSite(s);
        console.log(`\nImages: ${o.registry}/<site> (${o.platform})`);
      });
      return true;
    }
    case "create": {
      const p = need(project, "project name");
      const s = await api<HostingSite>(`${base(p)}/sites`, {
        method: "POST",
        body: JSON.stringify({ name: need(site, "site name"), port: flagInt(flags, "port"), healthPath: flagString(flags, "health") }),
      });
      print(s, () => console.log(`Site "${s.name}" created. It goes live at ${s.url ?? `http://${s.name}.localhost`} after the first deploy (mybase deploy).`));
      return true;
    }
    case "set": {
      const p = need(project, "project name");
      const body: Record<string, unknown> = { port: flagInt(flags, "port"), healthPath: flagString(flags, "health") };
      if (flags.has("no-secrets-env")) body.secretsEnv = null;
      else if (flags.has("secrets-env")) body.secretsEnv = flagString(flags, "secrets-env");
      const s = await api<HostingSite>(sitePath(p, need(site, "site name")), { method: "PATCH", body: JSON.stringify(body) });
      print(s, () => {
        printSite(s);
        console.log(`secrets env: ${s.secretsEnv ?? "none"}. Env changes apply on the next deploy (mybase hosting redeploy ${p} ${s.name}).`);
      });
      return true;
    }
    case "env":
      return env(positional, flags);
    case "deploys": {
      const p = need(project, "project name");
      const list = await api<HostingDeploy[]>(`${sitePath(p, need(site, "site name"))}/deploys`);
      print(list, () => (list.length ? list.forEach(printDeploy) : console.log("No deploys yet.")));
      return true;
    }
    case "redeploy":
    case "rollback": {
      const p = need(project, "project name");
      const s = need(site, "site name");
      const deploy =
        sub === "redeploy"
          ? await api<HostingDeploy>(`${sitePath(p, s)}/deploys`, { method: "POST", body: "{}" })
          : await api<HostingDeploy>(`${sitePath(p, s)}/rollback`, { method: "POST", body: JSON.stringify(positional[2] ? { deployId: await fullDeployId(p, s, positional[2]) } : {}) });
      await finish(p, s, deploy, flags.has("no-wait"));
      return true;
    }
    case "logs": {
      const p = need(project, "project name");
      const s = need(site, "site name");
      const q = new URLSearchParams({ tail: String(flagInt(flags, "tail") ?? 200), follow: flags.has("no-follow") || jsonMode ? "0" : "1" });
      const deploy = flagString(flags, "deploy");
      if (deploy) q.set("deploy", await fullDeployId(p, s, deploy));
      const res = await api<Response>(`${sitePath(p, s)}/logs?${q}`, { raw: true });
      const text = jsonMode ? await res.text() : null;
      if (text !== null) print({ site: s, logs: text.split("\n").filter(Boolean) }, () => {});
      else for await (const chunk of res.body!) process.stdout.write(chunk);
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const s = need(site, "site name");
      confirm(flags.has("yes"), `Site "${s}" goes offline, and its deploys and images are deleted.`, s, "the site name");
      await api(sitePath(p, s), { method: "DELETE" });
      print({ deleted: s, project: p }, () => console.log(`Site "${s}" deleted.`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `Every site in "${p}" goes offline, and their deploys and images are deleted.`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/hosting`, { method: "DELETE" });
      print({ disabled: "hosting", project: p }, () => console.log(`Hosting disabled for "${p}".`));
      return true;
    }
    case "init":
      await init(flags);
      return true;
    case "deploy":
      await deploy(args);
      return true;
  }
  return false;
}

/** Accepts a short id prefix (as printed) and finds the full one. */
async function fullDeployId(p: string, s: string, id: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  const match = (await api<HostingDeploy[]>(`${sitePath(p, s)}/deploys`)).filter((d) => d.id.startsWith(id));
  if (match.length !== 1) throw new CliError(match.length ? `"${id}" matches more than one deploy` : `no deploy starting with "${id}"`, 4);
  return match[0]!.id;
}

async function env(positional: string[], flags: Map<string, string | true>): Promise<boolean> {
  const [action, project, site, ...pairs] = positional;
  if (!action || !["list", "set", "unset"].includes(action)) throw usageError("usage: mybase hosting env list|set|unset <project> <site> [KEY=VALUE… | KEY…]");
  const p = need(project, "project name");
  const s = need(site, "site name");
  const path = `${sitePath(p, s)}/env`;
  const current = (await api<{ env: Record<string, string> }>(path)).env;
  if (action === "list") {
    const values = flags.has("values");
    print(values ? current : Object.keys(current), () => {
      if (!Object.keys(current).length) return console.log("No env vars. Set some: mybase hosting env set <project> <site> KEY=VALUE");
      for (const [k, v] of Object.entries(current)) console.log(values ? `${k}=${v}` : k);
    });
    return true;
  }
  const next = { ...current };
  if (action === "set") {
    if (!pairs.length) throw usageError("give at least one KEY=VALUE");
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      if (at < 1) throw usageError(`"${pair}" isn't KEY=VALUE`);
      next[pair.slice(0, at)] = pair.slice(at + 1);
    }
  } else {
    if (!pairs.length) throw usageError("give at least one KEY");
    for (const k of pairs) delete next[k];
  }
  await api(path, { method: "PUT", body: JSON.stringify({ env: next }) });
  print({ site: s, keys: Object.keys(next) }, () => console.log(`Saved ${Object.keys(next).length} env vars. They apply on the next deploy: mybase hosting redeploy ${p} ${s}`));
  return true;
}

async function init(flags: Map<string, string | true>) {
  const template = (flagString(flags, "template") ?? "nextjs") as Template;
  if (!TEMPLATES.includes(template)) throw usageError(`--template must be one of ${TEMPLATES.join(", ")}`);
  const dir = resolve(flagString(flags, "dir") ?? ".");
  const written: string[] = [];
  const write = async (name: string, content: string) => {
    const path = join(dir, name);
    if (existsSync(path) && !flags.has("force")) return console.error(`${name} exists; left as is (--force replaces it)`);
    await Bun.write(path, content);
    written.push(name);
  };
  await write("Dockerfile", DOCKERFILES[template]);
  await write(".dockerignore", DOCKERIGNORE);
  const project = flagString(flags, "project");
  const site = flagString(flags, "site");
  if (project && site) await write("mybase.config.ts", configFile(project, site));
  print({ template, written }, () => {
    if (written.length) console.log(`Wrote ${written.join(", ")} (${template}).`);
    if (template === "nextjs") console.log('Set output: "standalone" in next.config so the image stays small.');
    if (!(project && site)) console.log("Add a hosting block to mybase.config.ts (or pass --project and --site here), then: mybase deploy");
    else console.log("Next: mybase deploy");
  });
}

/** `docker …` with output on stderr (stdout is for results). */
async function docker(args: string[], quiet = false): Promise<void> {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: quiet || jsonMode ? "ignore" : 2, stderr: "inherit" });
  if ((await child.exited) !== 0) throw new CliError(`docker ${args[0]} failed`);
}

const goArch = (arch: string) => (arch === "x64" ? "amd64" : arch);

/** `mybase deploy`. */
export async function deploy(args: string[]) {
  const { flags } = parseArgs(args);
  const configPath = flagString(flags, "config") ?? "mybase.config.ts";
  const config: ConfigFile | null = existsSync(configPath) ? await readConfigFile(configPath) : null;
  const project = flagString(flags, "project") ?? config?.project;
  if (!project) throw usageError("which project? Pass --project, or run in a directory with a mybase.config.ts");
  const sites = config?.project === project ? (config.hosting?.sites ?? {}) : {};
  const names = Object.keys(sites);
  const site = flagString(flags, "site") ?? (names.length === 1 ? names[0] : undefined);
  if (!site) throw usageError(names.length ? `which site? --site ${names.join(" | --site ")}` : "which site? Pass --site, or add hosting.sites to mybase.config.ts");
  const settings = sites[site] ?? {};
  const root = config ? dirname(resolve(configPath)) : process.cwd();
  const context = resolve(root, flagString(flags, "dir") ?? settings.context ?? ".");
  const dockerfile = resolve(context, flagString(flags, "dockerfile") ?? settings.dockerfile ?? "Dockerfile");
  if (!existsSync(dockerfile)) throw new CliError(`no Dockerfile at ${dockerfile}. Write one: mybase hosting init --template nextjs|static|node`);
  const token = apiToken();
  if (!token) throw new CliError("not signed in. Run `mybase login` (or set MYBASE_TOKEN).", 3);

  // The site exists, or gets made with the config's settings.
  let existing: HostingSite | null = null;
  try {
    existing = await api<HostingSite>(sitePath(project, site));
  } catch (err) {
    if (!(err instanceof CliError && err.status === 404 && /no site named/.test(err.message))) throw err;
  }
  if (!existing) {
    existing = await api<HostingSite>(`${base(project)}/sites`, { method: "POST", body: JSON.stringify({ name: site, port: settings.port, healthPath: settings.healthPath }) });
    log(`Created site "${site}".`);
  } else if ((settings.port !== undefined && settings.port !== existing.port) || (settings.healthPath !== undefined && settings.healthPath !== existing.healthPath)) {
    existing = await api<HostingSite>(sitePath(project, site), { method: "PATCH", body: JSON.stringify({ port: settings.port, healthPath: settings.healthPath }) });
  }

  const health = await api<{ arch?: string }>("/health");
  const platform = `linux/${goArch(health.arch ?? process.arch)}`;
  const tag = `mybase-deploy/${project}-${site}:latest`;
  log(`Building ${site} for ${platform}…`);
  await docker(["build", "--platform", platform, "-t", tag, "-f", dockerfile, context]);
  const tar = join(tmpdir(), `mybase-${project}-${site}-${crypto.randomUUID()}.tar`);
  try {
    await docker(["save", "-o", tar, tag], true);
    log(`Pushing to ${new URL(API_URL).host}/${project}/${site} (${CHUNK_BYTES / 1024 / 1024} MB chunks)…`);
    let lastPct = -1;
    const { digest, architecture } = await pushImage(tar, { url: API_URL, token, repo: `${project}/${site}` }, (e) => {
      if (jsonMode) return;
      if (e.kind === "skip") process.stderr.write(`  ${e.digest.slice(7, 19)} already there\n`);
      if (e.kind === "upload") {
        const pct = Math.floor(((e.sent ?? 0) / e.size) * 100);
        if (pct !== lastPct) process.stderr.write(`\r  ${e.digest.slice(7, 19)} ${pct}% of ${(e.size / 1024 / 1024).toFixed(1)} MB`);
        lastPct = pct;
      }
      if (e.kind === "done") process.stderr.write(`\r  ${e.digest.slice(7, 19)} pushed ${(e.size / 1024 / 1024).toFixed(1)} MB   \n`);
    });
    if (architecture && `linux/${architecture}` !== platform) throw new CliError(`the image is ${architecture}, but the server runs ${platform}`);
    const body: CreateDeployRequest = { digest };
    const created = await api<HostingDeploy>(`${sitePath(project, site)}/deploys`, { method: "POST", body: JSON.stringify(body) });
    await finish(project, site, created, flags.has("no-wait"));
  } finally {
    await rm(tar, { force: true });
  }
}

const log = (line: string) => {
  if (!jsonMode) console.error(line);
};

/** Waits for a deploy to go live or fail, then prints the outcome. */
async function finish(project: string, site: string, deploy: HostingDeploy, noWait: boolean) {
  let d = deploy;
  if (!noWait) {
    log(`Deploy ${short(d.id)} queued; waiting for the container to answer…`);
    const deadline = Date.now() + 20 * 60_000;
    while ((d.status === "queued" || d.status === "starting") && Date.now() < deadline) {
      await Bun.sleep(2000);
      d = (await api<HostingDeploy[]>(`${sitePath(project, site)}/deploys`)).find((x) => x.id === d.id) ?? d;
    }
  }
  const s = await api<HostingSite>(sitePath(project, site));
  print({ deploy: d, url: s.url }, () => {
    if (d.status === "live") console.log(`Live: ${s.url ?? `http://${site}.localhost`}  (deploy ${short(d.id)})`);
    else if (d.status === "failed") console.log(`Deploy ${short(d.id)} failed: ${d.error}\nThe previous deploy (if any) is still live.`);
    else console.log(`Deploy ${short(d.id)} is ${d.status}. Check: mybase hosting deploys ${project} ${site}`);
  });
  if (d.status === "failed") process.exitCode = 1;
}

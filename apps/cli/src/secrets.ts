// `mybase secrets …`: env vars and secrets per environment, stored encrypted on mybase.
// `mybase run` (run.ts) starts a command with them.
import {
  parseDotenv,
  type LinkCredentialsResponse,
  type LinkRef,
  type LinkService,
  type LinkServicesRequest,
  type LinkServicesResponse,
  type SecretsDoctorFinding,
  type SecretsEnv,
  type SecretsEnvDetail,
  type SecretsOverview,
  type SecretsResponse,
  type SecretsRevision,
  type UpdateSecretsResponse,
} from "@mybase/shared";
import { api } from "./api";
import { dirSetup, saveDirSetup } from "./config";
import { flagInt, flagString, need, parseArgs } from "./cron";
import { CliError, confirm, jsonMode, print, usageError } from "./output";
import { planReach, reachQuery } from "./reach";

export const secretsUsage = `  secrets enable <project>       Turn on secrets (dev, staging, prod to start)
  secrets disable <project> [--yes]  Turn them off, deleting every env, value, and revision
  secrets setup -p <project> -e <env>  Use this project + env in this directory (and below)
  secrets envs                   List environments
  secrets env create <name> [--from <root env>]  Create an env (a branch env with --from)
  secrets env rename <name> <new name>
  secrets env delete <name> [--yes]  Delete an env, its branch envs, and their history
  secrets list [--values]        List keys (values hidden unless --values)
  secrets get <KEY>              Print one value
  secrets set <KEY=value>… [--message <m>]  Set keys (KEY=- reads the value from stdin)
  secrets unset <KEY>… [--message <m>]
  secrets upload <.env file> [--message <m>]  Set every key in a .env file
  secrets history [--limit 20]   Revisions, newest first
  secrets restore <revision> [--yes]  Put values back as they were after <revision>
  secrets link --database|--cache|--storage|--api [--as <KEY>] [--yes]
                                 Link keys to this project's own services: stored as references and
                                 resolved for whoever reads the env (hosted sites: postgres:5432;
                                 \`mybase run\`: the best address it reaches, else \`db proxy\`).
                                 --database → DATABASE_URL, --cache → REDIS_URL, --storage → S3_*,
                                 --api → MYBASE_URL + MYBASE_API_KEY
    [--route auto|internal|localhost|lan|tailscale|public|proxy]  Pin a route (default auto)
    [--sslmode disable|require|verify-full] [--param name=value]…  Database URL options
    [--rotate]                   New credentials even if mybase holds them
  secrets link --env <env,…> [--yes]  (no service flags) Rotate the project's DB/S3/cache credentials
                                 and store them as literal values in these envs, with every
                                 service's keys (MYBASE_API_KEY, MYBASE_CRON_SECRET, …)
  secrets unlink <KEY>…          Remove linked keys (nothing is rotated)
  secrets unlink [--yes]         (no keys) Remove the \`link --env\` credentials from the env
  secrets doctor [-e <env>] [--yes]  Find literal values that are this project's own credentials
                                 (pasted connection strings) and offer to link them instead
                                 \`<service> enable\` asks to add that service's keys to linked
                                 envs (--link / --no-link to skip the question)
                                 Project/env: -p/--project, -e/--env, else MYBASE_PROJECT/MYBASE_ENV,
                                 else \`secrets setup\` for this directory`;

/** `-p`/`-e` → `--project`/`--env`. */
export const expandShortFlags = (args: string[]) => args.map((a) => (a === "-p" ? "--project" : a === "-e" ? "--env" : a));

/** Project and env from flags, env vars, or `secrets setup`, in that order. */
export async function target(flags: Map<string, string | true>, needEnv = true): Promise<{ project: string; env: string }> {
  const setup = await dirSetup();
  const project = flagString(flags, "project") ?? process.env.MYBASE_PROJECT ?? setup?.project;
  const env = flagString(flags, "env") ?? process.env.MYBASE_ENV ?? setup?.env;
  if (!project || (needEnv && !env)) {
    throw usageError(`which ${project ? "env" : "project"}? Pass -p <project> -e <env>, or run \`mybase secrets setup -p <project> -e <env>\` here once`);
  }
  return { project, env: env ?? "" };
}

const base = (project: string) => `/projects/${encodeURIComponent(project)}/secrets`;
const envPath = (project: string, env: string, rest = "") => `${base(project)}/envs/${encodeURIComponent(env)}${rest}`;

/** The resolved secrets of an env, through the app route (works with env-scoped keys). `query`: reach hints (reach.ts). */
export const fetchSecrets = (project: string, env: string, query = "") =>
  api<SecretsResponse>(`/secrets/${encodeURIComponent(project)}/${encodeURIComponent(env)}${query}`);

/** `linked: database (lan)` */
export const describeLink = (ref: LinkRef) =>
  `linked: ${ref.service}${ref.field !== "url" ? ` ${ref.field}` : ""}${ref.route !== "auto" ? ` (${ref.route})` : ""}`;

const SERVICE_FLAGS: LinkService[] = ["database", "cache", "storage", "api"];

/** Every `--param name=value`. */
function readParams(args: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--param") continue;
    const pair = args[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) throw usageError(`--param needs name=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * POSTs a link, asking about what the server refuses without consent: replacing literal values
 * (409 "already set") and rotating credentials it doesn't hold yet (409 "doesn't hold").
 */
async function postLink(project: string, env: string, body: LinkServicesRequest, yes: boolean): Promise<LinkServicesResponse> {
  const path = `${base(project)}/envs/${encodeURIComponent(env)}/links`;
  if (yes) Object.assign(body, { replace: true, rotateMissing: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api<LinkServicesResponse>(path, { method: "POST", body: JSON.stringify(body) });
    } catch (err) {
      const e = err as CliError;
      if (e.status !== 409) throw err;
      if (e.message.startsWith("already set")) {
        confirm(false, `${e.message.replace(/ Replace with links.*$/, "")}\nReplace them with links? The old values stay in the history (mybase secrets history).`, env, "the env name");
        body.replace = true;
      } else if (e.message.startsWith("mybase doesn't hold")) {
        confirm(false, e.message.replace(/ Pass rotateMissing.*$/, ""), project, "the project name");
        body.rotateMissing = true;
      } else throw err;
    }
  }
  throw new CliError("linking failed: the server kept refusing");
}

const describeEnv = (e: SecretsEnv) =>
  [e.name, e.parent ? `branch of ${e.parent}` : "root", `${e.keys} keys`, `rev ${e.revision}`, e.linked ? "linked" : ""].filter(Boolean).join("\t");

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return (prompt("Value:") ?? "").replace(/\n$/, "");
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

function printUpdate(result: UpdateSecretsResponse, env: string) {
  print(result, () => console.log(result.changed === 0 ? `No changes in "${env}".` : `Updated "${env}": ${result.changed} key(s), revision ${result.revision}`));
}

/** Handles `mybase secrets <sub> …`. False when `sub` isn't a secrets command. */
export async function secrets(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(expandShortFlags(args));
  const yes = flags.has("yes");
  const message = flagString(flags, "message");
  switch (sub) {
    case "enable": {
      const p = need(positional[0] ?? flagString(flags, "project"), "project name");
      await api(`/projects/${encodeURIComponent(p)}/services/secrets`, { method: "PUT" });
      const overview = await api<SecretsOverview>(base(p));
      print({ enabled: "secrets", project: p, ...overview }, () => {
        console.log(`Secrets enabled for "${p}": ${overview.envs.map((e) => e.name).join(", ")}\n`);
        console.log("Next:");
        console.log(`  mybase secrets setup -p ${p} -e dev       # once per repo`);
        console.log(`  mybase secrets set API_URL=https://…      # or: mybase secrets upload .env`);
        console.log(`  mybase run -- bun start                    # starts your app with them`);
      });
      return true;
    }
    case "disable": {
      const p = need(positional[0] ?? flagString(flags, "project"), "project name");
      confirm(yes, `This deletes every secrets environment, value, and revision of "${p}". They can't be recovered.`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/secrets`, { method: "DELETE" });
      print({ disabled: "secrets", project: p }, () => console.log(`Secrets disabled for "${p}"`));
      return true;
    }
    case "setup": {
      const { project, env } = await target(flags);
      const overview = await api<SecretsOverview>(base(project));
      if (!overview.envs.some((e) => e.name === env)) {
        throw usageError(`"${project}" has no env "${env}" (envs: ${overview.envs.map((e) => e.name).join(", ")})`);
      }
      await saveDirSetup(process.cwd(), { project, env });
      print({ dir: process.cwd(), project, env }, () => console.log(`This directory now uses "${project}" / "${env}". Try: mybase run -- <command>`));
      return true;
    }
    case "envs": {
      const { project } = await target(flags, false);
      const overview = await api<SecretsOverview>(base(project));
      print(overview.envs, () => {
        for (const e of overview.envs) console.log(describeEnv(e));
      });
      return true;
    }
    case "env": {
      const [action, name, next] = positional;
      const { project } = await target(flags, false);
      if (action === "create") {
        const env = await api<SecretsEnv>(`${base(project)}/envs`, {
          method: "POST",
          body: JSON.stringify({ name: need(name, "env name"), parent: flagString(flags, "from") ?? null }),
        });
        print(env, () => console.log(`Created "${env.name}"${env.parent ? ` (inherits "${env.parent}")` : ""}`));
        return true;
      }
      if (action === "rename") {
        const env = await api<SecretsEnv>(envPath(project, need(name, "env name")), { method: "PATCH", body: JSON.stringify({ name: need(next, "new name") }) });
        print(env, () => console.log(`Renamed "${name}" to "${env.name}"`));
        return true;
      }
      if (action === "delete") {
        const env = need(name, "env name");
        confirm(yes, `This deletes env "${env}" of "${project}", its branch envs, and all their values and history.`, env, "the env name");
        await api(envPath(project, env), { method: "DELETE" });
        print({ deleted: env, project }, () => console.log(`Deleted "${env}"`));
        return true;
      }
      throw usageError("mybase secrets env create|rename|delete <name>");
    }
    case "list": {
      const { project, env } = await target(flags);
      const values = flags.has("values");
      const detail = await api<SecretsEnvDetail>(`${envPath(project, env)}${values ? "?values=1" : ""}`);
      print(detail, () => {
        if (detail.secrets.length === 0) console.log(`No keys in "${env}" yet.`);
        for (const s of detail.secrets) {
          const tags = [s.inherited ? `from ${detail.env.parent}` : "", s.managed && !s.link ? "managed" : ""].filter(Boolean).join(", ");
          const shown = s.link ? `${s.key} → ${describeLink(s.link)}` : values ? `${s.key}=${s.value}` : s.key;
          console.log(`${shown}${tags ? `\t(${tags})` : ""}`);
        }
      });
      return true;
    }
    case "get": {
      const key = need(positional[0], "key");
      const { project, env } = await target(flags);
      // Linked keys resolve for this machine; a database only reachable through the proxy points
      // at --proxy-port (default 5432), where `mybase db proxy` must run.
      const plan = await planReach(project, env);
      const proxyPort = plan.needsProxy ? (flagInt(flags, "proxy-port") ?? 5432) : null;
      const { value } = await api<{ value: string }>(`/secrets/${encodeURIComponent(project)}/${encodeURIComponent(env)}/${encodeURIComponent(key)}${reachQuery(plan, proxyPort)}`);
      if (proxyPort && !jsonMode) console.error(`note: the database is reached through the local proxy here: run \`mybase db proxy -p ${project} --port ${proxyPort}\` (or use \`mybase run\`)`);
      // Raw, so `$(mybase secrets get X)` works.
      if (jsonMode) print({ key, value }, () => {});
      else process.stdout.write(`${value}\n`);
      return true;
    }
    case "set": {
      if (positional.length === 0) throw usageError("mybase secrets set KEY=value …");
      const { project, env } = await target(flags);
      const set: Record<string, string> = {};
      for (const pair of positional) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw usageError(`expected KEY=value, got "${pair}"`);
        const value = pair.slice(eq + 1);
        set[pair.slice(0, eq)] = value === "-" ? await readStdin() : value;
      }
      printUpdate(await api(envPath(project, env, "/secrets"), { method: "PATCH", body: JSON.stringify({ set, message }) }), env);
      return true;
    }
    case "unset": {
      if (positional.length === 0) throw usageError("mybase secrets unset KEY …");
      const { project, env } = await target(flags);
      printUpdate(await api(envPath(project, env, "/secrets"), { method: "PATCH", body: JSON.stringify({ unset: positional, message }) }), env);
      return true;
    }
    case "upload": {
      const file = Bun.file(need(positional[0], ".env file"));
      if (!(await file.exists())) throw usageError(`no file ${positional[0]}`);
      const set = parseDotenv(await file.text());
      if (Object.keys(set).length === 0) throw usageError(`no KEY=value lines in ${positional[0]}`);
      const { project, env } = await target(flags);
      printUpdate(await api(envPath(project, env, "/secrets"), { method: "PATCH", body: JSON.stringify({ set, message: message ?? `uploaded ${positional[0]}` }) }), env);
      return true;
    }
    case "history": {
      const { project, env } = await target(flags);
      const revisions = await api<SecretsRevision[]>(`${envPath(project, env, "/revisions")}?limit=${flagInt(flags, "limit") ?? 20}`);
      print(revisions, () => {
        if (revisions.length === 0) console.log(`No changes in "${env}" yet.`);
        for (const r of revisions) {
          const changes = r.changes.map((c) => `${c.action === "added" ? "+" : c.action === "removed" ? "-" : "~"}${c.key}`).join(" ");
          console.log([`#${r.revision}`, r.createdAt, r.actor, r.message ?? "", changes].join("\t"));
        }
      });
      return true;
    }
    case "restore": {
      const revision = need(positional[0], "revision");
      const { project, env } = await target(flags);
      confirm(yes, `This puts the values of "${env}" back as they were after revision ${revision} (as a new revision; linked credentials stay).`, revision, "the revision");
      printUpdate(await api(envPath(project, env, `/revisions/${encodeURIComponent(revision)}/restore`), { method: "POST" }), env);
      return true;
    }
    case "link": {
      const services = SERVICE_FLAGS.filter((s) => flags.has(s));
      if (services.length > 0) {
        const { project, env } = await target(flags);
        const route = flagString(flags, "route") as LinkServicesRequest["route"];
        const body: LinkServicesRequest = {
          services,
          as: flagString(flags, "as"),
          route,
          sslmode: flagString(flags, "sslmode") as LinkServicesRequest["sslmode"],
          params: readParams(args),
          rotate: flags.has("rotate"),
        };
        if (route === "internal" && !jsonMode) {
          console.error(`warning: --route internal only works for hosted sites (the project network). \`mybase run\` and apps elsewhere won't reach ${services.join(", ")} with it; leave the route on auto unless "${env}" is only used by hosting.`);
        }
        const result = await postLink(project, env, body, yes);
        print(result, () => {
          for (const [key, ref] of Object.entries(result.links)) console.log(`${key} → ${describeLink(ref)}`);
          if (result.rotated.length) console.log(`Rotated: ${result.rotated.join(", ")} (apps using the old credentials need the linked env now).`);
          console.log(`Hosted sites resolve these on their next deploy (mybase hosting redeploy …); \`mybase run\` on its next start.`);
        });
        return true;
      }
      const { project, env } = await target(flags);
      const envs = env.split(",").map((e) => e.trim()).filter(Boolean);
      confirm(
        yes,
        `This rotates the credentials of "${project}" (database password, storage key, cache password if the cache is on, and the API key link made before) and stores the new ones, with the other services' keys, in ${envs.join(", ")} plus any env linked before. Apps still using the old credentials will stop working.`,
        project,
        "the project name",
      );
      const result = await api<LinkCredentialsResponse>(`${base(project)}/link`, { method: "POST", body: JSON.stringify({ envs }) });
      print(result, () => {
        console.log(`Rotated and stored in ${result.envs.join(", ")}: ${result.keys.join(", ")}`);
        console.log("Restart your apps with `mybase run` to pick them up.");
      });
      return true;
    }
    case "unlink": {
      if (positional.length > 0) {
        const { project, env } = await target(flags);
        for (const key of positional) await api(`${envPath(project, env, `/links/${encodeURIComponent(key)}`)}`, { method: "DELETE" });
        print({ unlinked: positional, project, env }, () => console.log(`Unlinked ${positional.join(", ")} in "${env}". Set new values with \`mybase secrets set\` if the app still needs them.`));
        return true;
      }
      const { project, env } = await target(flags);
      confirm(yes, `This removes the project credentials from "${env}". They stay valid; nothing is rotated.`, env, "the env name");
      await api(`${base(project)}/link/${encodeURIComponent(env)}`, { method: "DELETE" });
      print({ unlinked: env, project }, () => console.log(`Removed the credentials from "${env}"`));
      return true;
    }
    case "doctor": {
      const { project } = await target(flags, false);
      const env = flagString(flags, "env") ?? null;
      const findings = await api<SecretsDoctorFinding[]>(`${base(project)}/doctor${env ? `?env=${encodeURIComponent(env)}` : ""}`);
      if (jsonMode || findings.length === 0) {
        print(findings, () => console.log(`No hand-written credentials of "${project}" found${env ? ` in "${env}"` : ""}.`));
        return true;
      }
      for (const f of findings) console.log(`${f.env}\t${f.key}\t→ ${f.service}: ${f.reason}${f.host ? ` (points at ${f.host})` : ""}`);
      // Storage links write all five S3_* keys; offer it only when the env uses those names.
      const groups = new Map<string, { env: string; service: LinkService; keys: string[] }>();
      for (const f of findings) {
        const id = `${f.env}\0${f.service}`;
        const g = groups.get(id) ?? { env: f.env, service: f.service, keys: [] };
        g.keys.push(f.key);
        groups.set(id, g);
      }
      for (const g of groups.values()) {
        const key = g.keys[0]!;
        const defaults: Record<LinkService, string> = { database: "DATABASE_URL", cache: "REDIS_URL", storage: "S3_ACCESS_KEY_ID", api: "MYBASE_URL" };
        if (g.keys.length > 1 || (g.service === "storage" && key !== defaults.storage)) {
          console.log(`\n${g.env}: link ${g.keys.join(", ")} by hand, one at a time: mybase secrets link -p ${project} -e ${g.env} --${g.service} --as <KEY> --yes`);
          continue;
        }
        const as = g.service === "storage" || g.service === "api" ? undefined : key;
        const command = `mybase secrets link -p ${project} -e ${g.env} --${g.service}${as && as !== defaults[g.service] ? ` --as ${as}` : ""}`;
        if (!yes && !process.stdin.isTTY) {
          console.log(`\nTo convert: ${command} --yes`);
          continue;
        }
        if (!yes && !globalThis.confirm(`\nLink ${key} in "${g.env}" to ${g.service}? (${command})`)) continue;
        const result = await postLink(project, g.env, { services: [g.service], ...(as ? { as } : {}), replace: true }, yes);
        console.log(Object.keys(result.links).map((k) => `${k} → linked: ${g.service}`).join("\n"));
      }
      return true;
    }
    default:
      return false;
  }
}

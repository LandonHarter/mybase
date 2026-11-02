// Docker CLI calls for the hosting worker. Every name and value that reaches argv is validated
// here; env values never do (they go through the docker client's own env, `-e NAME`).
import { HOSTING_SITE_PATTERN, isReservedHostingEnv, PROJECT_NAME_PATTERN } from "@mybase/shared";

export const DEPLOY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `<host:port>/<project>/<site>@sha256:<hex>`: only images from our registry, by digest. */
export const IMAGE_REF = /^[a-z0-9.-]+(?::\d+)?\/[a-z][a-z0-9_]{2,39}\/[a-z0-9-]{1,40}@sha256:[0-9a-f]{64}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MEMORY = /^\d+[kmg]?$/i;

export const networkName = (project: string) => `mybase-p-${project}`;
export const containerName = (site: string, deploy: string) => `mybase-site-${site}-${deploy.slice(0, 8)}`;

export class BadInput extends Error {}

export interface RunSpec {
  deploy: string;
  project: string;
  site: string;
  image: string;
  env: Record<string, string>;
  memory: string;
}

export function readSpec(deploy: string, body: unknown): RunSpec {
  const b = (body ?? {}) as Partial<RunSpec>;
  if (!DEPLOY_ID.test(deploy)) throw new BadInput("invalid deploy id");
  if (typeof b.project !== "string" || !PROJECT_NAME_PATTERN.test(b.project)) throw new BadInput("invalid project");
  if (typeof b.site !== "string" || !HOSTING_SITE_PATTERN.test(b.site)) throw new BadInput("invalid site");
  if (typeof b.image !== "string" || !IMAGE_REF.test(b.image)) throw new BadInput("invalid image");
  if (typeof b.memory !== "string" || !MEMORY.test(b.memory)) throw new BadInput("invalid memory limit");
  const env = b.env ?? {};
  if (typeof env !== "object" || Array.isArray(env)) throw new BadInput("invalid env");
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || typeof v !== "string" || v.includes("\0")) throw new BadInput("invalid env");
    if (isReservedHostingEnv(k)) throw new BadInput(`env var ${k} can't be set on a site`);
  }
  return { deploy, project: b.project, site: b.site, image: b.image, env, memory: b.memory };
}

export function runArgs(spec: RunSpec): string[] {
  return [
    "run", "-d", "--name", containerName(spec.site, spec.deploy),
    "--label", "mybase.hosting=true", "--label", `mybase.project=${spec.project}`, "--label", `mybase.site=${spec.site}`, "--label", `mybase.deploy=${spec.deploy}`,
    "--network", networkName(spec.project), "--restart", "unless-stopped",
    `--memory=${spec.memory}`, `--memory-swap=${spec.memory}`, "--pids-limit=512",
    // Docker's default capabilities minus the ones web servers never need.
    "--cap-drop=NET_RAW", "--cap-drop=MKNOD", "--cap-drop=AUDIT_WRITE", "--cap-drop=SETFCAP", "--cap-drop=SYS_CHROOT",
    "--security-opt=no-new-privileges:true",
    // Bounded on disk (SD cards): two 5 MB files per container.
    "--log-driver=local", "--log-opt=max-size=5m", "--log-opt=max-file=2",
    ...Object.keys(spec.env).flatMap((k) => ["-e", k]),
    spec.image,
  ];
}

// The docker client's own settings only: the worker's key must not leak into `-e` lookups.
const dockerEnv: Record<string, string> = Object.fromEntries(
  ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);

export interface Result { code: number; out: string; err: string }

/** Runs the docker CLI. `env` is added to its environment (for `-e NAME`). Never throws on exit codes. */
export async function docker(args: string[], { env, timeoutMs = 30_000, max = 1 << 20 }: { env?: Record<string, string>; timeoutMs?: number; max?: number } = {}): Promise<Result> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL",
    // The client's own settings last: site env (checked by readSpec) never overrides them.
    env: { ...env, ...dockerEnv },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out.slice(0, max), err: err.slice(0, 4096) };
}

/** Like `docker`, but throws with a short reason on failure. */
export async function must(args: string[], opts?: Parameters<typeof docker>[1]): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${r.err.trim().split("\n").pop() ?? `exit ${r.code}`}`);
  return r.out;
}

/** `a=b,c=d` (docker ps's Labels column) → object. Label values here never contain commas. */
export function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return labels;
}

/**
 * Whether a busybox `wget -S` probe reached a server. Any HTTP answer below 500 counts: the
 * app is up, even if the health path is a 404.
 */
export function probeHealthy(r: Result): boolean {
  if (r.code === 0) return true;
  const m = /HTTP\/[\d.]+ (\d{3})/.exec(r.err);
  return m !== null && Number(m[1]) < 500;
}

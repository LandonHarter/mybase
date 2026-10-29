import * as p from "@clack/prompts";
import { join } from "node:path";
import { isIP } from "node:net";
import { publicSandboxIp } from "@mybase/shared/public-ip";
import { sandboxConfig } from "@mybase/shared/sandbox";
import { PROJECT_NAME_PATTERN } from "@mybase/shared";
import { CLI_VERSION } from "./api";
import { CliError, jsonMode, print, usageError } from "./output";
import { composeEnv, checkDocker, waitHealthy } from "./server-docker";
import { mergeEnv, parseEnv } from "./server-env";
import { checkSandboxDocker, hostRun, installGvisor, type HostRunner, type SandboxDockerInfo } from "./server-gvisor";
import { imageTag, LOCAL_SANDBOX_WORKER, sandboxImages, sandboxProfileOn, sandboxSettings } from "./server-sandbox-env";
import { flag, localUrl, pullHint, serverDir, ui, writeFiles } from "./server-setup";
import { enableService } from "./service-enable";

export const WORKER_HEALTH = "fetch('http://127.0.0.1:4010/health',{headers:{Authorization:'Bearer '+process.env.MYBASE_SANDBOX_WORKER_KEY},signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)process.exit(1);const d=await r.json();if(!d.ok)process.exit(1);console.log(JSON.stringify(d))}).catch(()=>process.exit(1))";
interface Dependencies {
  run: HostRunner;
  publicIp: () => Promise<string | null>;
  installRuntime: (info: SandboxDockerInfo, run: HostRunner) => Promise<boolean>;
  waitApi: typeof waitHealthy;
}
async function publicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ip = /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim();
    return ip && isIP(ip) && publicSandboxIp(ip) ? ip : null;
  } catch { return null; }
}
const defaults: Dependencies = { run: hostRun, publicIp, installRuntime: installGvisor, waitApi: waitHealthy };
async function composeRun(run: HostRunner, dir: string, args: string[], timeoutMs = 60_000) {
  return run(["docker", "compose", ...args], { cwd: dir, env: composeEnv(), timeoutMs });
}
async function imageVersion(values: Record<string, string>, run: HostRunner) {
  const image = values.MYBASE_IMAGE || "ghcr.io/landonharter/mybase:latest";
  const result = await run(["docker", "image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', image]);
  return result.ok && imageTag(result.stdout.trim()) ? result.stdout.trim() : CLI_VERSION;
}
async function pullImage(image: string, run: HostRunner, pull: boolean) {
  const exists = (await run(["docker", "image", "inspect", image])).ok;
  if (exists && !pull) return;
  const result = await run(["docker", "pull", "--quiet", image], { timeoutMs: 900_000 });
  if (!result.ok && !exists) throw new CliError(`couldn't download ${image}:\n${result.stderr}${pullHint(result.stderr)}\nUse matching published images, or pass --image and --worker-image for local builds.`);
}

/** Also called by normal server updates: guest images are not a Compose service. */
export async function refreshSandboxImages(dir: string, values: Record<string, string>, pull = true, run: HostRunner = hostRun) {
  if (!sandboxProfileOn(values) || values.MYBASE_SANDBOX_WORKER_URL !== LOCAL_SANDBOX_WORKER) return values;
  const images = sandboxImages(values, await imageVersion(values, run));
  await pullImage(images.image, run, pull);
  await pullImage(images.workerImage, run, pull);
  const updates = { MYBASE_SANDBOX_IMAGE: images.image, MYBASE_SANDBOX_WORKER_IMAGE: images.workerImage };
  if (Object.entries(updates).some(([key, value]) => values[key] !== value)) {
    const text = await Bun.file(join(dir, ".env")).text();
    await Bun.write(join(dir, ".env"), mergeEnv(text, updates));
  }
  return { ...values, ...updates };
}

export async function sandboxWorkerHealth(dir: string, run: HostRunner = hostRun) {
  const result = await composeRun(run, dir, ["exec", "-T", "sandbox-worker", "bun", "-e", WORKER_HEALTH], 10_000);
  if (!result.ok) return null;
  try {
    const health = JSON.parse(result.stdout) as { ok: boolean; capacity: number | null; active: number };
    return health.ok ? health : null;
  } catch { return null; }
}

async function probeRuntime(image: string, run: HostRunner, resources: ReturnType<typeof sandboxConfig>["resources"]) {
  const name = `mybase-sandbox-probe-${crypto.randomUUID()}`;
  const code = "const timer=setTimeout(()=>process.exit(1),15000);const {chromium}=require('/opt/runtime/node_modules/playwright');chromium.launch({headless:true,chromiumSandbox:false,args:['--disable-dev-shm-usage']}).then(async b=>{await b.close();clearTimeout(timer)}).catch(()=>process.exit(1))";
  try {
    const result = await run(["docker", "run", "--rm", "--name", name, "--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true", `--cpus=${resources.cpus}`, `--memory=${resources.memoryMb}m`, `--memory-swap=${resources.memoryMb}m`, `--pids-limit=${resources.pids}`, `--ulimit=nproc=${resources.pids}:${resources.pids}`, "--log-driver=none",
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${resources.tmpMb}m,uid=1000,gid=1000,mode=0700`, "--tmpfs", `/workspace:rw,nosuid,nodev,size=${resources.workspaceMb}m,uid=1000,gid=1000,mode=0700`, `--shm-size=${resources.shmMb}m`,
      "--entrypoint", "node", image, "-e", code], { timeoutMs: 60_000 });
    if (!result.ok) throw new CliError(`gVisor was detected but the isolated Chromium/resource-limit check failed:\n${result.stderr || "the runtime couldn't launch Chromium"}\nCheck the host's gVisor and cgroup support. Ordinary containers will not be used as a fallback.`);
  } finally { await run(["docker", "rm", "-f", name]); }
}

export interface SandboxHostResult { dir: string; url: string; runtimeInstalled: boolean; image: string; workerImage: string; healthy: boolean }

/** Host-side only. Never invoked by an HTTP handler or given access to a remote Docker daemon. */
export async function prepareSandboxHost(args: string[], options: { start?: boolean; confirmed?: boolean } = {}, overrides: Partial<Dependencies> = {}): Promise<SandboxHostResult> {
  const io = { ...defaults, ...overrides };
  const dir = await serverDir(args);
  const file = Bun.file(join(dir, ".env"));
  if (!(await file.exists()) || !(await Bun.file(join(dir, "compose.yml")).exists())) throw new CliError(`no mybase server in ${dir}; run mybase server setup --sandboxes first`, 4);
  const text = await file.text();
  const values = parseEnv(text);
  const config = sandboxConfig(values.MYBASE_SANDBOX_CONFIG);
  const interactive = !jsonMode && process.stdin.isTTY === true && !args.includes("--yes");
  if (!options.confirmed && !args.includes("--yes")) {
    if (!interactive) throw usageError("without a terminal, pass --yes to configure sandbox host support");
    const answer = await p.confirm({ message: "Configure agent sandboxes on this host? Installs/registers gVisor if missing, downloads Chromium images, and applies the worker/API configuration.", initialValue: true });
    if (p.isCancel(answer) || !answer) throw new CliError("sandbox host setup cancelled; nothing changed");
  }
  const check = overrides.run ? null : checkDocker();
  if (check && !check.ok) throw new CliError(check.problem!);
  const s = ui.spinner();
  s.start("Checking Docker and sandbox prerequisites");
  try {
    const infoResult = await io.run(["docker", "info", "--format", "{{json .}}"]);
    if (!infoResult.ok) throw new CliError(`can't inspect Docker: ${infoResult.stderr}`);
    let info = JSON.parse(infoResult.stdout) as SandboxDockerInfo;
    const context = await io.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST : context.stdout.trim();
    checkSandboxDocker(info, endpoint);
    const settings = sandboxSettings(values, { version: await imageVersion(values, io.run), publicIp: await io.publicIp(),
      extraHosts: flag(args, "--deny-hosts"), image: flag(args, "--image"), workerImage: flag(args, "--worker-image") });
    s.message(info.Runtimes.runsc ? "Reusing the registered gVisor runtime" : "Downloading and registering gVisor (sudo may ask for your password)");
    const runtimeInstalled = await io.installRuntime(info, io.run);
    if (runtimeInstalled) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const next = await io.run(["docker", "info", "--format", "{{json .}}"]);
        if (next.ok) info = JSON.parse(next.stdout);
        if (info.Runtimes.runsc) break;
        await Bun.sleep(500);
      }
    }
    if (!info.Runtimes.runsc) throw new CliError("gVisor was installed but Docker hasn't registered runsc. Check the daemon's configuration/reload, then retry; no sandbox settings were written");
    s.message("Downloading sandbox images (only missing images; local builds are kept)");
    await pullImage(settings.MYBASE_SANDBOX_IMAGE!, io.run, false);
    await pullImage(settings.MYBASE_SANDBOX_WORKER_IMAGE!, io.run, false);
    s.message("Verifying Chromium under gVisor with bounded resources");
    await probeRuntime(settings.MYBASE_SANDBOX_IMAGE!, io.run, config.resources);
    // Commit only after host/runtime/image checks pass. Existing keys, profiles and custom settings stay intact.
    await writeFiles(dir, mergeEnv(text, settings), interactive, true);
    const current = { ...values, ...settings };
    const url = localUrl(current);
    let healthy = false;
    if (options.start !== false) {
      s.message("Starting the sandbox worker and applying API settings");
      const up = await composeRun(io.run, dir, ["--profile", "sandbox", "up", "-d", "mybase", "sandbox-worker"], 180_000);
      if (!up.ok) throw new CliError(`sandbox containers couldn't start:\n${up.stderr}\nSettings are saved; rerun this command to retry.`);
      const deadline = Date.now() + 60_000;
      do {
        if (await sandboxWorkerHealth(dir, io.run)) { healthy = true; break; }
        await Bun.sleep(1000);
      } while (Date.now() < deadline);
      if (!healthy) throw new CliError("sandbox worker didn't become healthy; run `mybase server logs sandbox-worker --no-follow`, fix the reported host issue, and rerun this command");
      if (!(await io.waitApi(url, 120_000))) throw new CliError(`worker is ready, but the API isn't answering at ${url}; check mybase server status`);
    }
    s.stop(options.start === false ? "Sandbox host configured" : "Sandbox worker is ready");
    return { dir, url, runtimeInstalled, image: settings.MYBASE_SANDBOX_IMAGE!, workerImage: settings.MYBASE_SANDBOX_WORKER_IMAGE!, healthy };
  } catch (err) { s.error("Sandbox host setup stopped"); throw err; }
}

export async function setupSandboxServer(args: string[]) {
  const project = flag(args, "--project");
  if (project && !PROJECT_NAME_PATTERN.test(project)) throw usageError("--project must be a valid mybase project name");
  const result = await prepareSandboxHost(args);
  if (project) {
    const flags = new Map<string, string | true>([...args.filter(a => a === "--link" || a === "--no-link").map(a => [a.slice(2), true] as [string, true])]);
    await enableService(project, "sandbox", flags, { url: result.url });
  }
  print({ ...result, project: project ?? null, enabled: !!project }, () => {
    ui.success(project ? `Sandboxes enabled for ${project}` : "Sandboxes are ready. Enable them in the dashboard, or run mybase sandbox enable <project>.");
    ui.info("Individual sandbox containers now start and stop automatically.");
  });
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_VERSION } from "./api";
import { parseEnv } from "./server-env";
import { prepareSandboxHost } from "./server-sandbox";
import type { HostResult, SandboxDockerInfo } from "./server-gvisor";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const ok = (stdout = ""): HostResult => ({ ok: true, stdout, stderr: "" });
const key = "b".repeat(64);

describe("automated sandbox host setup", () => {
  test("checks the runtime, downloads images, configures and starts the worker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mybase-sandbox-setup-")); temporary.push(dir);
    await Bun.write(join(dir, "compose.yml"), "services: {}\n");
    await Bun.write(join(dir, ".env"), `COMPOSE_PROFILES=tunnel\nMYBASE_PUBLIC_URL=https://mybase.example.com\nMYBASE_SANDBOX_WORKER_KEY=${key}\n`);
    const images = new Set<string>();
    const commands: string[][] = [];
    const info: SandboxDockerInfo = {
      Architecture: "x86_64", OperatingSystem: "Ubuntu", KernelVersion: "6.8.0", CgroupVersion: "2",
      MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, Runtimes: {},
    };
    const run = async (args: string[]): Promise<HostResult> => {
      commands.push(args);
      if (args[1] === "info") return ok(JSON.stringify(info));
      if (args[1] === "context") return ok("unix:///var/run/docker.sock\n");
      if (args[1] === "image" && args[2] === "inspect") {
        if (args.includes("--format")) return ok(`${CLI_VERSION}\n`);
        return images.has(args.at(-1)!) ? ok() : { ok: false, stdout: "", stderr: "missing" };
      }
      if (args[1] === "pull") { images.add(args.at(-1)!); return ok(); }
      if (args[1] === "run") {
        expect(args).toContain("--runtime=runsc");
        expect(args).toContain("--network=none");
        expect(args).toContain("--read-only");
        expect(args).toContain("--cap-drop=ALL");
        expect(args).not.toContain("--privileged");
        expect(args.join(" ")).not.toContain("docker.sock");
        return ok();
      }
      if (args[1] === "rm") return ok();
      if (args[1] === "compose" && args.includes("exec")) return ok('{"ok":true,"capacity":2,"active":0}');
      if (args[1] === "compose" && args.includes("up")) return ok();
      throw new Error(`unexpected host command: ${args.join(" ")}`);
    };
    const result = await prepareSandboxHost(["--dir", dir, "--yes"], {}, {
      run, publicIp: async () => "8.8.8.8",
      installRuntime: async () => { info.Runtimes.runsc = { path: "/usr/local/bin/runsc" }; return true; },
      waitApi: async () => CLI_VERSION,
    });
    const env = parseEnv(await readFile(join(dir, ".env"), "utf8"));
    expect(result.healthy).toBeTrue();
    expect(result.runtimeInstalled).toBeTrue();
    expect(env.COMPOSE_PROFILES).toBe("tunnel,sandbox");
    expect(env.MYBASE_SANDBOX_WORKER_KEY).toBe(key);
    expect(env.MYBASE_SANDBOX_DENY_HOSTS).toContain("8.8.8.8");
    expect(env.MYBASE_SANDBOX_IMAGE).toBe(`ghcr.io/landonharter/mybase-sandbox:${CLI_VERSION}`);
    expect(images).toEqual(new Set([env.MYBASE_SANDBOX_IMAGE!, env.MYBASE_SANDBOX_WORKER_IMAGE!]));
    expect(commands.some(args => args[1] === "compose" && args.includes("up") && args.includes("sandbox-worker"))).toBeTrue();
  });

  test("does not write settings when the hardened runtime probe fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mybase-sandbox-failed-")); temporary.push(dir);
    const original = "MYBASE_PUBLIC_URL=https://mybase.example.com\n";
    await Bun.write(join(dir, "compose.yml"), "services: {}\n");
    await Bun.write(join(dir, ".env"), original);
    const run = async (args: string[]): Promise<HostResult> => {
      if (args[1] === "info") return ok(JSON.stringify({
        Architecture: "aarch64", OperatingSystem: "Debian", KernelVersion: "6.12.0", CgroupVersion: "2",
        MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, Runtimes: { runsc: {} },
      }));
      if (args[1] === "context") return ok("unix:///var/run/docker.sock\n");
      if (args[1] === "image") return ok();
      if (args[1] === "run") return { ok: false, stdout: "", stderr: "gVisor cannot start Chromium" };
      if (args[1] === "rm") return ok();
      throw new Error(`unexpected host command: ${args.join(" ")}`);
    };
    await expect(prepareSandboxHost(["--dir", dir, "--yes"], {}, {
      run, publicIp: async () => "8.8.8.8", installRuntime: async () => false,
    })).rejects.toThrow("isolated Chromium/resource-limit check failed");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe(original);
  });
});

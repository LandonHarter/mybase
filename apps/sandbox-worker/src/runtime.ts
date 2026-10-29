import type { ExecuteSandbox, SandboxExecution } from "@mybase-dev/sdk/sandbox";
import { SANDBOX_RESOURCES as resources, SANDBOX_LIMITS as limits } from "@mybase/shared/sandbox";

export const containerName = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("invalid sandbox id");
  return `mybase-sandbox-${id}`;
};
export function createArgs(id: string, project: string, image: string, seconds: number): string[] {
  return ["run", "-d", "--name", containerName(id), "--label", "mybase.sandbox=true", "--label", `mybase.project=${project}`,
    "--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    `--cpus=${resources.cpus}`, `--memory=${resources.memoryMb}m`, `--memory-swap=${resources.memoryMb}m`, `--pids-limit=${resources.pids}`,
    "--ulimit=nofile=1024:1024", `--ulimit=nproc=${resources.pids}:${resources.pids}`, "--ulimit=core=0:0", "--log-driver=none", "--restart=no", "--stop-timeout=2",
    "--tmpfs", `/workspace:rw,nosuid,nodev,size=${resources.workspaceMb}m,uid=1000,gid=1000,mode=0700`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700", "--shm-size=64m",
    image, String(seconds)];
}
export async function bounded(stream: ReadableStream<Uint8Array>, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let length = 0; let truncated = false;
  for await (const chunk of stream) {
    const remaining = max - length;
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) { const part = Buffer.from(chunk).subarray(0, remaining); chunks.push(part); length += part.length; }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}
export async function docker(args: string[], input?: Uint8Array, max = 65536, timeoutMs = 30_000): Promise<Buffer> {
  const child = Bun.spawn(["docker", ...args], { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (input) { child.stdin!.write(input); child.stdin!.end(); }
  // Native timeout closes subprocess pipes too; a JS SIGTERM timer could wait indefinitely
  // for a stubborn child or inherited pipe writer after the deadline.
  const [out, , code] = await Promise.all([bounded(child.stdout, max), bounded(child.stderr, 4096), child.exited]);
  if (code || out.truncated) throw new Error(`sandbox runtime ${args[0]} operation failed (exit ${code})`);
  return out.bytes;
}
export function runExecution(id: string, sandboxId: string, input: ExecuteSandbox, done: (result: SandboxExecution) => void,
  stopGuest: (state: "timed_out" | "cancelled") => void) {
  const args = ["node", "/opt/runtime/execute.mjs", JSON.stringify(input)];
  const controller = new AbortController();
  const child = Bun.spawn(["docker", "exec", "--workdir=/workspace", containerName(sandboxId), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: controller.signal, killSignal: "SIGKILL" });
  const result: SandboxExecution = { id, sandboxId, state: "running", exitCode: null, stdout: "", stderr: "", truncated: false, startedAt: new Date().toISOString(), finishedAt: null };
  // The worker owns whole-guest destruction. Never race it with a second docker rm here:
  // Docker rejects concurrent removals and cancellation could return before cleanup finishes.
  const timer = setTimeout(() => stop("timed_out"), input.timeoutMs);
  function stop(state: "timed_out" | "cancelled") {
    if (result.finishedAt || result.state !== "running") return;
    result.state = state;
    stopGuest(state);
    controller.abort();
  }
  void Promise.all([bounded(child.stdout, limits.outputBytes), bounded(child.stderr, limits.outputBytes), child.exited]).then(([out, err, code]) => {
    result.exitCode = code;
    result.stdout = out.bytes.toString("utf8"); result.stderr = err.bytes.toString("utf8"); result.truncated = out.truncated || err.truncated;
    if (result.state === "running") result.state = code === 0 ? "success" : "failed";
    result.finishedAt = new Date().toISOString(); clearTimeout(timer); done(result);
  }).catch(() => {
    if (result.finishedAt) return;
    if (result.state === "running") result.state = "failed";
    result.exitCode = child.exitCode;
    result.stderr = "execution transport interrupted";
    result.finishedAt = new Date().toISOString(); clearTimeout(timer); done(result);
  });
  return { result, cancel: () => stop("cancelled") };
}

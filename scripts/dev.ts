#!/usr/bin/env bun
// Runs every dev service at once and prefixes each output line with a colored
// service name, so interleaved logs (including crashes and stack traces that
// bypass the logger) are always attributable.
import { color, createLogger, serviceColor } from "@mybase/shared/logger";

const services = [
  { name: "api", cwd: "apps/api" },
  { name: "dashboard", cwd: "apps/dashboard" },
];

const root = new URL("..", import.meta.url).pathname;
const width = Math.max(...services.map((s) => s.name.length));
const log = createLogger("dev");

const env = {
  ...process.env,
  MYBASE_LOG_PREFIXED: "1",
  // Children write to a pipe, not a TTY, so tell them whether to keep colors.
  ...(process.stdout.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: "1" } : {}),
};

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) out.write(`${prefix}${line}\n`);
  }
  if (buffer) out.write(`${prefix}${buffer}\n`);
}

const children = services.map(({ name, cwd }) => {
  const prefix = `${serviceColor(name)(name.padEnd(width))} ${color.dim("│")} `;
  const proc = Bun.spawn(["bun", "run", "--silent", "dev"], {
    cwd: `${root}${cwd}`,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  pipe(proc.stdout, prefix, process.stdout);
  pipe(proc.stderr, prefix, process.stderr);
  return { name, proc };
});

log.info("started", { services: services.map((s) => s.name).join(",") });

let shuttingDown = false;
async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("stopping");
  for (const { proc } of children) proc.kill("SIGTERM");
  await Promise.all(children.map(({ proc }) => proc.exited));
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// If any service dies, stop the rest instead of leaving a half-running stack.
for (const { name, proc } of children) {
  proc.exited.then((code) => {
    if (shuttingDown) return;
    log.error("service exited, stopping all", { service: name, code });
    shutdown(code || 1);
  });
}

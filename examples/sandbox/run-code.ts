// Run untrusted JavaScript (a user's snippet, a coding exercise, a plugin) and return its output.
// Run: MYBASE_API_URL=... MYBASE_API_KEY=... bun examples/sandbox/run-code.ts <project> <file.mjs>
import { createSandboxClient } from "@mybase-dev/sdk/sandbox";

const [project, file] = process.argv.slice(2);
if (!project || !file || !process.env.MYBASE_API_KEY) throw new Error("provide project, a .mjs file, and MYBASE_API_KEY (sandbox:write)");
const client = createSandboxClient({ apiUrl: process.env.MYBASE_API_URL ?? "http://localhost:4000", project, apiKey: process.env.MYBASE_API_KEY });

const code = await Bun.file(file).text();
// A short lifetime and execution timeout keep a runaway script from holding resources.
const box = await client.create({ key: crypto.randomUUID(), ttlSeconds: 120 });
try {
  const ready = await client.wait(box.id, AbortSignal.timeout(100_000));
  if (ready.state !== "ready") throw new Error(`sandbox provisioning failed: ${ready.reason}`);
  const run = await client.execute(box.id, { key: "run", code, timeoutMs: 10_000 });
  const result = await client.waitExecution(box.id, run.id, AbortSignal.timeout(30_000));
  console.log(JSON.stringify({ state: result.state, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated }, null, 2));
} finally {
  await client.terminate(box.id);
}

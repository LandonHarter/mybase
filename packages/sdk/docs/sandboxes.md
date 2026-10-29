---
title: Agent sandbox client
summary: Create isolated browser workspaces, run JavaScript, and export private artifacts.
section: Sandboxes
order: 1
---

# Agent sandbox client

Create temporary isolated Node.js/Chromium workspaces from your app's server. mybase supplies
compute and lifecycle; your app chooses the model and runs its agent loop. The SDK has no
Playwright or model-provider dependency. Work submitted here appears in the project's
**Agent sandboxes → Runs** dashboard alongside CLI and dashboard work.

## Connect and create

On the Linux Docker host, first run `mybase server sandbox --project touse` to prepare the
worker and enable the project. Install the client and create a project-limited API key:

```sh
npm install @mybase-dev/sdk
mybase token create touse-agent --project touse --perm sandbox:write
```

Keep the key in your server's `MYBASE_API_KEY` environment variable. Never pass it or model
credentials into the guest. The following creates a sandbox, waits until ready, runs a page
inspection, exports a screenshot, and requests termination in `finally`:

```ts
import { createSandboxClient } from "@mybase-dev/sdk/sandbox";
const sandboxes = createSandboxClient({ apiUrl: "{{MYBASE_URL}}", project: "touse", apiKey: process.env.MYBASE_API_KEY! });
const box = await sandboxes.create({ key: crypto.randomUUID(), profile: "browser", ttlSeconds: 180 });
try {
  const ready = await sandboxes.wait(box.id, AbortSignal.timeout(100_000));
  if (ready.state !== "ready") throw new Error(ready.reason ?? ready.state);
  const run = await sandboxes.execute(box.id, {
    key: "inspect",
    code: `import { chromium } from 'playwright';
      const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
      const page = await browser.contexts()[0].newPage();
      await page.goto('https://example.com');
      console.log(await page.locator('body').innerText());
      await page.screenshot({path:'page.png'});
      await page.close(); await browser.close();`,
    timeoutMs: 30000,
  });
  const result = await sandboxes.waitExecution(box.id, run.id, AbortSignal.timeout(60_000));
  if (result.state !== "success") throw new Error(result.stderr || result.state);
  const artifact = await sandboxes.exportArtifact(box.id, "page.png", "image/png");
  const response = await sandboxes.artifact(box.id, artifact.id); // streamed binary Response
  // Stream response.body to your app's storage, or read these bounded bytes:
  const screenshot = new Uint8Array(await response.arrayBuffer());
} finally { await sandboxes.terminate(box.id); }
```

`key` is a required idempotency key, unique within a project for creation and within a sandbox
for execution. Use 1–80 letters, digits, underscores, or hyphens. Retrying the same key with the
same normalized input returns the same ID; changing its input returns 409. Retain keys across
network retries instead of generating a fresh key each attempt. Keys/metadata are retained seven days.

## Lifecycle and execution results

`create` and `execute` return promptly with durable queued records. `wait` polls until the
sandbox leaves Queued/Starting; **check for Ready**, since provisioning may fail. `waitExecution`
polls until an execution is terminal; **check for Success** rather than assuming the poll succeeded
because it returned.

| Option | Default | Range |
| --- | --- | --- |
| `profile` | `"browser"` | Only supported profile |
| `ttlSeconds` | `null` (no expiry) | Optional positive integer seconds, starts at admission |
| `idleSeconds` | `null` (no idle expiry) | Optional positive integer seconds |
| Execution `timeoutMs` | `null` (no timeout) | Optional positive integer milliseconds |
| Client request `timeoutMs` | 30000 | Per HTTP request; does not set execution lifetime |

Omitting a deadline or passing `null` disables it. Explicit deadlines have no fixed policy ceiling.
Terminate sandboxes explicitly when finished. `get(id)` returns lifecycle state, reason, creation/start/finish/deadline timestamps (`expiresAt: null` without a lifetime), resource
allocation, elapsed runtime, execution count, and exported bytes. `list()` returns the latest 100
sandboxes, newest first. Sandbox states are `queued`, `provisioning`, `ready`, `stopping`,
`terminated`, `expired`, and `failed`. Terminal guests cannot restart.

`executions(id)` and `execution(id, runId)` return structured results with:

- `state`: `queued`, `running`, `success`, `failed`, `timed_out`, or `cancelled`;
- `exitCode` (nullable), `startedAt`, and `finishedAt`;
- `stdout`, `stderr`, and `truncated`. Each output stream defaults to a host-configurable 64 KiB cap; output is collected
  at completion, not streamed live. Source code/command input is not returned in run history.

ESM code runs in `/workspace` with Playwright installed. Commands take an argument array and
do not get an implicit shell:

```ts
const run = await sandboxes.execute(box.id, {
  key: "node-version",
  command: ["node", "--version"],
  timeoutMs: 5000,
});
const result = await sandboxes.waitExecution(box.id, run.id);
if (result.state !== "success") throw new Error(result.stderr || result.state);
console.log(result.exitCode, result.stdout);
```

Exactly one of `code` or `command` is required. One execution/transfer/CDP connection can use a
sandbox at a time; competing operations return 409. Successful sequential executions share
filesystem and browser state. There is no package-installation API or arbitrary guest-image option.

## Connect an external browser client

An external app with Playwright can connect to the same guest Chromium using standard CDP.
Install Playwright in your app only for this mode. Inside guest code it is already installed.

```ts
import { chromium } from "playwright";
const connection = await sandboxes.browser(box.id);
const browser = await chromium.connectOverCDP(connection.endpoint, { headers: connection.headers });
// Header includes normal API authentication plus single-use sandbox-scoped browser credential.
// Acquire within 30s; no fixed connection lifetime; exclusive with execution/files.
try {
  const page = await browser.contexts()[0].newPage();
  page.on("response", async response => { /* response.json(), response.body() */ });
  await page.goto("https://example.com");
  console.log(await page.title());
} finally {
  await browser.close();
}
```

The endpoint is a WebSocket CDP bridge, not Playwright's native protocol. Headers include normal
API auth plus a single-use sandbox credential; keep them out of URLs, logs, and guest code.
Redeem within 30 seconds. Established connections have no fixed lifetime (`maxConnectionSeconds: null`). Disconnect before
running code, transferring files, or exporting artifacts. Issue a fresh credential to reconnect.

Pages can reach public TCP 80/443 destinations only, with private/infrastructure addresses denied.
The service does not guarantee access to sites that block automated browsers and supplies no
CAPTCHA bypass. The dashboard provides run inspection, not live video or human takeover.

## Workspace files and retained artifacts

Workspace files are temporary. Transfer known relative paths (no leading `/`, dot segments,
or backslashes); each file defaults to at most 8 MiB, configurable by the host owner:

```ts
await sandboxes.upload(box.id, "input.json", new TextEncoder().encode(JSON.stringify({ hello: "world" })));
const run = await sandboxes.execute(box.id, {
  key: "transform",
  code: `import { readFile, writeFile } from "node:fs/promises";
    const input = JSON.parse(await readFile("input.json", "utf8"));
    await writeFile("result.json", JSON.stringify({ ...input, processed: true }));`,
});
const result = await sandboxes.waitExecution(box.id, run.id);
if (result.state !== "success") throw new Error(result.stderr || result.state);

const temporary = await sandboxes.download(box.id, "result.json"); // binary Response
const artifact = await sandboxes.exportArtifact(box.id, "result.json", "application/json");
console.log(artifact.id, artifact.sha256, artifact.expiresAt);

await sandboxes.terminate(box.id);
// Exported artifacts remain downloadable after termination, until retention cleanup:
const saved = await sandboxes.artifact(box.id, artifact.id);
const json = await saved.json();
```

`artifacts(id)` lists retained file metadata: ID, name, type, byte size, SHA-256, and expiration.
`artifact(id, artifactId)` streams an authenticated attachment. Exporting identical path/content
returns the existing artifact; changed bytes create another version. There are no artifact-count,
aggregate-byte, or daily export quotas. Artifact expiry is seven days;
sandbox metadata also has seven-day retention. Disabling the service deletes artifacts and history.

The SDK does not enumerate workspace directories. Use code when directory inspection is needed.
Export before termination, expiry, cancellation, or timeout: once the guest is gone, temporary
files cannot be recovered. Private artifact files are in the project's existing Garage bucket.

## Usage and cancellation

`usage()` returns `active`, `allocatedSecondsToday`, `runtimeMsToday`, `executionsToday`,
`artifactBytesToday`, and legacy `limits` fields, all `null` to mean unlimited. There are no
project/global sandbox-count, daily allocation/runtime, or execution-count quotas. Daily usage is
attributed to the sandbox's UTC admission day. `allocatedSecondsToday` sums only explicit lifetimes;
it is accounting, not a budget. CPU/memory/process, file, output, and concurrent-network controls
are configured by the host owner through `MYBASE_SANDBOX_CONFIG`; see platform `sandboxes`.

All operations accept an optional final `AbortSignal`. Aborting cancels the client request or
poll, **not already admitted work**. Explicitly call `cancel(id, runId)` or `terminate(id)` when
you want to stop work. Execution cancellation and execution timeout destroy the **entire guest**
and process tree. `terminate` returns the stop request state; poll `get` until terminal when you
need confirmation that cleanup/capacity release has completed. Inspection calls do not renew idle time.

API/worker restarts can fail interrupted work. No automatic command replay or guest checkpoint exists.
If a dispatch outcome is uncertain, inspect status and reason rather than starting the command again.

## Errors and permissions

API failures throw `MybaseApiError` with an HTTP `status`:

| Status | Common cause | Next step |
| --- | --- | --- |
| 400 | Invalid profile, duration, path, code, or argument array | Correct the input |
| 403 | Missing permission or wrong project scope | Use a key scoped to the project with the required permission |
| 404 | Service off, ID absent, expired artifact, or runtime missing | Check the project/service and resource lifecycle |
| 409 | Busy workspace, not ready, or key reused with different input | Inspect state; wait for active work, or fix the key/input mismatch |
| 429 | Too many concurrent admission requests | Briefly back off; avoid a retry storm |
| 503 | Worker missing or unreachable | Run/check host setup and worker logs |

`sandbox:read` permits inspecting states, execution results, workspace downloads, retained artifacts,
and usage. `sandbox:write` includes read plus creation, execution, uploads, export, cancellation,
termination, browser credentials, and CDP upgrade. Every browser upgrade also checks normal API auth.

## Agent notes

Use unique stable creation/execution keys for retries. Never blindly rerun uncertain commands.
Check diagnostics and exit states. Export within lifetime; downloads afterward use artifact IDs.
See platform `sandboxes` documentation for isolation, deployment, limits, and recovery.

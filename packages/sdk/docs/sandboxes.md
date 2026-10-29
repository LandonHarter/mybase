---
title: Agent sandbox client
summary: Create isolated browser workspaces, run JavaScript, and export private artifacts.
section: Sandboxes
order: 1
---

# Agent sandbox client

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
  const result = await sandboxes.waitExecution(box.id, run.id);
  if (result.state !== "success") throw new Error(result.stderr || result.state);
  const artifact = await sandboxes.exportArtifact(box.id, "page.png", "image/png");
  const response = await sandboxes.artifact(box.id, artifact.id); // streamed binary Response
} finally { await sandboxes.terminate(box.id); }
```

An external app with Playwright can connect to the same guest Chromium using standard CDP:

```ts
import { chromium } from "playwright";
const connection = await sandboxes.browser(box.id);
const browser = await chromium.connectOverCDP(connection.endpoint, { headers: connection.headers });
// Header includes normal API authentication plus single-use sandbox-scoped browser credential.
// Acquire within 30s, connection lifetime <= 60s, exclusive with execution/files.
const page = await browser.contexts()[0].newPage();
await page.goto("https://example.com");
await page.getByRole("button", { name: "Show more" }).click();
page.on("response", async response => { /* response.json(), response.body() */ });
await browser.close();
```

`upload(id,path,Uint8Array)`, `download(id,path)`, `executions(id)`, `execution(id,run)`,
`cancel(id,run)`, `artifacts(id)`, `artifact(id,artifact)`, `get(id)`, `list()`, `usage()`,
and `terminate(id)` cover lifecycle, logs, workspace files and retained artifacts.
All operations accept an optional final `AbortSignal`. Abort cancels the client request/poll,
**not admitted work**; call `cancel`/`terminate` explicitly. API failures throw `MybaseApiError`
with HTTP `status` (409 busy/input-key conflict, 429 quota/capacity, 503 worker unavailable).
Never log browser headers or pass them into guest code. SDK has zero Playwright/LLM dependencies;
install Playwright in the calling app only when using external CDP.

## Agent notes

Use unique stable creation/execution keys for retries. Never blindly rerun uncertain commands.
Check diagnostics and exit states. Export within lifetime; downloads afterward use artifact IDs.
See platform `sandboxes` documentation for isolation, deployment, limits, and recovery.

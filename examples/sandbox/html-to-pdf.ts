// Render HTML to a PDF (invoices, reports) with the sandbox's Chromium, then save the file.
// Run: MYBASE_API_URL=... MYBASE_API_KEY=... bun examples/sandbox/html-to-pdf.ts <project> <page.html> <out.pdf>
import { createSandboxClient } from "@mybase-dev/sdk/sandbox";

const [project, input, output] = process.argv.slice(2);
if (!project || !input || !output || !process.env.MYBASE_API_KEY) throw new Error("provide project, input .html, output .pdf, and MYBASE_API_KEY (sandbox:write)");
const client = createSandboxClient({ apiUrl: process.env.MYBASE_API_URL ?? "http://localhost:4000", project, apiKey: process.env.MYBASE_API_KEY });

const box = await client.create({ key: crypto.randomUUID(), ttlSeconds: 120 });
try {
  const ready = await client.wait(box.id, AbortSignal.timeout(100_000));
  if (ready.state !== "ready") throw new Error(`sandbox provisioning failed: ${ready.reason}`);
  await client.upload(box.id, "page.html", new Uint8Array(await Bun.file(input).arrayBuffer()));
  const run = await client.execute(box.id, {
    key: "render",
    code: `import { chromium } from "playwright";
      import { readFile } from "node:fs/promises";
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
      const page = await browser.contexts()[0].newPage();
      await page.setContent(await readFile("page.html", "utf8"), { waitUntil: "networkidle" });
      await page.pdf({ path: "out.pdf", format: "A4", printBackground: true });
      await page.close(); await browser.close();`,
    timeoutMs: 30_000,
  });
  const result = await client.waitExecution(box.id, run.id, AbortSignal.timeout(60_000));
  if (result.state !== "success") throw new Error(result.stderr || result.state);
  await Bun.write(output, await client.download(box.id, "out.pdf"));
  console.log(`wrote ${output}`);
} finally {
  await client.terminate(box.id);
}

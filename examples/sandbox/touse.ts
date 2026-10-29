// Run: MYBASE_API_URL=... MYBASE_API_KEY=... bun examples/sandbox/touse.ts <project> [public-listing-url]
// Without URL, runs a deterministic JS-rendered fixture, with real Chromium network responses.
import { createSandboxClient } from "@mybase-dev/sdk/sandbox";
const [project,url] = process.argv.slice(2);
if (!project || !process.env.MYBASE_API_KEY) throw new Error("provide project and MYBASE_API_KEY (sandbox:write)");
const client = createSandboxClient({ apiUrl:process.env.MYBASE_API_URL ?? "http://localhost:4000",project,apiKey:process.env.MYBASE_API_KEY });
const box = await client.create({ key:crypto.randomUUID(),ttlSeconds:180 });
let output: unknown;
try {
  const ready = await client.wait(box.id,AbortSignal.timeout(100_000));
  if (ready.state !== "ready") throw new Error(`sandbox provisioning failed: ${ready.reason}`);
  const script = await Bun.file(new URL("listing.mjs",import.meta.url)).text();
  const code = `const listingUrl=${JSON.stringify(url ?? "https://sandbox-fixture.invalid/listing")}; const fixture=${!url};\n${script}`;
  const execution = await client.execute(box.id,{ key:"listing",code,timeoutMs:60_000 });
  const result = await client.waitExecution(box.id,execution.id,AbortSignal.timeout(70_000));
  if (result.state !== "success") throw new Error(JSON.stringify(result));
  await client.upload(box.id,"execution-log.json",new TextEncoder().encode(JSON.stringify(result)));
  const manifest = await (await client.download(box.id,"manifest.json")).json() as { files:{path:string;type:string}[];diagnostics:unknown[] };
  const artifacts = [];
  for (const entry of [...manifest.files,{ path:"manifest.json",type:"application/json" },{ path:"execution-log.json",type:"application/json" }]) artifacts.push(await client.exportArtifact(box.id,entry.path,entry.type));
  output = { sandboxId:box.id,diagnostics:manifest.diagnostics,artifacts };
} finally {
  const signal = AbortSignal.timeout(30_000);
  await client.terminate(box.id,signal);
  for (;;) {
    if (["terminated","expired","failed"].includes((await client.get(box.id,signal)).state)) break;
    await Bun.sleep(250);
  }
}
console.log(JSON.stringify(output,null,2));

// External model/tool loops can instead use ./agent-tools.ts; importing it has no side effects.

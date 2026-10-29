import type { SandboxClient } from "@mybase-dev/sdk/sandbox";

/** Map inputSchema to your model provider's tool format; execute tool calls with run(). */
export function agentTools(client: SandboxClient, id: string) {
  return [{
    name: "sandbox_javascript",
    description: "Run ESM JavaScript in persistent Node/Chromium workspace. Use playwright connectOverCDP('http://127.0.0.1:9222'); inspect DOM, click controls, observe responses, and save evidence files. Never include model keys.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, key: { type: "string" } },
      required: ["code", "key"],
      additionalProperties: false,
    },
    async run(input: { code: string; key: string }) {
      const execution = await client.execute(id, { ...input, timeoutMs: 30000 });
      return client.waitExecution(id, execution.id);
    },
  }, {
    name: "sandbox_export",
    description: "Export a relative workspace file to private project artifacts; returns checksum and artifact ID.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, type: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    run: (input: { path: string; type?: string }) => client.exportArtifact(id, input.path, input.type),
  }];
}

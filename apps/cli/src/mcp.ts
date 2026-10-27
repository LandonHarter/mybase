// `mybase mcp`: how to connect an agent to this instance's MCP server (`/mcp`).
import { API_URL } from "./api";
import { flagString, parseArgs } from "./cron";
import { print } from "./output";

export const mcpUsage = `  mcp [--key-env MYBASE_API_KEY] Print MCP setup for Claude Code, Cursor, VS Code, and others`;

/** The `.mcp.json` / Cursor entry: the key comes from an env var, never written into the file. */
export const mcpServerEntry = (keyEnv = "MYBASE_API_KEY", baseUrl = API_URL) => ({
  type: "http",
  url: `${baseUrl}/mcp`,
  headers: { Authorization: `Bearer \${${keyEnv}}` },
});

export async function mcp(args: string[]): Promise<boolean> {
  const { flags } = parseArgs(args);
  const keyEnv = flagString(flags, "key-env") ?? "MYBASE_API_KEY";
  const entry = mcpServerEntry(keyEnv);
  print({ url: entry.url, mcpServers: { mybase: entry } }, () => {
    console.log(`MCP server: ${entry.url} (Streamable HTTP, API key as Bearer token)\n`);
    console.log("1. Make a key for the agent, limited to what it should touch, and export it:");
    console.log(`   mybase token create agent --project <project> --perm database:read,queue:write,cron:write`);
    console.log(`   export ${keyEnv}=mb_…\n`);
    console.log("2. Claude Code:");
    console.log(`   claude mcp add --transport http mybase ${entry.url} --header "Authorization: Bearer $${keyEnv}"\n`);
    console.log("   Or commit this to .mcp.json (Claude Code, Cursor: .cursor/mcp.json, VS Code: .vscode/mcp.json as \"servers\"):");
    console.log(JSON.stringify({ mcpServers: { mybase: entry } }, null, 2).replace(/^/gm, "   "));
    console.log("\nOr let `mybase agent init --project <project>` write it, with AGENTS.md notes and a Claude skill.");
  });
  return true;
}

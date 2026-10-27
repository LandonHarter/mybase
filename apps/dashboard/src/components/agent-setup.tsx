import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { href } from "@/lib/router";

/** Where coding agents connect: the MCP server, the llms.txt docs index, and the CLI shortcut. */
export function AgentSetup() {
  const origin = window.location.origin;
  return (
    <section aria-labelledby="agents" className="mt-10">
      <h2 id="agents" className="mb-3 text-base font-semibold">
        AI agents
      </h2>
      <Row
        title="MCP server"
        hint={
          <>
            For Claude Code, Cursor, and other MCP clients. Authenticate with an API key as a Bearer token; agents see only the tools the key allows.{" "}
            <a className="underline underline-offset-4" href={href({ page: "docs", service: "mybase", slug: "agents", section: null })}>
              Setup guide
            </a>
          </>
        }
      >
        <div className="grid gap-4">
          <CopyField id="mcp-url" label="URL" value={`${origin}/mcp`} />
          <CopyField id="mcp-claude" label="Claude Code" value={`claude mcp add --transport http mybase ${origin}/mcp --header "Authorization: Bearer $MYBASE_API_KEY"`} />
        </div>
      </Row>
      <Row title="Docs for agents" hint="An index of every docs page, written for language models. Each page is also plain markdown at /docs/<page>.md.">
        <CopyField id="llms-txt" label="llms.txt" value={`${origin}/llms.txt`} />
      </Row>
      <Row title="App repos" hint="Writes AGENTS.md notes, a Claude skill, and .mcp.json into the repo, so agents know this project.">
        <CopyField id="agent-init" label="In the repo" value="mybase agent init --project <name>" />
      </Row>
    </section>
  );
}

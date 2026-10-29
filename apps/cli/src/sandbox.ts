import { api, apiToken } from "./api";
import { need, parseArgs } from "./cron";
import { confirm, print, usageError } from "./output";
import { enableService } from "./service-enable";

export const sandboxUsage = `  sandbox enable <project>       Enable isolated agent compute (requires sandbox worker)
  sandbox disable <project> [--yes]  Stop sandboxes and delete their artifacts
  sandbox create <project> --key <key> [--ttl 300] [--idle 120]
  sandbox list|get|usage <project> [<id>]
  sandbox terminate <project> <id> [--yes]
  sandbox exec <project> <id> --key <key> [--code file.js | --command '["node","script.js"]'] [--timeout 30000]
  sandbox runs|artifacts|browser <project> <id>
  sandbox run <project> <id> <execution>
  sandbox cancel <project> <id> <execution> [--yes]
  sandbox upload|download <project> <id> <workspace-path> <local-file>
  sandbox export <project> <id> <workspace-path> [--type image/png]
  sandbox artifact <project> <id> <artifact-id> <local-file>
  Creation/execution return promptly. Poll get/run. Cancelling execution terminates sandbox.
  Browser credentials expire after 30s; authenticated CDP connection lasts at most 60s.`;

export async function sandbox(sub: string, args: string[]): Promise<boolean> {
  const known = ["enable","disable","create","list","get","usage","terminate","exec","runs","run","cancel","upload","download","export","artifacts","artifact","browser"];
  if (!known.includes(sub)) return false;
  const { positional,flags } = parseArgs(args);
  const [project,id,item,local] = positional;
  const p = need(project,"project name");
  const base = `/sandbox/${encodeURIComponent(p)}`;
  const root = () => `${base}/${encodeURIComponent(need(id,"sandbox id"))}`;
  const value = (key: string) => { const found = flags.get(key); return typeof found === "string" ? found : undefined; };
  const number = (key: string) => value(key) === undefined ? undefined : Number(value(key));
  let result: unknown;
  if (sub === "enable") { result = await enableService(p,"sandbox",flags); }
  else if (sub === "disable") {
    confirm(flags.has("yes"),`This stops every sandbox and permanently deletes sandbox artifacts for "${p}".`,p,"the project name");
    await api(`/projects/${encodeURIComponent(p)}/services/sandbox`,{ method:"DELETE" }); result = { disabled:"sandbox",project:p };
  } else if (sub === "create") result = await api(base,{ method:"POST",body:JSON.stringify({ key:need(value("key"),"--key"),ttlSeconds:number("ttl"),idleSeconds:number("idle"),profile:"browser" }) });
  else if (sub === "list" || sub === "usage") result = await api(sub === "list" ? base : `${base}/usage`);
  else if (sub === "get") result = await api(root());
  else if (sub === "terminate") {
    confirm(flags.has("yes"),`This stops sandbox "${need(id,"sandbox id")}" and deletes its temporary workspace.`,id!,"the sandbox id");
    result = await api(root(),{ method:"DELETE" });
  } else if (sub === "exec") {
    const codePath = value("code"); const command = value("command");
    if (!!codePath === !!command) usageError("provide exactly one of --code file.js or --command '[\"node\",\"script.js\"]'");
    let argv: unknown;
    if (command) { try { argv = JSON.parse(command); } catch { usageError("--command must be a JSON argument array"); } }
    result = await api(`${root()}/executions`,{ method:"POST",body:JSON.stringify({ key:need(value("key"),"--key"),code:codePath ? await Bun.file(codePath).text() : undefined,command:argv,timeoutMs:number("timeout") }) });
  } else if (sub === "runs") result = await api(`${root()}/executions`);
  else if (sub === "run" || sub === "cancel") {
    if (sub === "cancel") confirm(flags.has("yes"),`Cancelling stops the entire sandbox "${need(id,"sandbox id")}" and deletes its temporary workspace.`,id!,"the sandbox id");
    result = await api(`${root()}/executions/${encodeURIComponent(need(item,"execution id"))}`,{ method:sub === "run" ? "GET" : "DELETE" });
  }
  else if (sub === "upload") {
    const bytes = await Bun.file(need(local,"local file")).arrayBuffer();
    await api(`${root()}/files?path=${encodeURIComponent(need(item,"workspace path"))}`,{ method:"PUT",body:bytes,headers:{ "Content-Type":"application/octet-stream" } }); result = { uploaded:item,bytes:bytes.byteLength };
  } else if (sub === "download" || sub === "artifact") {
    const path = sub === "download" ? `${root()}/files?path=${encodeURIComponent(need(item,"workspace path"))}` : `${root()}/artifacts/${encodeURIComponent(need(item,"artifact id"))}`;
    const response = await api<Response>(path,{ raw:true });
    const size = await Bun.write(need(local,"local file"),response);
    result = { file:local,bytes:size };
  } else if (sub === "export") result = await api(`${root()}/artifacts`,{ method:"POST",body:JSON.stringify({ path:need(item,"workspace path"),type:value("type") }) });
  else if (sub === "artifacts") result = await api(`${root()}/artifacts`);
  else if (sub === "browser") {
    const connection = await api<import("@mybase-dev/sdk/sandbox").SandboxBrowserConnection>(`${root()}/browser`,{ method:"POST",body:"{}" });
    connection.headers.Authorization = `Bearer ${apiToken()}`;
    result = connection;
  }
  print(result,() => console.log(JSON.stringify(result,null,2)));
  return true;
}

// `mybase search …`: web search apps use through @mybase-dev/sdk/search.
import { api, API_URL } from "./api";
import { need, parseArgs } from "./cron";
import { confirm, print } from "./output";
import { enableService, printLinked } from "./service-enable";

export const searchUsage = `  search enable <project>        Turn on web search (SearXNG) for apps and agents
  search disable <project> [--yes]  Turn it off, clearing cached searches and pages`;

const servicePath = (project: string) => `/projects/${encodeURIComponent(project)}/services/search`;

/** Handles `mybase search <sub> …`. False when `sub` isn't a search command. */
export async function search(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "search", flags);
      const searchUrl = `${API_URL}/search/${p}`;
      print({ enabled: "search", project: p, linked, searchUrl, fetchUrl: `${searchUrl}/fetch` }, () => {
        console.log(`Web search enabled for "${p}"\n`);
        console.log(`  search URL  ${searchUrl}?q=…`);
        console.log(`  fetch URL   ${searchUrl}/fetch?url=…\n`);
        console.log("In your app (@mybase-dev/sdk), with an API key that has search:read for this project:");
        console.log(`  mybase token create ${p}-agent --project ${p} --perm search:read\n`);
        console.log(`  const web = createSearchClient({ apiUrl: "${API_URL}", project: "${p}", apiKey: process.env.MYBASE_API_KEY! })`);
        console.log(`  const { results } = await web.search("…")   // or searchTools(web) for an LLM agent`);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This turns off web search for "${p}" and clears its cached searches and pages.`, p, "the project name");
      await api(servicePath(p), { method: "DELETE" });
      print({ disabled: "search", project: p }, () => console.log(`Web search disabled for "${p}"`));
      return true;
    }
    default:
      return false;
  }
}

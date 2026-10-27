# Web search

Give your app's AI agent web search and page reading, without paying a search API. mybase asks its own SearXNG (several search engines at once) and turns pages into markdown.

Turn web search on from the project's page or with `mybase search enable <project>`. Your server authenticates with a mybase API key that has `search:read` for the project: `mybase token create shop-agent --project shop --perm search:read`. Keep it server-side, as `MYBASE_API_KEY`.

## Search and read

```ts
import { createSearchClient } from "@mybase-dev/sdk/search";

const web = createSearchClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!,
});

const { results } = await web.search("bun sql postgres", { limit: 5 });
// [{ title, url, snippet, engines: ["bing", "mojeek"], publishedAt: null }, …]

const page = await web.fetch(results[0]!.url, { maxChars: 10_000 });
// { url, title, markdown, truncated, contentType, cached }
```

`search(query, options)` takes `limit` (1–20, default 10), `category` (`general`, `news`, `it` for GitHub and Stack Overflow), `timeRange` (`day`, `week`, `month`, `year`), `language` (`en`, `en-US`), and `page` (1–10).

`fetch(url, options)` reads a public web page and returns its main content as markdown, cut at `maxChars` (default 20000). Text and JSON come back as they are. Pages on private or local addresses are refused.

Both throw `MybaseApiError` (with `status`) when mybase answers with an error: 400 for bad input or a blocked URL, 404 when the service is off, 415 for a page that isn't HTML, text, or JSON, 429 past the per-project limits, 502 when the page or every search engine failed, 503 when SearXNG is down.

## Tools for an agent

`searchTools(client)` returns `web_search` and `web_fetch` with a JSON Schema and a `run` function, for any LLM tool-use loop. `run` returns text ready for the tool result. Problems the model can work around (a blocked page, no results, rate limits) come back as text starting with `Error:` instead of throwing.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createSearchClient, searchTools } from "@mybase-dev/sdk/search";

const tools = searchTools(createSearchClient({ apiUrl, project: "shop", apiKey: process.env.MYBASE_API_KEY! }), {
  maxChars: 15_000,
});
const anthropic = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What's new in the latest Bun release?" }];

while (true) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 4096,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    messages,
  });
  messages.push({ role: "assistant", content: response.content });
  if (response.stop_reason !== "tool_use") break;
  const results = await Promise.all(
    response.content
      .filter((block) => block.type === "tool_use")
      .map(async (block) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: await tools.find((t) => t.name === block.name)!.run(block.input),
      })),
  );
  messages.push({ role: "user", content: results });
}
```

For OpenAI-style APIs, map each tool to `{ type: "function", function: { name, description, parameters: inputSchema } }`.

## Good to know

- Searches are cached for 1 hour and pages for 1 day, so repeating a call is cheap (`cached: true`).
- Limits: 60 searches and 120 page reads a minute per project.
- Searches go out from the mybase server's IP. If engines rate-limit it, results get thinner for a while; if all of them fail, `search` throws a 502 saying which ones and why.
- No JavaScript is run on fetched pages. Pages that render in the browser come back mostly empty.

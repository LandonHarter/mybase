---
title: Web search
summary: Web search and page reading for your app's AI agents, through a self-hosted SearXNG. No search API to pay for.
section: Services
order: 17
---

# Web search

Your app (usually an LLM agent) searches the web and reads pages as markdown through mybase. Searches go to mybase's own [SearXNG](https://docs.searxng.org/), a metasearch engine that asks Bing, Mojeek, Yahoo, DuckDuckGo, and Brave at once (GitHub and Stack Overflow for `it`, news engines for `news`). There's no API key or bill.

```sh
mybase search enable shop
mybase token create shop-agent --project shop --perm search:read
```

In apps: `createSearchClient` from `@mybase-dev/sdk/search` with an API key that has `search:read`, then `await web.search("…")` and `await web.fetch(url)`. `searchTools(web)` gives `web_search` and `web_fetch` as tool definitions for an agent. Guide: [SDK web search](sdk/search.md).

## HTTP

Both are `GET` with `Authorization: Bearer <key>`:

- `{{MYBASE_URL}}/search/<project>?q=…`: optional `limit` (1–20, default 10), `category` (`general`, `news`, `it`), `timeRange` (`day`, `week`, `month`, `year`), `language` (`en`, `en-US`), `page` (1–10). Answers `{ query, results: [{ title, url, snippet, engines, publishedAt }], cached }`.
- `{{MYBASE_URL}}/search/<project>/fetch?url=…`: optional `maxChars` (500–100000, default 20000). Answers `{ url, title, markdown, truncated, contentType, cached }`. HTML is cut down to the main content (Readability); text and JSON come back as they are.

## Limits

- 60 searches and 120 page reads a minute per project (429 past that). Cached answers don't count.
- Searches are cached for 1 hour, pages for 1 day (pages over 50,000 characters aren't cached), in the shared Valkey. Without Valkey, everything still works, uncached.
- Page reads: 10 s, 2 MB, at most 5 redirects. Only HTML, text, and JSON (415 otherwise).
- Only public internet addresses can be read. Hosts that resolve to loopback, private (LAN, Docker), link-local (cloud metadata), or Tailscale addresses are refused with 400, including after a redirect.

## Agent notes

- All searches leave from the mybase server's IP. Engines that rate-limit or CAPTCHA it are suspended by SearXNG for a while, and the rest keep answering. If every engine fails, the search answers 502 with the reasons; retry in a few minutes.
- Result quality depends on which engines answer from that IP. Results found by several engines (`engines`) are usually more relevant.
- No JavaScript is run: pages that render their content in the browser come back mostly empty.
- Queries and URLs are never logged.

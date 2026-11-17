---
title: AI gateway
summary: One OpenAI-compatible endpoint for every LLM provider. Provider keys stay in mybase; every call is logged, priced, and charted, with aliases, fallbacks, budgets, and caching.
section: Services
order: 26
---

# AI gateway

The AI gateway sits between your app and LLM providers. Your app talks to one endpoint with a mybase API key; mybase holds the provider keys, picks the provider, logs the call, and prices it.

- **One API for every provider.** `POST {{MYBASE_URL}}/ai/<project>/v1/chat/completions` speaks the OpenAI format, so the OpenAI SDK, the AI SDK (`createOpenAICompatible`), LangChain, and curl all work by changing `baseURL`. Anthropic and Bedrock are translated (tools, images, streaming, JSON schema output, thinking).
- **Native SDKs too.** `{{MYBASE_URL}}/ai/<project>/native/<provider>` passes a provider's own API through (Anthropic's Messages API, Gemini's `generateContent`, OpenAI's Responses API), so official SDKs work by changing their base URL. The same logging and pricing apply.
- **Keys stay in mybase.** Provider keys live in the project's [secrets](secrets.md) env `ai`. Apps only hold `MYBASE_API_KEY` (with `ai:write`) and `MYBASE_AI_URL`.
- **Every call logged and priced.** Model, tokens (cached and reasoning too), latency, cost, tags, end-user id, and the API key that called. Prices come from a bundled [models.dev](https://models.dev) catalog, refreshed daily, or what the provider reports, or your overrides.

Turn it on from the project's page or with `mybase ai enable <project>` (it turns on secrets first).

## Providers and keys

| id | Provider | Keys (in the `ai` env) |
|----|----------|------------------------|
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`) |
| `vercel` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `azure` | Azure OpenAI | `AZURE_API_KEY`, `AZURE_RESOURCE_NAME` |
| `bedrock` | Amazon Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| `groq`, `mistral`, `xai`, `deepseek`, `together`, `fireworks`, `cerebras`, `perplexity`, `cohere` | | `<ID>_API_KEY` |

```sh
mybase ai key set shop openai          # prompts for the key; stored as a secrets revision
mybase ai providers shop               # which providers have their keys
mybase ai provider test shop openai    # a cheap call to check the key
```

Key names match the AI SDK's env vars. **Custom providers** (Ollama, LM Studio, vLLM, LiteLLM: anything OpenAI-compatible) are added by an admin, since mybase calls their URL with your prompts. LAN addresses work:

```sh
mybase ai provider add shop ollama --url http://ollama.lan:11434/v1
# then: model "ollama/llama3.2"
```

## Models and aliases

A model id is `<provider>/<model>`: `openai/gpt-5`, `anthropic/claude-sonnet-4-5`, `vercel/anthropic/claude-haiku-4.5` (Vercel gets `anthropic/claude-haiku-4.5`). Or an **alias**, a list of models tried in order:

```sh
mybase ai alias set shop fast groq/llama-3.3-70b-versatile openai/gpt-5-mini
```

If a model fails before anything was sent to your app (network error, 408, 429, 5xx, or no key for that provider), the next one is tried. The answer carries `X-Mybase-Model` (who answered) and `X-Mybase-Fallback-From`. Aliases and price overrides can live in `mybase.config.ts`:

```ts
export default defineConfig({
  project: "shop",
  ai: {
    aliases: { fast: ["groq/llama-3.3-70b-versatile", "openai/gpt-5-mini"], smart: "anthropic/claude-sonnet-4-5" },
    prices: { "ollama/*": { input: 0, output: 0 } },
  },
});
```

`mybase ai sync` applies them; code-defined ones are read-only on the dashboard. `GET /ai/<project>/v1/models` lists aliases plus every model of the providers whose keys are set.

## Calling it

```ts
import OpenAI from "openai";
const openai = new OpenAI({ baseURL: process.env.MYBASE_AI_URL, apiKey: process.env.MYBASE_API_KEY });
const res = await openai.chat.completions.create({ model: "fast", messages: [{ role: "user", content: "Hi" }] });
```

```sh
curl {{MYBASE_URL}}/ai/shop/v1/chat/completions -H "Authorization: Bearer $MYBASE_API_KEY" \
  -H 'Content-Type: application/json' -d '{"model":"openai/gpt-5-mini","stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

| Route | What |
|-------|------|
| `POST /ai/<p>/v1/chat/completions` | Chat, streamed (`stream: true`) or not, for every provider |
| `POST /ai/<p>/v1/embeddings` | OpenAI-format providers and Bedrock (Titan, Cohere) |
| `POST /ai/<p>/v1/images/generations` | OpenAI, Gemini, xAI, Together, Vercel, Azure |
| `POST /ai/<p>/v1/responses` | OpenAI's Responses API (OpenAI, Azure, Vercel, OpenRouter, xAI) |
| `GET /ai/<p>/v1/models` | Aliases + configured providers' models |
| `GET/POST /ai/<p>/native/<provider>/…` | The provider's own API (allowlisted paths) |

Anthropic's SDK sends the key as `x-api-key` and Google's as `x-goog-api-key`; the gateway accepts a mybase key there too, only under `/ai/`.

### Extras per request

Send `mybase: { … }` in the body, or headers:

| Body | Header | What |
|------|--------|------|
| `tags: ["checkout"]` | `X-Mybase-Tags: checkout,beta` | Labels for logs and usage (up to 10) |
| `user: "u_42"` | `X-Mybase-User` | Your end user (OpenAI's `user` field works too) |
| `cache: 3600` | `X-Mybase-Cache: 3600` | Cache the answer for this many seconds (non-streamed chat and embeddings, identical requests, answers up to 256 KB). Hits are logged as `cached` and cost nothing |
| `store: "public/gen/"` | | Images: save each one to the project's bucket under that prefix; the answer gains `data[i].mybase.key` (+ `publicUrl` under `public/`) |
| `anthropic: {…}` | | Fields passed to Anthropic as they are (e.g. `service_tier`) |

## Logs, usage, and prices

The dashboard's AI page shows cost, calls, tokens, and latency over time, by model, provider, tag, or key; a filterable log; a playground; providers; models with prices; and settings. From the CLI: `mybase ai logs shop --status error --since 1h`, `mybase ai usage shop --range 30d --by key`.

Cost comes from, in order: what the provider reported (OpenRouter, Vercel embeddings), your override (`mybase ai prices set shop "openai/gpt-5*" --input 1.25 --output 10`, USD per 1M tokens), the catalog (gateway models like `vercel/x/y` fall back to `x`'s own price), or nothing: the call is **unpriced**, which the [security advisor](security.md) points out. Cached input tokens are charged at the cached rate.

Logs are kept `logRetentionDays` (default 30); hourly rollups for 400 days. **Content capture** (off by default) also stores each prompt and response, encrypted with `MYBASE_SECRETS_KEY`, for `contentRetentionDays` (default 7), readable in the log's detail view.

## Budgets and limits

```sh
mybase ai settings shop --budget 50 --soft 80 --hard on
```

At the soft percentage an `ai.budget_threshold` audit event fires once a month ([alerts](security.md) can notify you). With `--hard on`, calls get **429 budget exhausted** until the month (UTC) ends. `--allow "openai/*,fast"` limits which models apps may call. `--ratelimit <rule>` checks a [rate limit](rate-limits.md) rule before each call, per API key or per end user (`--ratelimit-by user`), answering 429 with `Retry-After`.

## Other services use it

- **Vector search** can embed through the gateway (`mybase vector embedding shop --ai openai/text-embedding-3-small`): no separate key, and embedding costs show up here under the tag `vector`. See [vector search](vector.md).
- **Memory** runs its fact extraction and embeddings through it (tag `memory`). See [memory](memory.md).

## Security

- Apps never see provider keys: give them a project-limited key with only `ai:write` (`mybase token create shop-ai --project shop --perm ai:write`). Rotate it like any API key; the provider keys stay put.
- Writing provider keys needs `secrets:write`; changing settings and custom providers needs admin (the server calls those URLs with your prompts).
- Content capture stores end-user prompts. Turn it on to debug, then off. Anyone with `ai:read` can read captured content.
- Set a budget, so a leaked app key can't run up the provider bill unnoticed.

More: [Security best practices](security-best-practices.md#ai-gateway).

## Agent notes

- MCP tools: `list_ai_models`, `get_ai_usage`, `list_ai_logs` (metadata only, never prompts). There are no inference or destructive tools.
- Model ids always carry the provider: `openai/gpt-5`, not `gpt-5`. A bare name is looked up as an alias (400 when there's none).
- 409 `provider "x" has no X_API_KEY in secrets env "ai"` means the user must run `mybase ai key set <project> x`. Never ask for provider keys in chat.
- Errors on `/ai/…` routes are OpenAI-shaped: `{ error: { message, type, code } }`. Upstream errors keep the provider's status and message.
- Streams always ask the provider for usage, so streamed calls are priced too; the usage chunk only reaches the app when it set `stream_options.include_usage`.
- `MYBASE_AI_BASE_<ID>` (env, admin) replaces a built-in provider's base URL, e.g. for a corporate proxy.

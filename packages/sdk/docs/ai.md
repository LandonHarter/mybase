# AI gateway

Call any LLM provider through your project's mybase AI gateway: one OpenAI-compatible endpoint, provider keys kept in mybase (secrets env `ai`), every call logged and priced. Your app holds only a mybase API key with `ai:write` (`mybase token create shop-ai --project shop --perm ai:write`), as `MYBASE_API_KEY`. `MYBASE_AI_URL` is `<api>/ai/<project>/v1` (`mybase secrets link` adds it to linked envs).

Model ids are `<provider>/<model>` (`openai/gpt-5-mini`, `anthropic/claude-sonnet-4-5`, `google/gemini-2.5-flash`, `vercel/anthropic/claude-haiku-4.5`, `ollama/llama3.2` for a custom provider) or a project alias (`fast`), which can fall back to other models.

## OpenAI SDK

```ts
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: process.env.MYBASE_AI_URL, apiKey: process.env.MYBASE_API_KEY });
const res = await openai.chat.completions.create({
  model: "anthropic/claude-sonnet-4-5",   // translated: tools, images, streaming, json_schema all work
  messages: [{ role: "user", content: "Write a haiku about Postgres" }],
});
```

## AI SDK

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";

const mybase = createOpenAICompatible({ name: "mybase", baseURL: process.env.MYBASE_AI_URL!, apiKey: process.env.MYBASE_API_KEY, includeUsage: true });
const { text } = await generateText({ model: mybase("fast"), prompt: "Hello" });
```

Or the AI SDK's own Anthropic provider, against the native passthrough:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
const anthropic = createAnthropic({ baseURL: `${process.env.MYBASE_URL}/ai/shop/native/anthropic/v1`, apiKey: process.env.MYBASE_API_KEY });
```

## Native SDKs

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAI } from "@mybase-dev/sdk/ai";

const ai = createAI({ apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const anthropic = new Anthropic({ baseURL: ai.nativeBaseURL("anthropic"), apiKey: process.env.MYBASE_API_KEY });
// Gemini: new GoogleGenAI({ apiKey: process.env.MYBASE_API_KEY, httpOptions: { baseUrl: ai.nativeBaseURL("google") } })
```

The Anthropic SDK sends the key as `x-api-key`, Google's as `x-goog-api-key`: the gateway accepts a mybase key there (only under `/ai/`) and swaps in the real provider key.

## Tags, users, caching

```ts
const openai = new OpenAI({ baseURL: ai.baseURL, apiKey: process.env.MYBASE_API_KEY, defaultHeaders: ai.headers({ tags: ["support-bot"] }) });
await openai.chat.completions.create({ model: "fast", messages, user: session.userId }); // end user, for logs and per-user rate limits
await openai.embeddings.create({ model: "openai/text-embedding-3-small", input: "…" }, { headers: { "X-Mybase-Cache": "86400" } });
```

Tags show up in the dashboard's usage charts and logs. `X-Mybase-Cache: <seconds>` caches non-streamed chat and embedding answers for identical requests (hits cost nothing).

## The zero-dependency client

`createAI` also calls the gateway directly, without an SDK:

```ts
const ai = createAI({ apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! });

const res = await ai.chat({ model: "fast", messages: [{ role: "user", content: "Hi" }], mybase: { tags: ["demo"] } });
for await (const chunk of ai.chatStream({ model: "openai/gpt-5-mini", messages })) process.stdout.write(chunk.choices[0]?.delta.content ?? "");
const { data } = await ai.embed("openai/text-embedding-3-small", ["one", "two"]);
const img = await ai.image({ model: "openai/gpt-image-1", prompt: "a dog", mybase: { store: "public/generated/" } });
console.log(img.data[0]?.mybase?.publicUrl); // saved to the project's bucket
const { data: models } = await ai.models();
```

Errors throw `MybaseApiError` with the HTTP status: 409 when the provider has no key in mybase (`mybase ai key set shop anthropic`), 429 for budgets and rate limits, the provider's own status for its errors.

# Memory

Long-term memory for your app's AI agents (mem0-style). Send conversations; mybase extracts the facts worth keeping, merges them with what it already knows about that user, and lets you search them later. Every model call goes through your project's AI gateway, so set its provider key first (`mybase ai key set shop openai`).

Turn it on with `mybase memory enable <project>`. Your server uses an API key with `memory:write` (`memory:read` to only search): `mybase token create shop-app --project shop --perm memory:write,ai:write`.

## Add and search

```ts
import { createMemoryClient } from "@mybase-dev/sdk/memory";

const memory = createMemoryClient({ apiUrl: process.env.MYBASE_URL!, project: "shop", apiKey: process.env.MYBASE_API_KEY! });

// After a turn of the conversation (it takes a few seconds: don't block the reply on it).
const { results } = await memory.add({ userId: session.userId, messages: [{ role: "user", content: "I'm vegetarian, and I moved to Porto" }] });
// [{ event: "ADD", memory: "Is vegetarian" }, { event: "UPDATE", memory: "Lives in Porto", previous: "Lives in Lisbon" }]

// Before answering:
const { results: found } = await memory.search("what can they eat?", { userId: session.userId, topK: 5 });
const context = found.map((m) => `- ${m.memory}`).join("\n");
```

`userId`, `agentId`, and `runId` scope memories; `add` needs at least one, `search` and `list` filter by the ones given. Set them on the server from the signed-in user. `infer: false` stores `text` as is (`memory.add({ agentId: "bot", text: "The deploy runs at 9", infer: false })`). `metadata` is stored with each memory and matched by `search({ filter })`.

## Tools for an agent

```ts
import { createMemoryClient, memoryTools } from "@mybase-dev/sdk/memory";

const tools = memoryTools(memory, { userId: session.userId }); // search_memory, add_memory
// Anthropic: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
// OpenAI:    tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
// For each tool call: await tools.find((t) => t.name === call.name)!.run(call.input)
```

## Everything else

```ts
await memory.list({ userId, limit: 50 });          // newest first, { memories, next }
await memory.get(id);
await memory.update(id, { memory: "Lives in Porto, Portugal" });
await memory.history(id);                            // ADD / UPDATE / DELETE events
await memory.delete(id);
await memory.deleteAll({ userId });                  // e.g. when the user deletes their account
```

From SQL, memories are in `mybase_memory.memories` (`id`, `user_id`, `agent_id`, `run_id`, `content`, `metadata`, `embedding`, timestamps), readable by the project's role.

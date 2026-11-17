---
title: Memory
summary: Long-term memory for AI agents, mem0-style. Facts are pulled out of conversations, reconciled with what's already known (add, update, delete), and searched per user.
section: Services
order: 27
---

# Memory

Memory gives your app's agents something to remember users by. Send a conversation; mybase asks a model which facts are worth keeping ("Is vegetarian", "Lives in Porto"), compares each with the closest memories already stored for that user, and adds, updates, or deletes memories so they stay current and free of duplicates. Later, search them by meaning and keywords before answering.

It runs on the [AI gateway](ai.md): every model and embedding call goes through it (tagged `memory`), so its cost shows in the AI usage. Memories live in your project's database, schema `mybase_memory`.

Turn it on from the project's page or with `mybase memory enable <project>` (it turns on the AI gateway first). Then set the provider key for the default models: `mybase ai key set <project> openai`.

## Scopes

Each memory belongs to a `userId`, an `agentId`, a `runId`, or a mix. Adding needs at least one; search and list filter by the ones you pass. Two users never see each other's memories unless you search without a scope.

## How `add` works

1. **Facts:** one call to the LLM (`llmModel`, default `openai/gpt-5-mini`) with JSON schema output extracts short, self-contained facts from the conversation.
2. **Neighbours:** each fact is embedded (`embedModel`, default `openai/text-embedding-3-small`) and the 5 closest memories in the same scope are collected.
3. **Decisions:** a second call decides, per fact, `ADD`, `UPDATE` (merge into an existing memory), `DELETE` (it contradicts one), or `NONE`. Existing memories are shown to the model with small integer ids, never UUIDs, so it can't garble them.
4. **Apply:** all changes in one transaction, each recorded in the memory's history.

`infer: false` skips all that and stores the text as it is (still deduplicated).

```sh
mybase memory add shop "I'm vegetarian and I just moved to Porto" --user u_42
mybase memory search shop "what can they eat" --user u_42
mybase memory history shop <id>
```

## Settings

| Setting | Default | |
|---------|---------|---|
| `llmModel` | `openai/gpt-5-mini` | Any gateway model id or alias |
| `embedModel`, `dimensions` | `openai/text-embedding-3-small`, 1536 | Changing the model re-embeds every memory; changing dimensions needs an empty store |
| `customPrompt` | none | Extra rules for extraction ("only keep food preferences") |
| `defaultTtlDays` | none | Forget memories after this long (per add: `ttlDays`) |

`mybase memory settings shop --llm fast --embed openai/text-embedding-3-small`.

## HTTP

With an API key (`memory:write`; `memory:read` is enough to search and list):

| Route | What |
|-------|------|
| `POST /memory/<p>/memories` | Add `{ messages \| text, userId?, agentId?, runId?, metadata?, infer?, ttlDays? }` |
| `POST /memory/<p>/search` | `{ query, userId?, agentId?, runId?, topK?, mode?: hybrid\|vector\|text, filter?, threshold? }` |
| `GET /memory/<p>/memories?userId=…` | List, newest first (`limit`, `after`) |
| `GET / PATCH / DELETE /memory/<p>/memories/<id>` | One memory (`PATCH { memory?, metadata? }`) |
| `GET /memory/<p>/memories/<id>/history` | Its ADD / UPDATE / DELETE events |
| `POST /memory/<p>/memories/delete` | Every memory in a scope (one id required) |

The SDK wraps these, plus `memoryTools()` for an agent's tool loop: see the SDK's memory page.

## Security

- Memories are end-user data about your users. The project's database role can read them (`select` on `mybase_memory`), and so can any key with `memory:read` for the project.
- Always set the scope on the server from the signed-in user, never from the browser.
- Delete a user's memories when they delete their account: `POST /memory/<p>/memories/delete { userId }`.
- Memory text is never logged. With [content capture](ai.md#logs-usage-and-prices) on, the gateway stores the extraction prompts (which contain the conversation) for its retention period.

More: [Security best practices](security-best-practices.md#memory).

## Agent notes

- MCP tools: `search_memories`, `list_memories` (read only).
- `add` makes two LLM calls and a few embedding calls: give it time (the SDK waits up to 2 minutes) and call it after replying to the user, not before.
- An `add` that returns `results: []` means nothing new was worth remembering; that's normal.
- Search scores: vector mode is cosine similarity (0–1); hybrid scores are small (≈ 1/60) and only compare within one list.
- Don't create `mybase_memory` yourself: enabling refuses a schema mybase didn't make.

import { describe, expect, test } from "bun:test";
import { anthropicStream, fromAnthropic, toAnthropic, JSON_TOOL } from "./ai-adapters/anthropic";
import { converseStream, fromConverse } from "./ai-adapters/bedrock";
import { crc32, encodeEvent, EventStreamDecoder } from "./ai-adapters/eventstream";
import { mapMessages } from "./ai-adapters/messages";
import { openaiChatStream, openaiRequest, openaiUsage } from "./ai-adapters/openai";
import { SseParser, sse } from "./ai-adapters/sse";
import { newUsage, type StreamHooks } from "./ai-adapters/types";
import type { ProjectConfig } from "./ai";
import { readExtension, resolveModel } from "./ai-gateway";
import { catalogModel, globMatch, overrideFor, priceCost, resolveCost, setCatalog, type Catalog } from "./ai-prices";
import { AI_PROVIDERS, authHeaders, baseUrlFor, customProvider, missingKeys } from "./ai-providers";
import { bearerToken } from "./auth-http";
import { requirement } from "./permissions";

const stream = (chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === "string" ? new TextEncoder().encode(x) : x);
      c.close();
    },
  });

const hooks = (): StreamHooks & { error: unknown; ended: boolean } => {
  const h = { error: undefined as unknown, ended: false, first: () => {}, done: (e: unknown) => ((h.error = e), (h.ended = true)) };
  return h;
};

const events = (text: string) =>
  new SseParser()
    .feed(text)
    .filter((e) => e.data !== "[DONE]")
    .map((e) => JSON.parse(e.data));

describe("sse", () => {
  test("parses events split across chunks, multi-line data, comments, CRLF", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a"')).toEqual([]);
    expect(p.feed(":1}\r\n\r\n: keep-alive\n\nevent: x\ndata: one\ndata: two\n\n")).toEqual([
      { event: null, data: '{"a":1}' },
      { event: "x", data: "one\ntwo" },
    ]);
    expect(p.feed("data: tail")).toEqual([]);
    expect(p.end()).toEqual([{ event: null, data: "tail" }]);
  });
  test("serializes", () => {
    expect(sse("a\nb", "e")).toBe("event: e\ndata: a\ndata: b\n\n");
  });
});

describe("openai adapter", () => {
  test("rewrites model, asks for usage on streams, openrouter cost", () => {
    const up = openaiRequest(AI_PROVIDERS.openrouter!, { OPENROUTER_API_KEY: "k" }, "/chat/completions", { model: "openrouter/x", stream: true, messages: [] }, "x/y");
    const body = JSON.parse(up.init.body as string);
    expect(body.model).toBe("x/y");
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.usage).toEqual({ include: true });
    expect(up.init.headers.Authorization).toBe("Bearer k");
    expect(up.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
  test("usage: cached + reasoning, provider cost, vercel gateway cost", () => {
    const u = openaiUsage(
      { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.01 } },
      newUsage(),
    );
    expect(u).toMatchObject({ input: 100, output: 20, cacheRead: 40, reasoning: 5, providerCost: 0.01 });
    expect(openaiUsage({ usage: { prompt_tokens: 3 }, providerMetadata: { gateway: { cost: "0.0002" } } }, newUsage()).providerCost).toBe(0.0002);
  });
  test("stream drops the usage-only chunk unless asked, and still reads usage", async () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    for (const want of [false, true]) {
      const usage = newUsage();
      const h = hooks();
      const text = await new Response(openaiChatStream(stream(body), usage, want, h)).text();
      expect(usage.input).toBe(7);
      expect(text.includes('"usage"')).toBe(want);
      expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
      expect(h.ended).toBe(true);
      expect(h.error).toBeNull();
    }
  });
});

describe("message mapping", () => {
  test("system, merged turns, images, tool calls and results", () => {
    const m = mapMessages([
      { role: "system", content: "be brief" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "user", content: "and this" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ]);
    expect(m.system).toEqual([{ text: "be brief" }]);
    expect(m.turns).toHaveLength(3);
    expect(m.turns[0]!.blocks).toEqual([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: "AAAA", url: null },
      { type: "text", text: "and this" },
    ]);
    expect(m.turns[1]!.blocks).toEqual([{ type: "tool_use", id: "c1", name: "f", input: { x: 1 } }]);
    expect(m.turns[2]).toEqual({ role: "user", blocks: [{ type: "tool_result", id: "c1", content: "42" }] });
  });
});

describe("anthropic adapter", () => {
  test("request: tools, tool_choice, max_tokens default, json_schema forced tool, thinking", () => {
    const { body, jsonTool } = toAnthropic(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        tool_choice: "required",
        stop: "END",
        temperature: 1.5,
      },
      "claude-x",
      8192,
    );
    expect(jsonTool).toBe(false);
    expect(body).toMatchObject({ model: "claude-x", max_tokens: 8192, tool_choice: { type: "any" }, stop_sequences: ["END"], temperature: 1 });
    expect(body.tools).toEqual([{ name: "f", input_schema: { type: "object" } }]);

    const json = toAnthropic(
      { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } } },
      "m",
      100,
    );
    expect(json.jsonTool).toBe(true);
    expect(json.body.tool_choice).toEqual({ type: "tool", name: JSON_TOOL });

    const think = toAnthropic({ messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium", max_tokens: 1000, temperature: 0.2 }, "m", 4096);
    expect(think.body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(think.body.max_tokens as number).toBeGreaterThan(4096);
    expect(think.body.temperature).toBeUndefined();
  });
  test("response: text, tool calls, usage with cache", () => {
    const usage = newUsage();
    const out = fromAnthropic(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 4 },
      },
      "anthropic/m",
      false,
      usage,
    ) as {
      choices: { message: { content: string; tool_calls: unknown[] }; finish_reason: string }[];
      usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } };
    };
    expect(out.choices[0]!.message.content).toBe("ok");
    expect(out.choices[0]!.message.tool_calls).toEqual([{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    expect(out.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out.usage.prompt_tokens).toBe(45);
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(30);
    expect(usage).toMatchObject({ input: 45, cacheRead: 30, cacheWrite: 5, output: 4 });
  });
  test("json tool answer becomes content", () => {
    const out = fromAnthropic({ content: [{ type: "tool_use", id: "t", name: JSON_TOOL, input: { facts: [] } }], stop_reason: "tool_use" }, "m", true, newUsage()) as {
      choices: { message: { content: string }; finish_reason: string }[];
    };
    expect(out.choices[0]!.message.content).toBe('{"facts":[]}');
    expect(out.choices[0]!.finish_reason).toBe("stop");
  });
  test("stream: text, tool call args, finish, usage chunk", async () => {
    const ev = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`;
    const body = [
      ev({ type: "message_start", message: { id: "m1", usage: { input_tokens: 12, output_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu", name: "f" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }),
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
      ev({ type: "message_stop" }),
    ];
    const usage = newUsage();
    const text = await new Response(anthropicStream(stream(body), "anthropic/m", false, usage, true, hooks())).text();
    const chunks = events(text);
    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(content).toBe("Hello");
    const args = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
      .map((t: { function: { arguments: string } }) => t.function.arguments)
      .join("");
    expect(args).toBe('{"a":1}');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 9 });
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

describe("bedrock", () => {
  test("event stream decoder: split frames, checksums", () => {
    const enc = new TextEncoder();
    const a = encodeEvent({ ":event-type": "contentBlockDelta", ":message-type": "event" }, enc.encode('{"delta":{"text":"hi"},"contentBlockIndex":0}'));
    const b = encodeEvent({ ":event-type": "metadata", ":message-type": "event" }, enc.encode('{"usage":{"inputTokens":3,"outputTokens":1}}'));
    const all = new Uint8Array([...a, ...b]);
    const d = new EventStreamDecoder();
    const first = d.feed(all.slice(0, 20));
    const rest = d.feed(all.slice(20));
    expect(first).toEqual([]);
    expect(rest.map((m) => m.headers[":event-type"])).toEqual(["contentBlockDelta", "metadata"]);
    const bad = a.slice();
    bad[bad.length - 6] ^= 0xff;
    expect(() => new EventStreamDecoder().feed(bad)).toThrow(/checksum/);
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
  test("converse stream → openai chunks", async () => {
    const enc = new TextEncoder();
    const e = (type: string, data: unknown) => encodeEvent({ ":event-type": type, ":message-type": "event" }, enc.encode(JSON.stringify(data)));
    const body = [
      e("messageStart", { role: "assistant" }),
      e("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
      e("messageStop", { stopReason: "end_turn" }),
      e("metadata", { usage: { inputTokens: 5, outputTokens: 2 } }),
    ];
    const usage = newUsage();
    const text = await new Response(converseStream(stream(body), "bedrock/m", false, usage, true, hooks())).text();
    const chunks = events(text);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Hi");
    expect(usage).toMatchObject({ input: 5, output: 2 });
    expect(chunks.at(-1).usage.total_tokens).toBe(7);
  });
  test("converse answer", () => {
    const out = fromConverse(
      {
        output: { message: { content: [{ text: "a" }, { toolUse: { toolUseId: "x", name: "f", input: {} } }] } },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      "m",
      false,
      newUsage(),
    ) as {
      choices: { message: { tool_calls: unknown[] }; finish_reason: string }[];
    };
    expect(out.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out.choices[0]!.message.tool_calls).toHaveLength(1);
  });
});

describe("providers", () => {
  test("azure base url and api-key header, fallbacks for gemini keys", () => {
    const azure = AI_PROVIDERS.azure!;
    const keys = { AZURE_API_KEY: "k", AZURE_RESOURCE_NAME: "res" };
    expect(baseUrlFor(azure, keys)).toBe("https://res.openai.azure.com/openai/v1");
    expect(authHeaders(azure, keys)).toEqual({ "api-key": "k" });
    expect(missingKeys(azure, { AZURE_API_KEY: "k" })).toEqual(["AZURE_RESOURCE_NAME"]);
    expect(missingKeys(AI_PROVIDERS.google!, { GEMINI_API_KEY: "g" })).toEqual([]);
    expect(authHeaders(AI_PROVIDERS.google!, { GEMINI_API_KEY: "g" }, true)).toEqual({ "x-goog-api-key": "g" });
    expect(authHeaders(AI_PROVIDERS.anthropic!, { ANTHROPIC_API_KEY: "a" })).toEqual({ "anthropic-version": "2023-06-01", "x-api-key": "a" });
  });
});

describe("prices", () => {
  const catalog: Catalog = {
    fetchedAt: "2026-01-01T00:00:00Z",
    providers: {
      openai: { "gpt-x": { name: "X", cost: { input: 2, output: 8, cache_read: 0.5 } }, "dall-e-3": { name: "D", type: "image" } },
      vercel: { "openai/gpt-x": { name: "X via vercel" } },
    },
  };
  setCatalog(catalog);
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 0, reasoning: 0, images: 0 };
  test("formula: cached tokens at the cache rate", () => {
    expect(priceCost({ input: 2, output: 8, cacheRead: 0.5 }, usage)).toBe(1.6 + 0.1 + 4);
    expect(priceCost({}, usage)).toBeNull();
    expect(priceCost({ perImage: 0.04 }, { ...usage, input: 0, output: 0, images: 2 })).toBe(0.08);
  });
  test("precedence: provider > override > catalog > null; vercel falls back to the model's own entry", () => {
    const openai = AI_PROVIDERS.openai!;
    expect(resolveCost(openai, "gpt-x", usage, 0.5, [])).toEqual({ cost: 0.5, source: "provider" });
    expect(resolveCost(openai, "gpt-x", usage, null, [{ model: "openai/gpt-*", input: 1, output: 1 }]).source).toBe("override");
    expect(resolveCost(openai, "gpt-x", usage, null, []).source).toBe("catalog");
    expect(resolveCost(openai, "nope", usage, null, [])).toEqual({ cost: null, source: null });
    expect(catalogModel(AI_PROVIDERS.vercel!, "openai/gpt-x")?.cost?.input).toBe(2);
    expect(resolveCost(openai, "dall-e-3", { ...usage, input: 0, output: 0, images: 1 }, null, [])).toEqual({ cost: 0.04, source: "catalog" });
  });
  test("overrides: exact beats glob, longer glob beats shorter", () => {
    const o = [
      { model: "openai/*", input: 1 },
      { model: "openai/gpt-*", input: 2 },
      { model: "openai/gpt-x", input: 3 },
    ];
    expect(overrideFor(o, "openai/gpt-x")?.input).toBe(3);
    expect(overrideFor(o, "openai/gpt-y")?.input).toBe(2);
    expect(overrideFor(o, "openai/o3")?.input).toBe(1);
    expect(globMatch("*.md", "a/b.md")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
  });
});

describe("model resolution", () => {
  const cfg = {
    aliases: new Map([["fast", { name: "fast", targets: ["anthropic/claude-haiku", "openai/gpt-mini"], source: "dashboard" as const }]]),
    custom: [customProvider({ id: "ollama", name: "Ollama", baseUrl: "http://ollama:11434/v1/", keyName: null })],
    allowedModels: null,
  } as unknown as ProjectConfig;
  test("provider/model, nested vercel ids, aliases with fallbacks, custom providers", () => {
    expect(resolveModel(cfg, "openai/gpt-5").targets.map((t) => [t.def.id, t.model])).toEqual([["openai", "gpt-5"]]);
    expect(resolveModel(cfg, "vercel/anthropic/claude-haiku-4.5").targets[0]!.model).toBe("anthropic/claude-haiku-4.5");
    const fast = resolveModel(cfg, "fast");
    expect(fast.alias).toBe("fast");
    expect(fast.targets.map((t) => t.id)).toEqual(["anthropic/claude-haiku", "openai/gpt-mini"]);
    expect(resolveModel(cfg, "ollama/llama3").targets[0]!.def.baseUrl).toBe("http://ollama:11434/v1");
    expect(() => resolveModel(cfg, "nope")).toThrow(/unknown model/);
    expect(() => resolveModel(cfg, "acme/x")).toThrow(/unknown provider/);
  });
  test("allowed models filter targets; an allowed alias passes", () => {
    const limited = { ...cfg, allowedModels: ["openai/*"] } as ProjectConfig;
    expect(resolveModel(limited, "fast").targets.map((t) => t.id)).toEqual(["openai/gpt-mini"]);
    expect(() => resolveModel(limited, "anthropic/claude-x")).toThrow(/allowed/);
    expect(resolveModel({ ...cfg, allowedModels: ["fast"] } as ProjectConfig, "fast").targets).toHaveLength(2);
  });
  test("extension: body beats headers, OpenAI user field, cache ttl, store prefix checks", () => {
    const body: Record<string, unknown> = { model: "x", user: "u1", mybase: { tags: ["a", "a", "b"] } };
    const ext = readExtension(body, new Headers({ "x-mybase-tags": "z", "x-mybase-cache": "60" }));
    expect(ext).toMatchObject({ tags: ["a", "b"], user: "u1", cache: 60 });
    expect(body.mybase).toBeUndefined();
    expect(() => readExtension({ mybase: { store: "../x" } }, new Headers())).toThrow();
    expect(readExtension({}, new Headers({ "x-mybase-tags": "p, q" })).tags).toEqual(["p", "q"]);
  });
});

describe("auth + permissions for /ai", () => {
  test("x-api-key and x-goog-api-key only under /ai/ and only mb_ keys", () => {
    expect(bearerToken(new Request("http://h/ai/shop/native/anthropic/v1/messages", { headers: { "x-api-key": "mb_abc" } }))).toBe("mb_abc");
    expect(bearerToken(new Request("http://h/ai/shop/native/google/v1beta/models", { headers: { "x-goog-api-key": "mb_g" } }))).toBe("mb_g");
    expect(bearerToken(new Request("http://h/projects", { headers: { "x-api-key": "mb_abc" } }))).toBeNull();
    expect(bearerToken(new Request("http://h/ai/shop/v1/models", { headers: { "x-api-key": "sk-ant-real" } }))).toBeNull();
  });
  test.each([
    ["POST", "/ai/shop/v1/chat/completions", { resource: "ai", level: "write" }],
    ["GET", "/ai/shop/v1/models", { resource: "ai", level: "read" }],
    ["POST", "/ai/shop/native/anthropic/v1/messages", { resource: "ai", level: "write" }],
    ["GET", "/projects/shop/ai/logs", { resource: "ai", level: "read" }],
    ["GET", "/projects/shop/ai/usage", { resource: "ai", level: "read" }],
    ["POST", "/projects/shop/ai/v1/chat/completions", { resource: "ai", level: "write" }],
    ["PUT", "/projects/shop/ai/aliases/fast", { resource: "ai", level: "write" }],
    ["PUT", "/projects/shop/ai", "admin"],
    ["PUT", "/projects/shop/ai/providers/ollama", "admin"],
    ["POST", "/projects/shop/ai/prices/refresh", "admin"],
    ["PUT", "/projects/shop/ai/keys", { resource: "secrets", level: "write" }],
    ["POST", "/memory/shop/search", { resource: "memory", level: "read" }],
    ["POST", "/memory/shop/memories", { resource: "memory", level: "write" }],
    ["POST", "/projects/shop/memory/search", { resource: "memory", level: "read" }],
    ["POST", "/vector/shop/indexes/docs/ingest", { resource: "vector", level: "write" }],
  ] as const)("%s %s", (method, path, need) => {
    expect(requirement(method, path)).toEqual(need as never);
  });
});

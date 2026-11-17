// Anthropic, translated both ways. Anthropic's own OpenAI layer is "not for production" (no
// caching, no thinking, empty token details), so the gateway maps OpenAI chat requests to the
// Messages API and the answers (and stream events) back to OpenAI chunks.
import { BadRequestError } from "../errors";
import { authHeaders, baseUrlFor, type ProviderDef } from "../ai-providers";
import { finishReason, mapMessages, mapTools, thinkingBudget, type Block } from "./messages";
import type { UpstreamRequest } from "./openai";
import { SseParser, sse, sseJson } from "./sse";
import { transformText, type StreamHooks, type Usage } from "./types";

/** Forced tool that carries a `json_schema` response format. */
export const JSON_TOOL = "json_response";

function renderBlock(b: Block): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text, ...(b.cacheControl !== undefined && { cache_control: b.cacheControl }) };
    case "image":
      return { type: "image", source: b.data !== null ? { type: "base64", media_type: b.mediaType, data: b.data } : { type: "url", url: b.url } };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.id, content: b.content };
  }
}

export interface AnthropicBody {
  body: Record<string, unknown>;
  /** The response format rides on a forced tool: map its input back to text. */
  jsonTool: boolean;
}

/** OpenAI chat request → Messages API body. */
export function toAnthropic(req: Record<string, unknown>, model: string, defaultMaxTokens: number): AnthropicBody {
  const { system, turns } = mapMessages(req.messages);
  const out: Record<string, unknown> = {
    model,
    messages: turns.map((t) => ({ role: t.role, content: t.blocks.map(renderBlock) })),
  };
  let maxTokens = Number(req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new BadRequestError("max_tokens must be a positive integer");
  const systemBlocks = system.map((s) => ({ type: "text", text: s.text, ...(s.cacheControl !== undefined && { cache_control: s.cacheControl }) }));

  const tools = mapTools(req.tools).map((t) => ({ name: t.name, ...(t.description && { description: t.description }), input_schema: t.schema }));
  let toolChoice: Record<string, unknown> | undefined;
  const choice = req.tool_choice;
  if (choice === "auto") toolChoice = { type: "auto" };
  else if (choice === "none") toolChoice = { type: "none" };
  else if (choice === "required") toolChoice = { type: "any" };
  else if (choice && typeof choice === "object") {
    const name = (choice as { function?: { name?: string } }).function?.name;
    if (!name) throw new BadRequestError("tool_choice.function.name is required");
    toolChoice = { type: "tool", name };
  }
  if (req.parallel_tool_calls === false) toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };

  let jsonTool = false;
  const format = req.response_format as { type?: string; json_schema?: { name?: string; schema?: Record<string, unknown>; description?: string } } | undefined;
  if (format?.type === "json_schema") {
    if (!format.json_schema?.schema) throw new BadRequestError("response_format.json_schema.schema is required");
    tools.push({ name: JSON_TOOL, description: format.json_schema.description ?? "Respond with the answer as this tool's input.", input_schema: format.json_schema.schema });
    toolChoice = { type: "tool", name: JSON_TOOL };
    jsonTool = true;
  } else if (format?.type === "json_object") {
    systemBlocks.push({ type: "text", text: "Respond with a single JSON object and nothing else." });
  }

  const budget = thinkingBudget(req.reasoning_effort);
  if (budget !== null && !jsonTool) {
    out.thinking = { type: "enabled", budget_tokens: budget };
    if (maxTokens <= budget) maxTokens = budget + Math.min(defaultMaxTokens, 4096);
  } else {
    if (typeof req.temperature === "number") out.temperature = Math.min(1, Math.max(0, req.temperature));
    if (typeof req.top_p === "number") out.top_p = req.top_p;
  }
  out.max_tokens = maxTokens;
  if (systemBlocks.length) out.system = systemBlocks;
  if (tools.length) out.tools = tools;
  if (toolChoice) out.tool_choice = toolChoice;
  const stop = req.stop;
  if (typeof stop === "string") out.stop_sequences = [stop];
  else if (Array.isArray(stop)) out.stop_sequences = stop;
  if (typeof req.user === "string") out.metadata = { user_id: req.user };
  if (req.stream === true) out.stream = true;
  // `mybase.anthropic`: fields passed to Anthropic as they are (e.g. `cache_control`, `service_tier`).
  const extra = (req.mybase as { anthropic?: unknown } | undefined)?.anthropic;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) Object.assign(out, extra);
  return { body: out, jsonTool };
}

export function anthropicRequest(def: ProviderDef, keys: Record<string, string>, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): UpstreamRequest {
  return {
    url: `${baseUrlFor(def, keys)}/v1/messages`,
    init: { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(def, keys), ...extraHeaders }, body: JSON.stringify(body) },
  };
}

/** Anthropic usage → gateway usage (prompt tokens include cached ones, as with OpenAI). */
export function anthropicUsage(raw: unknown, usage: Usage): Usage {
  if (!raw || typeof raw !== "object") return usage;
  const u = raw as Record<string, number | undefined>;
  const fresh = u.input_tokens;
  const read = u.cache_read_input_tokens;
  const write = u.cache_creation_input_tokens;
  if (fresh !== undefined || read !== undefined || write !== undefined) {
    usage.cacheRead = read ?? usage.cacheRead;
    usage.cacheWrite = write ?? usage.cacheWrite;
    usage.input = (fresh ?? Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)) + usage.cacheRead + usage.cacheWrite;
  }
  if (u.output_tokens !== undefined) usage.output = u.output_tokens;
  return usage;
}

export const openaiUsageOf = (usage: Usage) => ({
  prompt_tokens: usage.input,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.output,
  prompt_tokens_details: { cached_tokens: usage.cacheRead },
  completion_tokens_details: { reasoning_tokens: usage.reasoning },
});

/** A Messages API answer as an OpenAI chat completion. */
export function fromAnthropic(msg: Record<string, unknown>, model: string, jsonTool: boolean, usage: Usage): Record<string, unknown> {
  anthropicUsage(msg.usage, usage);
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  for (const block of (msg.content ?? []) as Record<string, unknown>[]) {
    if (block.type === "text") content += block.text ?? "";
    else if (block.type === "thinking") reasoning += block.thinking ?? "";
    else if (block.type === "tool_use") {
      if (jsonTool && block.name === JSON_TOOL) content += JSON.stringify(block.input ?? {});
      else toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  let finish = finishReason(msg.stop_reason as string | null);
  if (jsonTool && finish === "tool_calls" && toolCalls.length === 0) finish = "stop";
  return {
    id: `chatcmpl-${String(msg.id ?? crypto.randomUUID())}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || (toolCalls.length ? null : ""),
          ...(reasoning && { reasoning_content: reasoning }),
          ...(toolCalls.length && { tool_calls: toolCalls }),
        },
        finish_reason: finish,
      },
    ],
    usage: openaiUsageOf(usage),
  };
}

/**
 * A Messages API stream as OpenAI chat chunks. Tool call arguments arrive as
 * `input_json_delta`; the forced JSON tool's input is sent as content instead.
 */
export function anthropicStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  jsonTool: boolean,
  usage: Usage,
  wantUsage: boolean,
  hooks: StreamHooks,
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let first = true;
  let finish: string | null = null;
  let ended = false;
  // Anthropic content block index → OpenAI tool call index; -1 = the JSON tool (content).
  const tools = new Map<number, number>();
  let toolCount = 0;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    sseJson({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });

  const handle = (events: ReturnType<SseParser["feed"]>, push: (s: string) => void) => {
    for (const e of events) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data);
      } catch {
        continue;
      }
      if (first) {
        first = false;
        hooks.first();
      }
      switch (data.type) {
        case "message_start": {
          const message = (data.message ?? {}) as Record<string, unknown>;
          if (message.id) id = `chatcmpl-${String(message.id)}`;
          anthropicUsage(message.usage, usage);
          push(chunk({ role: "assistant", content: "" }));
          break;
        }
        case "content_block_start": {
          const block = (data.content_block ?? {}) as Record<string, unknown>;
          const index = Number(data.index);
          if (block.type === "tool_use") {
            if (jsonTool && block.name === JSON_TOOL) tools.set(index, -1);
            else {
              const i = toolCount++;
              tools.set(index, i);
              push(chunk({ tool_calls: [{ index: i, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }));
            }
          }
          break;
        }
        case "content_block_delta": {
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta") push(chunk({ content: delta.text ?? "" }));
          else if (delta.type === "thinking_delta") push(chunk({ reasoning_content: delta.thinking ?? "" }));
          else if (delta.type === "input_json_delta") {
            const i = tools.get(Number(data.index));
            if (i === -1) push(chunk({ content: delta.partial_json ?? "" }));
            else if (i !== undefined) push(chunk({ tool_calls: [{ index: i, function: { arguments: delta.partial_json ?? "" } }] }));
          }
          break;
        }
        case "message_delta": {
          anthropicUsage(data.usage, usage);
          const reason = (data.delta as { stop_reason?: string } | undefined)?.stop_reason;
          finish = finishReason(reason);
          if (jsonTool && finish === "tool_calls" && toolCount === 0) finish = "stop";
          break;
        }
        case "message_stop":
          push(chunk({}, finish ?? "stop"));
          if (wantUsage) push(sseJson({ id, object: "chat.completion.chunk", created, model, choices: [], usage: openaiUsageOf(usage) }));
          push(sse("[DONE]"));
          ended = true;
          break;
        case "error": {
          const err = (data.error ?? {}) as { message?: string; type?: string };
          push(sseJson({ error: { message: err.message ?? "the provider's stream failed", type: err.type ?? "upstream_error" } }));
          push(sse("[DONE]"));
          ended = true;
          break;
        }
      }
    }
  };
  return transformText(
    body,
    {
      chunk: (text, push) => handle(parser.feed(text), push),
      flush: (push) => {
        handle(parser.end(), push);
        if (!ended) push(sse("[DONE]"));
      },
      done: hooks.done,
    },
    hooks.tap,
  );
}

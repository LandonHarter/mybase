// Amazon Bedrock: OpenAI chat ↔ Converse / ConverseStream, signed with SigV4 (aws4fetch). The
// message mapping is shared with the Anthropic adapter (messages.ts). Embeddings go through
// InvokeModel (Titan and Cohere request shapes), one call per input for Titan.
import { AwsClient } from "aws4fetch";
import { BadRequestError, UpstreamError } from "../errors";
import { baseUrlFor, keyValue, type ProviderDef } from "../ai-providers";
import { openaiUsageOf } from "./anthropic";
import { EventStreamDecoder } from "./eventstream";
import { finishReason, mapMessages, mapTools, thinkingBudget, type Block } from "./messages";
import type { UpstreamRequest } from "./openai";
import { sse, sseJson } from "./sse";
import { newUsage, type StreamHooks, type Usage } from "./types";

const JSON_TOOL = "json_response";

function client(def: ProviderDef, keys: Record<string, string>) {
  return new AwsClient({
    accessKeyId: keyValue(def, keys, "AWS_ACCESS_KEY_ID") ?? "",
    secretAccessKey: keyValue(def, keys, "AWS_SECRET_ACCESS_KEY") ?? "",
    region: keyValue(def, keys, "AWS_REGION") ?? "us-east-1",
    service: "bedrock",
  });
}

async function signed(def: ProviderDef, keys: Record<string, string>, path: string, body: unknown, accept = "application/json"): Promise<UpstreamRequest> {
  const url = `${baseUrlFor(def, keys)}${path}`;
  const req = await client(def, keys).sign(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: accept }, body: JSON.stringify(body) });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  return { url, init: { method: "POST", headers, body: await req.text() } };
}

const FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };

function renderBlock(b: Block): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { text: b.text };
    case "image":
      if (b.data === null) throw new BadRequestError("Bedrock takes images as data: URLs (base64), not links");
      return { image: { format: FORMATS[b.mediaType] ?? "png", source: { bytes: b.data } } };
    case "tool_use":
      return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
    case "tool_result":
      return { toolResult: { toolUseId: b.id, content: [{ text: b.content }] } };
  }
}

/** OpenAI chat request → a signed Converse (or ConverseStream) request. */
export async function bedrockChatRequest(
  def: ProviderDef,
  keys: Record<string, string>,
  req: Record<string, unknown>,
  model: string,
  defaultMaxTokens: number,
): Promise<{ request: UpstreamRequest; jsonTool: boolean }> {
  const { system, turns } = mapMessages(req.messages);
  const body: Record<string, unknown> = { messages: turns.map((t) => ({ role: t.role, content: t.blocks.map(renderBlock) })) };
  if (system.length) body.system = system.map((s) => ({ text: s.text }));
  const inference: Record<string, unknown> = { maxTokens: Number(req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens) };
  if (typeof req.temperature === "number") inference.temperature = req.temperature;
  if (typeof req.top_p === "number") inference.topP = req.top_p;
  if (typeof req.stop === "string") inference.stopSequences = [req.stop];
  else if (Array.isArray(req.stop)) inference.stopSequences = req.stop;

  const tools = mapTools(req.tools).map((t) => ({ toolSpec: { name: t.name, ...(t.description && { description: t.description }), inputSchema: { json: t.schema } } }));
  let toolChoice: Record<string, unknown> | undefined;
  if (req.tool_choice === "auto") toolChoice = { auto: {} };
  else if (req.tool_choice === "required") toolChoice = { any: {} };
  else if (req.tool_choice && typeof req.tool_choice === "object") toolChoice = { tool: { name: (req.tool_choice as { function?: { name?: string } }).function?.name } };
  let jsonTool = false;
  const format = req.response_format as { type?: string; json_schema?: { schema?: Record<string, unknown> } } | undefined;
  if (format?.type === "json_schema" && format.json_schema?.schema) {
    tools.push({ toolSpec: { name: JSON_TOOL, description: "Respond with the answer as this tool's input.", inputSchema: { json: format.json_schema.schema } } });
    toolChoice = { tool: { name: JSON_TOOL } };
    jsonTool = true;
  }
  if (tools.length && req.tool_choice !== "none") body.toolConfig = { tools, ...(toolChoice && { toolChoice }) };

  const budget = thinkingBudget(req.reasoning_effort);
  if (budget !== null && !jsonTool && /anthropic|claude/.test(model)) {
    body.additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: budget } };
    if ((inference.maxTokens as number) <= budget) inference.maxTokens = budget + 4096;
    delete inference.temperature;
    delete inference.topP;
  }
  body.inferenceConfig = inference;
  const stream = req.stream === true;
  const path = `/model/${encodeURIComponent(model)}/${stream ? "converse-stream" : "converse"}`;
  return { request: await signed(def, keys, path, body, stream ? "application/vnd.amazon.eventstream" : "application/json"), jsonTool };
}

function converseUsage(raw: unknown, usage: Usage) {
  if (!raw || typeof raw !== "object") return;
  const u = raw as Record<string, number | undefined>;
  usage.cacheRead = u.cacheReadInputTokens ?? usage.cacheRead;
  usage.cacheWrite = u.cacheWriteInputTokens ?? usage.cacheWrite;
  if (u.inputTokens !== undefined) usage.input = u.inputTokens + usage.cacheRead + usage.cacheWrite;
  if (u.outputTokens !== undefined) usage.output = u.outputTokens;
}

/** A Converse answer as an OpenAI chat completion. */
export function fromConverse(json: Record<string, unknown>, model: string, jsonTool: boolean, usage: Usage): Record<string, unknown> {
  converseUsage(json.usage, usage);
  const blocks = ((json.output as { message?: { content?: Record<string, unknown>[] } } | undefined)?.message?.content ?? []) as Record<string, unknown>[];
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  for (const b of blocks) {
    if (typeof b.text === "string") content += b.text;
    else if (b.reasoningContent) reasoning += (b.reasoningContent as { reasoningText?: { text?: string } }).reasoningText?.text ?? "";
    else if (b.toolUse) {
      const t = b.toolUse as { toolUseId: string; name: string; input: unknown };
      if (jsonTool && t.name === JSON_TOOL) content += JSON.stringify(t.input ?? {});
      else toolCalls.push({ id: t.toolUseId, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } });
    }
  }
  let finish = finishReason(json.stopReason as string);
  if (jsonTool && finish === "tool_calls" && toolCalls.length === 0) finish = "stop";
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
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

/** A ConverseStream body (binary event stream) as OpenAI chat chunks. */
export function converseStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  jsonTool: boolean,
  usage: Usage,
  wantUsage: boolean,
  hooks: StreamHooks,
): ReadableStream<Uint8Array> {
  const decoder = new EventStreamDecoder();
  const text = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const tools = new Map<number, number>();
  let toolCount = 0;
  let finish: string | null = null;
  let first = true;
  let finished = false;
  const chunk = (delta: Record<string, unknown>, reason: string | null = null) =>
    sseJson({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: reason }] });
  const done = (err: unknown) => {
    if (finished) return;
    finished = true;
    hooks.done(err);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let sent = false;
      const push = (s: string) => {
        hooks.tap?.(s);
        controller.enqueue(encoder.encode(s));
        sent = true;
      };
      try {
        while (!sent) {
          const { done: end, value } = await reader.read();
          if (end) {
            push(chunk({}, finish ?? "stop"));
            if (wantUsage) push(sseJson({ id, object: "chat.completion.chunk", created, model, choices: [], usage: openaiUsageOf(usage) }));
            push(sse("[DONE]"));
            controller.close();
            done(null);
            return;
          }
          for (const msg of decoder.feed(value)) {
            if (first) {
              first = false;
              hooks.first();
              push(chunk({ role: "assistant", content: "" }));
            }
            const type = msg.headers[":event-type"] ?? msg.headers[":exception-type"];
            const data = JSON.parse(text.decode(msg.payload) || "{}") as Record<string, unknown>;
            if (msg.headers[":message-type"] === "exception") {
              push(sseJson({ error: { message: String(data.message ?? type ?? "the provider's stream failed"), type: "upstream_error" } }));
              continue;
            }
            const index = Number(data.contentBlockIndex);
            switch (type) {
              case "contentBlockStart": {
                const tool = (data.start as { toolUse?: { toolUseId: string; name: string } } | undefined)?.toolUse;
                if (tool) {
                  if (jsonTool && tool.name === JSON_TOOL) tools.set(index, -1);
                  else {
                    const i = toolCount++;
                    tools.set(index, i);
                    push(chunk({ tool_calls: [{ index: i, id: tool.toolUseId, type: "function", function: { name: tool.name, arguments: "" } }] }));
                  }
                }
                break;
              }
              case "contentBlockDelta": {
                const delta = (data.delta ?? {}) as { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string } };
                if (typeof delta.text === "string") push(chunk({ content: delta.text }));
                else if (delta.reasoningContent?.text) push(chunk({ reasoning_content: delta.reasoningContent.text }));
                else if (delta.toolUse) {
                  const i = tools.get(index);
                  if (i === -1) push(chunk({ content: delta.toolUse.input ?? "" }));
                  else if (i !== undefined) push(chunk({ tool_calls: [{ index: i, function: { arguments: delta.toolUse.input ?? "" } }] }));
                }
                break;
              }
              case "messageStop":
                finish = finishReason(data.stopReason as string);
                if (jsonTool && finish === "tool_calls" && toolCount === 0) finish = "stop";
                break;
              case "metadata":
                converseUsage(data.usage, usage);
                break;
            }
          }
        }
      } catch (err) {
        done(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      done(reason ?? new Error("client went away"));
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** Embeddings through InvokeModel, as an OpenAI embeddings answer. */
export async function bedrockEmbed(
  def: ProviderDef,
  keys: Record<string, string>,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ json: unknown; usage: Usage }> {
  const input = body.input;
  const inputs = typeof input === "string" ? [input] : Array.isArray(input) && input.every((s) => typeof s === "string") ? (input as string[]) : null;
  if (!inputs || inputs.length === 0) throw new BadRequestError("input must be a string or a list of strings");
  const usage = newUsage();
  const path = `/model/${encodeURIComponent(model)}/invoke`;
  const call = async (payload: unknown) => {
    const up = await signed(def, keys, path, payload);
    const res = await fetch(up.url, { ...up.init, signal, redirect: "error" });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`Bedrock answered ${res.status}: ${text.slice(0, 300)}`);
    usage.input += Number(res.headers.get("x-amzn-bedrock-input-token-count") ?? 0);
    return JSON.parse(text) as Record<string, unknown>;
  };
  let vectors: number[][];
  if (/cohere/.test(model)) {
    const out = await call({ texts: inputs, input_type: "search_document" });
    const e = out.embeddings as number[][] | { float?: number[][] };
    vectors = Array.isArray(e) ? e : (e.float ?? []);
  } else {
    vectors = [];
    for (const text of inputs) {
      const out = await call({ inputText: text, ...(typeof body.dimensions === "number" && { dimensions: body.dimensions }) });
      vectors.push(out.embedding as number[]);
      if (!usage.input && typeof out.inputTextTokenCount === "number") usage.input += out.inputTextTokenCount;
    }
  }
  return {
    json: {
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      model: `bedrock/${model}`,
      usage: { prompt_tokens: usage.input, total_tokens: usage.input },
    },
    usage,
  };
}

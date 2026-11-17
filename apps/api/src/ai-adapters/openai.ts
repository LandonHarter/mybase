// OpenAI-wire providers: the request goes on as sent, with `model` rewritten. Streams ask for
// usage (`stream_options.include_usage`) so every call can be priced, and the trailing
// usage-only chunk is dropped again when the client didn't ask for it.
import { authHeaders, baseUrlFor, type ProviderDef } from "../ai-providers";
import { SseParser, sse } from "./sse";
import { readOpenAIUsage, transformText, type StreamHooks, type Usage } from "./types";

export interface UpstreamRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

/** `path` like `/chat/completions`. */
export function openaiRequest(def: ProviderDef, keys: Record<string, string>, path: string, body: Record<string, unknown>, model: string): UpstreamRequest {
  const out: Record<string, unknown> = { ...body, model };
  if (out.stream === true && (path === "/chat/completions" || path === "/completions")) {
    out.stream_options = { ...(out.stream_options as object | undefined), include_usage: true };
  }
  // OpenRouter reports what a call cost when asked.
  if (def.id === "openrouter" && (path === "/chat/completions" || path === "/responses")) out.usage = { include: true };
  return {
    url: `${baseUrlFor(def, keys)}${path}`,
    init: { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(def, keys) }, body: JSON.stringify(out) },
  };
}

/** Usage from a non-streamed answer (chat, embeddings, images, responses). */
export function openaiUsage(json: unknown, usage: Usage): Usage {
  const body = json as { usage?: unknown; providerMetadata?: { gateway?: { cost?: unknown } }; data?: unknown[] };
  readOpenAIUsage(body?.usage, usage);
  // Vercel's gateway reports embedding costs here (as a string or a number).
  const gatewayCost = Number(body?.providerMetadata?.gateway?.cost);
  if (body?.providerMetadata?.gateway?.cost !== undefined && Number.isFinite(gatewayCost)) usage.providerCost = gatewayCost;
  return usage;
}

/**
 * Forwards an OpenAI chat stream, reading usage as it passes. `wantUsage`: the client asked
 * for usage itself (else the usage-only chunk is dropped and usage fields cleared).
 */
export function openaiChatStream(body: ReadableStream<Uint8Array>, usage: Usage, wantUsage: boolean, hooks: StreamHooks): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  let first = true;
  const handle = (events: ReturnType<SseParser["feed"]>, push: (s: string) => void) => {
    for (const e of events) {
      if (first) {
        first = false;
        hooks.first();
      }
      if (e.data === "[DONE]") {
        push(sse("[DONE]"));
        continue;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(e.data);
      } catch {
        push(sse(e.data, e.event));
        continue;
      }
      if (chunk.usage) readOpenAIUsage(chunk.usage, usage);
      if (!wantUsage && chunk.usage) {
        if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
        delete chunk.usage;
      }
      push(sse(JSON.stringify(chunk), e.event));
    }
  };
  return transformText(body, { chunk: (text, push) => handle(parser.feed(text), push), flush: (push) => handle(parser.end(), push), done: hooks.done }, hooks.tap);
}

/** Usage from a Responses API stream event (`response.completed`). */
export function responsesStream(body: ReadableStream<Uint8Array>, usage: Usage, hooks: StreamHooks): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  let first = true;
  const handle = (events: ReturnType<SseParser["feed"]>, push: (s: string) => void) => {
    for (const e of events) {
      if (first) {
        first = false;
        hooks.first();
      }
      if (e.event === "response.completed" || e.data.includes('"response.completed"')) {
        try {
          const parsed = JSON.parse(e.data) as { response?: { usage?: unknown } };
          readOpenAIUsage(parsed.response?.usage, usage);
        } catch {
          // passed on as is
        }
      }
      push(sse(e.data, e.event));
    }
  };
  return transformText(body, { chunk: (t, push) => handle(parser.feed(t), push), flush: (push) => handle(parser.end(), push), done: hooks.done }, hooks.tap);
}

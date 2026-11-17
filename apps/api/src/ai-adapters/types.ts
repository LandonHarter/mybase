// What adapters share: usage counts as the gateway logs them, and stream plumbing.
import type { UsageCounts } from "../ai-prices";

export interface Usage extends UsageCounts {
  /** What the provider said it cost (OpenRouter, Vercel), in USD. */
  providerCost: number | null;
}

export const newUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, images: 0, providerCost: null });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** OpenAI-format usage (chat, embeddings, images, responses) into `into`. Later reports replace earlier ones. */
export function readOpenAIUsage(raw: unknown, into: Usage): Usage {
  if (!raw || typeof raw !== "object") return into;
  const u = raw as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? u.output_tokens_details ?? {}) as Record<string, unknown>;
  const input = num(u.prompt_tokens ?? u.input_tokens);
  const output = num(u.completion_tokens ?? u.output_tokens);
  if (input || output) {
    into.input = input;
    into.output = output;
  }
  into.cacheRead = num(promptDetails.cached_tokens);
  into.cacheWrite = num(promptDetails.cache_write_tokens);
  into.reasoning = num(completionDetails.reasoning_tokens);
  if (typeof u.cost === "number") into.providerCost = u.cost;
  return into;
}

/** What the gateway hears from a stream: first event (TTFB), every text sent on (capture), the end. */
export interface StreamHooks {
  first(): void;
  done(error: unknown): void;
  tap?(text: string): void;
}

/** Passes text chunks of an upstream body through `chunk`, which pushes what to send on. */
export function transformText(
  body: ReadableStream<Uint8Array>,
  handlers: { chunk(text: string, push: (s: string) => void): void; flush?(push: (s: string) => void): void; done?(error: unknown): void },
  tap?: (text: string) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  let finished = false;
  const finish = (error: unknown) => {
    if (finished) return;
    finished = true;
    handlers.done?.(error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let sent = false;
      const push = (s: string) => {
        if (!s) return;
        tap?.(s);
        controller.enqueue(encoder.encode(s));
        sent = true;
      };
      try {
        // A pull that enqueues nothing isn't called again: read until something goes out.
        while (!sent) {
          const { done, value } = await reader.read();
          if (done) {
            handlers.chunk(decoder.decode(), push);
            handlers.flush?.(push);
            controller.close();
            finish(null);
            return;
          }
          handlers.chunk(decoder.decode(value, { stream: true }), push);
        }
      } catch (err) {
        finish(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish(reason ?? new Error("client went away"));
      await reader.cancel(reason).catch(() => {});
    },
  });
}

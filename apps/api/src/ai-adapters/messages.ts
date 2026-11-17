// OpenAI chat messages → a neutral list of turns with content blocks, which the Anthropic and
// Bedrock (Converse) adapters render in their own shapes. Consecutive turns of the same role are
// merged (both APIs want user/assistant alternating), and tool results become user turns.
import { BadRequestError } from "../errors";

export type Block =
  | { type: "text"; text: string; cacheControl?: unknown }
  | { type: "image"; mediaType: string; data: string | null; url: string | null }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string };

export interface Turn {
  role: "user" | "assistant";
  blocks: Block[];
}

export interface Mapped {
  system: { text: string; cacheControl?: unknown }[];
  turns: Turn[];
}

type Part = { type?: string; text?: string; image_url?: string | { url?: string }; cache_control?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: Part) => (p?.type === "text" ? (p.text ?? "") : "")).join("");
  return "";
}

/** A `data:` URL or an http(s) URL as an image block. */
export function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: "image", mediaType: m[1]!, data: m[2]!, url: null };
  if (!/^https?:\/\//.test(url)) throw new BadRequestError("image_url.url must be a data: URL or an http(s) URL");
  const ext = /\.(png|jpe?g|gif|webp)(\?|$)/i.exec(url)?.[1]?.toLowerCase();
  return { type: "image", mediaType: ext ? `image/${ext === "jpg" ? "jpeg" : ext}` : "image/jpeg", data: null, url };
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const part of content as Part[]) {
    if (part?.type === "text") out.push({ type: "text", text: part.text ?? "", ...(part.cache_control !== undefined && { cacheControl: part.cache_control }) });
    else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") throw new BadRequestError("image_url.url is required");
      out.push(imageBlock(url));
    } else throw new BadRequestError(`content part type "${part?.type}" isn't supported for this provider`);
  }
  return out;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("tool_calls[].function.arguments must be JSON");
  }
}

export function mapMessages(messages: unknown): Mapped {
  if (!Array.isArray(messages) || messages.length === 0) throw new BadRequestError("messages must be a non-empty array");
  const system: Mapped["system"] = [];
  const turns: Turn[] = [];
  const add = (role: Turn["role"], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks });
  };
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]; tool_call_id?: string };
    switch (m?.role) {
      case "system":
      case "developer":
        if (Array.isArray(m.content)) {
          for (const p of m.content as Part[]) if (p?.type === "text") system.push({ text: p.text ?? "", ...(p.cache_control !== undefined && { cacheControl: p.cache_control }) });
        } else if (typeof m.content === "string" && m.content) system.push({ text: m.content });
        break;
      case "user":
        add("user", blocksOf(m.content));
        break;
      case "assistant": {
        const blocks = blocksOf(m.content);
        for (const call of m.tool_calls ?? []) {
          blocks.push({ type: "tool_use", id: call.id ?? crypto.randomUUID(), name: call.function?.name ?? "", input: parseArgs(call.function?.arguments) });
        }
        add("assistant", blocks);
        break;
      }
      case "tool":
        if (typeof m.tool_call_id !== "string") throw new BadRequestError("tool messages need tool_call_id");
        add("user", [{ type: "tool_result", id: m.tool_call_id, content: textOf(m.content) }]);
        break;
      default:
        throw new BadRequestError(`unknown message role ${JSON.stringify(m?.role)}`);
    }
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", blocks: [{ type: "text", text: "(start)" }] });
  return { system, turns };
}

/** OpenAI `tools` → name, description, JSON schema. */
export function mapTools(tools: unknown): { name: string; description?: string; schema: Record<string, unknown> }[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw new BadRequestError("tools must be an array");
  return tools.map((t: { type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }) => {
    if (t?.type !== "function" || typeof t.function?.name !== "string") throw new BadRequestError("only function tools are supported for this provider");
    return { name: t.function.name, ...(t.function.description && { description: t.function.description }), schema: t.function.parameters ?? { type: "object", properties: {} } };
  });
}

/** Stop reasons → OpenAI finish_reason. */
export function finishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
    case "guardrail_intervened":
    case "content_filtered":
      return "content_filter";
    case null:
    case undefined:
      return null;
    default:
      return "stop";
  }
}

/** `reasoning_effort` → a thinking budget in tokens. */
export function thinkingBudget(effort: unknown): number | null {
  switch (effort) {
    case "minimal":
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 16_384;
    default:
      return null;
  }
}

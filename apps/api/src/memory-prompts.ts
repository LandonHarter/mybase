// Prompts and answer parsing for the memory service (pure, tested). mem0's approach: one call
// pulls facts out of a conversation, a second decides, against the closest existing memories,
// whether each fact is new (ADD), refines one (UPDATE), contradicts one (DELETE), or is known
// (NONE). Existing memories get small integer ids in the prompt, so the model never has to
// copy a UUID (models garble them); the ids are mapped back here.

export const FACTS_SCHEMA = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
  additionalProperties: false,
} as const;

export const DECISIONS_SCHEMA = {
  type: "object",
  properties: {
    memory: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          event: { type: "string", enum: ["ADD", "UPDATE", "DELETE", "NONE"] },
          old_memory: { type: "string" },
        },
        required: ["id", "text", "event"],
        additionalProperties: false,
      },
    },
  },
  required: ["memory"],
  additionalProperties: false,
} as const;

export function factsPrompt(custom: string | null, today: string): string {
  return [
    "You extract durable facts from a conversation, to remember about the user for future conversations.",
    "Keep: personal details, preferences and dislikes, plans and goals, relationships, health and dietary needs, work and projects, decisions, and anything the user asked to be remembered.",
    "Skip: small talk, questions without an answer, the assistant's own suggestions unless the user accepted them, and anything temporary or trivial.",
    'Write each fact as one short, self-contained statement in the user\'s language, in the third person without a name (e.g. "Is vegetarian", "Lives in Lisbon").',
    "Only use what the user said or clearly confirmed. Resolve relative dates against today's date.",
    `Today is ${today}.`,
    custom ? `Additional instructions from the app:\n${custom}` : "",
    'Answer with JSON: {"facts": ["…"]}. If there is nothing worth keeping, answer {"facts": []}.',
  ]
    .filter(Boolean)
    .join("\n");
}

export function decisionsPrompt(existing: { id: string; text: string }[], facts: string[]): string {
  return [
    "You maintain a memory store. Compare the new facts with the existing memories and decide, for each, one of:",
    "- ADD: a new fact not covered by any memory. Use a new id (the next unused number).",
    "- UPDATE: a fact that refines or corrects an existing memory with more or newer information. Keep that memory's id; text is the merged memory; old_memory is its previous text.",
    "- DELETE: a fact that contradicts an existing memory so that it's no longer true. Keep that memory's id.",
    "- NONE: the fact is already known. Keep the matching memory's id.",
    "Only use ids from the existing memories for UPDATE, DELETE, and NONE. Don't repeat memories that no fact touches.",
    "",
    `Existing memories:\n${JSON.stringify(existing)}`,
    "",
    `New facts:\n${JSON.stringify(facts)}`,
    "",
    'Answer with JSON: {"memory": [{"id": "…", "text": "…", "event": "ADD|UPDATE|DELETE|NONE", "old_memory": "…"}]}.',
  ].join("\n");
}

/** JSON from a model's answer, also when it wrapped it in a code fence or text. */
export function parseJsonAnswer(content: unknown): unknown {
  if (typeof content !== "string") return null;
  const text = content.trim();
  for (const candidate of [text, /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  return null;
}

export function parseFacts(content: unknown, maxLength: number): string[] {
  const value = parseJsonAnswer(content) as { facts?: unknown } | null;
  const facts = Array.isArray(value?.facts) ? value.facts : [];
  return [
    ...new Set(
      facts
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, 50);
}

export type Decision =
  | { event: "ADD"; text: string }
  | { event: "UPDATE"; id: string; text: string; old: string }
  | { event: "DELETE"; id: string; old: string }
  | { event: "NONE"; id: string | null };

/**
 * The model's decisions with temp ids mapped back to memory ids (`tempIds[i]` = id of temp `i`).
 * UPDATE/DELETE naming an id that wasn't offered become ADD (for UPDATE) or are dropped (DELETE).
 */
export function parseDecisions(content: unknown, tempIds: string[], existing: Map<string, string>, maxLength: number): Decision[] {
  const value = parseJsonAnswer(content) as { memory?: unknown } | null;
  const items = Array.isArray(value?.memory) ? value.memory : [];
  const out: Decision[] = [];
  const touched = new Set<string>();
  for (const raw of items) {
    const item = raw as { id?: unknown; text?: unknown; event?: unknown };
    const event = typeof item.event === "string" ? item.event.toUpperCase() : "";
    const text = typeof item.text === "string" ? item.text.trim().slice(0, maxLength) : "";
    const temp = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : "";
    const id = /^\d+$/.test(temp) && Number(temp) < tempIds.length ? tempIds[Number(temp)]! : null;
    if (id && touched.has(id)) continue;
    if (event === "ADD") {
      if (text) out.push({ event: "ADD", text });
    } else if (event === "UPDATE") {
      if (!text) continue;
      if (id) {
        touched.add(id);
        if (existing.get(id) !== text) out.push({ event: "UPDATE", id, text, old: existing.get(id) ?? "" });
      } else out.push({ event: "ADD", text });
    } else if (event === "DELETE") {
      if (id) {
        touched.add(id);
        out.push({ event: "DELETE", id, old: existing.get(id) ?? "" });
      }
    } else if (event === "NONE") {
      if (id) touched.add(id);
      out.push({ event: "NONE", id });
    }
  }
  // The same new text twice: keep the first.
  const seen = new Set<string>();
  return out.filter((d) => {
    if (d.event !== "ADD") return true;
    const key = d.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A conversation as plain text for the extraction prompt. */
export function conversationText(messages: { role: string; content: string }[]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

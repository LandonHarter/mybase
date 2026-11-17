import { describe, expect, test } from "bun:test";
import { parseDecisions, parseFacts, parseJsonAnswer } from "./memory-prompts";
import { chunkId, chunkText } from "./vector-chunk";

describe("memory answers", () => {
  test("JSON in fences or text", () => {
    expect(parseJsonAnswer('```json\n{"facts":["a"]}\n```')).toEqual({ facts: ["a"] });
    expect(parseJsonAnswer('Sure! {"facts":[]} done')).toEqual({ facts: [] });
    expect(parseJsonAnswer("nope")).toBeNull();
  });
  test("facts: strings only, trimmed, deduped, capped", () => {
    expect(parseFacts('{"facts":[" Is vegetarian ", "Is vegetarian", 3, ""]}', 100)).toEqual(["Is vegetarian"]);
    expect(parseFacts('{"facts":["' + "x".repeat(50) + '"]}', 10)).toEqual(["x".repeat(10)]);
  });
  test("decisions: temp ids map back; unknown ids; duplicates", () => {
    const ids = ["uuid-a", "uuid-b"];
    const existing = new Map([
      ["uuid-a", "Likes tea"],
      ["uuid-b", "Lives in Paris"],
    ]);
    const answer = JSON.stringify({
      memory: [
        { id: "0", text: "Likes green tea", event: "UPDATE", old_memory: "Likes tea" },
        { id: "1", text: "Lives in Paris", event: "DELETE" },
        { id: "2", text: "Is vegetarian", event: "ADD" },
        { id: "7", text: "Has a dog", event: "UPDATE" },
        { id: "9", text: "x", event: "DELETE" },
        { id: "3", text: "is vegetarian", event: "ADD" },
        { id: "0", text: "again", event: "UPDATE" },
      ],
    });
    expect(parseDecisions(answer, ids, existing, 1000)).toEqual([
      { event: "UPDATE", id: "uuid-a", text: "Likes green tea", old: "Likes tea" },
      { event: "DELETE", id: "uuid-b", old: "Lives in Paris" },
      { event: "ADD", text: "Is vegetarian" },
      { event: "ADD", text: "Has a dog" },
    ]);
  });
  test("an UPDATE that doesn't change the text is dropped", () => {
    expect(parseDecisions('{"memory":[{"id":"0","text":"Likes tea","event":"UPDATE"}]}', ["a"], new Map([["a", "Likes tea"]]), 100)).toEqual([]);
  });
});

describe("chunker", () => {
  test("short text is one chunk; empty is none", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
    expect(chunkText("  \n ")).toEqual([]);
  });
  test("chunks stay under size, split on headings first, and overlap", () => {
    const section = (h: string) => `# ${h}\n\n${"Sentence about " + h + ". ".repeat(1)}`.repeat(1) + "Words here. ".repeat(30);
    const text = ["A", "B", "C"].map(section).join("\n");
    const chunks = chunkText(text, { size: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.some((c) => c.startsWith("# B"))).toBe(true);
    // Neighbours share text.
    const shared = chunks.slice(1).filter((c, i) => {
      const prev = chunks[i]!;
      return prev
        .slice(-30)
        .split(" ")
        .some((w) => w.length > 3 && c.includes(w));
    });
    expect(shared.length).toBeGreaterThan(0);
  });
  test("one huge word is cut hard", () => {
    const chunks = chunkText("x".repeat(250), { size: 100, overlap: 0 });
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });
  test("ids", () => {
    expect(chunkId("docs/a.md", 2)).toBe("docs/a.md#2");
  });
});

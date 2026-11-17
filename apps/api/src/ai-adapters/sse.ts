// A tiny server-sent events parser and serializer for the AI gateway's streams.
// Incremental: `feed` takes text as it arrives and returns the events it completed.

export interface SseEvent {
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = "";
  private event: string | null = null;
  private data: string[] = [];

  feed(text: string): SseEvent[] {
    this.buffer += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl < 0) break;
      let line = this.buffer.slice(start, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = nl + 1;
      if (line === "") {
        if (this.data.length) out.push({ event: this.event, data: this.data.join("\n") });
        this.event = null;
        this.data = [];
      } else if (line.startsWith(":")) {
        // comment / keep-alive
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") this.data.push(value);
        else if (field === "event") this.event = value;
      }
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** The last event when the stream ended without a blank line. */
  end(): SseEvent[] {
    const out = this.feed("\n\n");
    this.buffer = "";
    return out;
  }
}

/** One event as text. Multi-line data is split into `data:` lines. */
export function sse(data: string, event?: string | null): string {
  return `${event ? `event: ${event}\n` : ""}${data
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n")}\n\n`;
}

export const sseJson = (value: unknown, event?: string | null) => sse(JSON.stringify(value), event);

// Splits documents into chunks for the vector pipeline (pure). Recursive by structure: markdown
// headings first, then paragraphs, lines, sentences, words, and finally a hard cut, so chunks
// stay near `size` characters and end on natural boundaries. Neighbouring chunks share up to
// `overlap` characters, so a sentence cut at a boundary is still found whole in one of them.

const SEPARATORS = ["\n# ", "\n## ", "\n### ", "\n#### ", "\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

/** Pieces of `text`, each at most `size` characters, separators kept with the piece they start. */
function split(text: string, size: number, seps: string[]): string[] {
  if (text.length <= size) return [text];
  const i = seps.findIndex((s) => text.includes(s));
  if (i < 0) {
    const out: string[] = [];
    for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
    return out;
  }
  const sep = seps[i]!;
  const rest = seps.slice(i + 1);
  const parts = text.split(sep);
  // Headings and sentence ends stay attached: a heading starts its piece, a period ends its sentence.
  const startsPiece = sep.startsWith("\n#");
  const pieces = parts.map((p, j) => (startsPiece ? (j === 0 ? p : sep.slice(1) + p) : j < parts.length - 1 ? p + sep : p)).filter((p) => p.length > 0);
  return pieces.flatMap((p) => (p.length > size ? split(p, size, rest) : [p]));
}

export interface ChunkOptions {
  /** Target characters per chunk. Default 1000. */
  size?: number;
  /** Characters shared between neighbours. Default 150. */
  overlap?: number;
}

export function chunkText(text: string, { size = 1000, overlap = 150 }: ChunkOptions = {}): string[] {
  if (size < 50) throw new RangeError("chunk size must be at least 50 characters");
  overlap = Math.max(0, Math.min(overlap, Math.floor(size / 2)));
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  const pieces = split(clean, size, SEPARATORS);
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    // A heading always starts a chunk, without overlap: a new section starts clean.
    const heading = /^#{1,6} /.test(piece);
    if (current.length && (heading || length + piece.length > size)) {
      chunks.push(current.join("").trim());
      // Keep a tail of the last chunk as the start of the next one.
      while (current.length && (heading || length > overlap || length + piece.length > size)) length -= current.shift()!.length;
    }
    current.push(piece);
    length += piece.length;
  }
  if (current.length) chunks.push(current.join("").trim());
  return chunks.filter((c) => c.length > 0);
}

/** A chunk's document id: the item it came from and its position. */
export const chunkId = (item: string, n: number) => `${item}#${n}`;

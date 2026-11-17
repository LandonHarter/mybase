// Text out of files for the vector pipeline: plain text and markdown as they are, HTML through
// Readability + Turndown (as web search reads pages), PDF with unpdf, docx with mammoth. The PDF
// and docx libraries are imported on first use, so the API doesn't load them unless a source needs them.
import { htmlToMarkdown } from "./search-fetch";

/** Files bigger than this are skipped. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Extracted text is cut here (a 25 MB PDF can hold far more than is useful to embed). */
export const MAX_TEXT_CHARS = 2_000_000;

const TEXT_EXT = /\.(md|markdown|mdx|txt|text|csv|tsv|json|jsonl|ya?ml|toml|xml|log|rst|adoc|ini|ts|tsx|js|jsx|py|go|rs|java|rb|php|sql|sh|css)$/i;

export const DEFAULT_INCLUDE = ["*.md", "*.mdx", "*.markdown", "*.txt", "*.html", "*.htm", "*.pdf", "*.docx", "*.csv", "*.json"];

export type Extracted = { title: string | null; text: string } | { skipped: string };

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** The first markdown heading, as a title. */
const headingOf = (text: string) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;

export async function extract(key: string, bytes: Uint8Array, contentType: string | null): Promise<Extracted> {
  if (bytes.byteLength > MAX_FILE_BYTES) return { skipped: `over ${MAX_FILE_BYTES / 1024 / 1024} MB` };
  const name = key.split("/").pop() ?? key;
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  let title: string | null = null;
  let text: string;
  if (/\.pdf$/i.test(name) || type === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out = await extractText(pdf, { mergePages: false });
    text = (Array.isArray(out.text) ? out.text : [out.text]).join("\n\n");
  } else if (/\.docx$/i.test(name) || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  } else if (/\.html?$/i.test(name) || type === "text/html") {
    const page = htmlToMarkdown(decode(bytes), `https://storage.local/${encodeURI(key)}`);
    title = page.title;
    text = page.markdown;
  } else if (TEXT_EXT.test(name) || type.startsWith("text/") || type === "application/json") {
    text = decode(bytes);
    if (/\.(md|markdown|mdx)$/i.test(name)) title = headingOf(text);
  } else {
    return { skipped: "not a text, HTML, PDF, or docx file" };
  }
  if (text.includes("\u0000")) return { skipped: "looks binary" };
  return { title: title ?? name, text: text.slice(0, MAX_TEXT_CHARS) };
}

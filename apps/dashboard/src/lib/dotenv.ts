/**
 * `.env` text ↔ key/value pairs for the dashboard's env editors (hosting site env, secrets paste).
 * Unlike `parseDotenv` in shared (lenient, for files), this keeps unquoted values exactly as typed
 * (no trimming, no inline comments), reports every malformed line by number, and round-trips with
 * `toDotenv`.
 */
export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line the entry starts on. */
  line: number;
}

export interface DotenvError {
  line: number;
  message: string;
}

export interface DotenvResult {
  entries: DotenvEntry[];
  /** Last value wins, like every .env loader. */
  env: Record<string, string>;
  errors: DotenvError[];
  /** Keys set more than once (the later line wins). */
  duplicates: string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseEnvText(text: string): DotenvResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: DotenvEntry[] = [];
  const errors: DotenvError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const start = raw.trimStart();
    if (start === "" || start.startsWith("#")) continue;
    const body = start.startsWith("export ") ? start.slice(7).trimStart() : start;
    const at = body.indexOf("=");
    if (at < 0) {
      errors.push({ line: i + 1, message: `Line ${i + 1} has no "=": write KEY=value.` });
      continue;
    }
    const key = body.slice(0, at).trimEnd();
    if (!KEY.test(key)) {
      errors.push({ line: i + 1, message: `Line ${i + 1}: "${key.slice(0, 40)}" isn't a valid name (letters, digits, _ . -, not starting with a digit).` });
      continue;
    }
    const rest = body.slice(at + 1);
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // Quoted: may span lines; ends at the matching unescaped quote.
      let value = "";
      let j = 1;
      let text = rest;
      let lineNo = i;
      let closed = false;
      for (;;) {
        while (j < text.length) {
          const c = text[j]!;
          if (quote === '"' && c === "\\" && j + 1 < text.length) {
            const n = text[j + 1]!;
            value += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
            j += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          value += c;
          j++;
        }
        if (closed || lineNo + 1 >= lines.length) break;
        lineNo++;
        value += "\n";
        text = lines[lineNo]!;
        j = 0;
      }
      if (!closed) {
        errors.push({ line: i + 1, message: `Line ${i + 1}: the quoted value of ${key} is never closed.` });
        break;
      }
      const after = text.slice(j + 1).trim();
      if (after && !after.startsWith("#")) errors.push({ line: lineNo + 1, message: `Line ${lineNo + 1}: unexpected text after the closing quote of ${key}.` });
      entries.push({ key, value, line: i + 1 });
      i = lineNo;
      continue;
    }
    entries.push({ key, value: rest, line: i + 1 });
  }
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.key)) duplicates.add(e.key);
    seen.add(e.key);
    env[e.key] = e.value;
  }
  return { entries, env, errors, duplicates: [...duplicates] };
}

/** Quotes only values that need it, so plain values stay as typed. */
export function formatEnvValue(value: string): string {
  if (value === "") return "";
  const needsQuotes = /[\n\r\t"]/.test(value) || /^['"\s#]/.test(value) || /\s$/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export const toDotenv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${formatEnvValue(v)}`)
    .join("\n");

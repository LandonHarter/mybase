import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  sql: "SQL",
  env: ".env",
  dotenv: ".env",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  python: "Python",
  py: "Python",
  text: "Plain text",
  toml: "TOML",
  dockerfile: "Dockerfile",
};

/** `<password>`, `<site>`, `<your-domain>`: values the user still has to fill in. */
const PLACEHOLDER = /<[a-z][a-z0-9_ .-]*>/gi;

const KEYWORDS: Record<string, RegExp> = {
  ts: /\b(?:import|from|export|const|let|await|async|function|return|new|if|else|for|of|in|true|false|null|undefined|type|interface)\b/g,
  sql: /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|index|on|primary|key|references|not|null|default|and|or|order|by|limit|returning|alter|drop|grant|join|left|group)\b/gi,
};
const keywordsFor = (lang: string) => (["ts", "tsx", "js", "javascript", "typescript"].includes(lang) ? KEYWORDS.ts : lang === "sql" ? KEYWORDS.sql : null);

/**
 * Restrained highlighting: comments muted, strings and keywords lightly tinted, placeholders
 * underlined. No parser, no dependency; good enough for snippets, never for editing.
 */
function highlight(code: string, lang: string): ReactNode[] {
  const out: ReactNode[] = [];
  const keywords = keywordsFor(lang);
  const comment = lang === "bash" || lang === "sh" || lang === "shell" || lang === "env" || lang === "dotenv" || lang === "yaml" || lang === "toml" || lang === "python" ? /#[^\n]*/ : lang === "sql" ? /--[^\n]*/ : /\/\/[^\n]*/;
  const token = new RegExp(`(${comment.source})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(${PLACEHOLDER.source})`, "gi");
  let last = 0;
  let key = 0;
  const plain = (text: string) => {
    if (!keywords) return text;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const m of text.matchAll(keywords)) {
      parts.push(text.slice(at, m.index));
      parts.push(
        <span key={`k${key++}`} className="text-code-keyword">
          {m[0]}
        </span>,
      );
      at = m.index! + m[0].length;
    }
    parts.push(text.slice(at));
    return parts;
  };
  for (const m of code.matchAll(token)) {
    out.push(<Fragment key={`p${key++}`}>{plain(code.slice(last, m.index))}</Fragment>);
    if (m[1]) out.push(<span key={`c${key++}`} className="text-muted-foreground">{m[1]}</span>);
    else if (m[2]) out.push(<span key={`s${key++}`} className="text-code-string">{withPlaceholders(m[2], () => key++)}</span>);
    else out.push(<Placeholder key={`h${key++}`}>{m[3]}</Placeholder>);
    last = m.index! + m[0].length;
  }
  out.push(<Fragment key={`p${key++}`}>{plain(code.slice(last))}</Fragment>);
  return out;
}

function withPlaceholders(text: string, nextKey: () => number): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    parts.push(text.slice(at, m.index));
    parts.push(<Placeholder key={`h${nextKey()}`}>{m[0]}</Placeholder>);
    at = m.index! + m[0].length;
  }
  parts.push(text.slice(at));
  return parts;
}

const Placeholder = ({ children }: { children: ReactNode }) => (
  <span className="rounded-sm bg-warning/12 text-warning underline decoration-dotted underline-offset-2" title="Fill this in">
    {children}
  </span>
);

/** A best guess for snippets without a language: shell commands vs. TypeScript vs. .env. */
export function guessLang(code: string): string {
  const first = code.trimStart().split("\n")[0] ?? "";
  if (/^(mybase|docker|npm|npx|bun|bunx|curl|git|export |cd |psql|redis-cli|pnpm|yarn)\b/.test(first) || first.startsWith("#!") || first.startsWith("$ ")) return "bash";
  if (/^[A-Z_][A-Z0-9_]*=/.test(first)) return "env";
  if (/^\s*[{[]/.test(first)) return "json";
  if (/^\s*(select|insert|create|update|delete|alter|with)\b/i.test(first)) return "sql";
  if (first.startsWith("<")) return "html";
  return "ts";
}

/**
 * The one code block: language label, Copy, light highlighting. Snippets are personalized with
 * the real project/env/site names by the caller; anything left as `<placeholder>` is marked and
 * the copy button says "Copy template". Use it instead of a bare `<pre>`.
 */
export function CodeBlock({
  code,
  copyText,
  lang = "auto",
  className,
  title,
  copy = true,
  wrap = false,
}: {
  code: string;
  /** Preserve raw bytes when the displayed code is formatted for reading. */
  copyText?: string;
  lang?: string;
  className?: string;
  /** Shown in place of the language label ("app/api/cron/route.ts"). */
  title?: ReactNode;
  copy?: boolean;
  /** Wrap long lines instead of scrolling (one-line commands with long URLs). */
  wrap?: boolean;
}) {
  const { copied, copy: run } = useCopy(copyText ?? code);
  const language = lang === "auto" ? guessLang(code) : lang.toLowerCase();
  const template = PLACEHOLDER.test(code);
  PLACEHOLDER.lastIndex = 0;
  return (
    <figure className={cn("group/code min-w-0 overflow-hidden rounded-lg border bg-surface", className)}>
      <figcaption className="flex h-8 items-center justify-between gap-2 border-b pr-1 pl-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{title ?? LANGUAGE_LABELS[language] ?? language}</span>
        {copy && (
          <Button type="button" variant="ghost" size="xs" onClick={() => run(copyText ?? code, template ? "template" : "code")} className="text-muted-foreground" aria-label={template ? "Copy template" : "Copy code"}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : template ? "Copy template" : "Copy"}
          </Button>
        )}
      </figcaption>
      <pre className={cn("code-block overflow-x-auto px-3.5 py-3 [scrollbar-width:thin]", wrap && "break-all whitespace-pre-wrap")}>
        <code>{highlight(code, language)}</code>
      </pre>
    </figure>
  );
}

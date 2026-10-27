import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { docRoute, docSectionId, resolveDoc, type DocEntry } from "@/lib/docs";
import { href } from "@/lib/router";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  js: "JavaScript",
  json: "JSON",
  sh: "Shell",
  text: "Plain text",
  ts: "TypeScript",
  tsx: "TypeScript",
};

function textContent(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return textContent(child.props.children);
    return "";
  }).join("");
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // LAN installs may use plain HTTP, where the Clipboard API is unavailable.
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    textarea.remove();
  }
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const language = /language-([\w+-]+)/.exec(className ?? "")?.[1]?.toLowerCase() ?? "text";
  const code = textContent(children).replace(/\n$/, "");

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await copyText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the code and copy it by hand.");
    }
  }

  return (
    <figure className="my-5 overflow-hidden rounded-lg border bg-muted">
      <figcaption className="flex h-9 items-center justify-between border-b pl-3.5 pr-1">
        <span className="text-xs text-muted-foreground">{LANGUAGE_LABELS[language] ?? language}</span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label={copied ? "Code copied" : "Copy code"} className="size-7 text-muted-foreground">
          {copied ? <Check /> : <Copy />}
        </Button>
      </figcaption>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6">
        <code className={className}>{children}</code>
      </pre>
      <span className="sr-only" aria-live="polite">{copied ? "Code copied" : ""}</span>
    </figure>
  );
}

function Heading({ level, children, doc }: { level: 2 | 3; children?: ReactNode; doc: DocEntry }) {
  const Tag = level === 2 ? "h2" : "h3";
  const text = textContent(children).trim();
  const id = docSectionId(text);
  return (
    <Tag id={id} className="group">
      {children}
      <a
        href={href({ ...docRoute(doc), section: id })}
        aria-label={`Link to ${text}`}
        className="ml-2 inline-flex align-middle text-muted-foreground opacity-0 outline-none group-hover:opacity-100 focus-visible:rounded-sm focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Link2 className="size-3.5" aria-hidden="true" />
      </a>
    </Tag>
  );
}

export function DocMarkdown({ doc }: { doc: DocEntry }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        // The title comes from the catalog so navigation and search use the same text.
        h1: () => null,
        h2: ({ node: _node, ...props }) => <Heading level={2} doc={doc} {...props} />,
        h3: ({ node: _node, ...props }) => <Heading level={3} doc={doc} {...props} />,
        a({ node: _node, href: link, ...props }) {
          const match = link ? /^(?:\.\/)?([^/#]+)\.md$/.exec(link) : null;
          const target = match && resolveDoc(doc.service.id, match[1]!);
          const external = link?.startsWith("http://") || link?.startsWith("https://");
          return <a {...props} href={target ? href(docRoute(target.doc)) : link} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} />;
        },
        pre({ node: _node, children, ...props }) {
          if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
            return <CodeBlock className={children.props.className}>{children.props.children}</CodeBlock>;
          }
          return <pre {...props}>{children}</pre>;
        },
        table({ node: _node, ...props }) {
          return <div className="docs-table my-5 overflow-x-auto rounded-lg border"><table {...props} /></div>;
        },
      }}
    >
      {doc.markdown}
    </Markdown>
  );
}

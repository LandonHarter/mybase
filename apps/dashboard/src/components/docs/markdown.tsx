import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { docRoute, docSectionId, resolveDocLink, type DocEntry } from "@/lib/docs";
import { copyText } from "@/lib/clipboard";
import { href } from "@/lib/router";

function textContent(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return textContent(child.props.children);
    return "";
  }).join("");
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
          // `x.md#s` is a sibling page, `sdk/x.md` an SDK guide, `#s` a section of this page.
          const target = link ? resolveDocLink(doc, link) : null;
          const external = link?.startsWith("http://") || link?.startsWith("https://");
          return <a {...props} href={target ? href(target) : link} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} />;
        },
        pre({ node: _node, children, ...props }) {
          if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
            const lang = /language-([\w+-]+)/.exec(children.props.className ?? "")?.[1] ?? "text";
            return <CodeBlock code={textContent(children.props.children).replace(/\n$/, "")} lang={lang} className="my-5" />;
          }
          return <pre {...props}>{children}</pre>;
        },
        table({ node: _node, ...props }) {
          return <div className="my-5 overflow-x-auto rounded-lg border [scrollbar-width:thin]"><table {...props} /></div>;
        },
      }}
    >
      {doc.markdown}
    </Markdown>
  );
}

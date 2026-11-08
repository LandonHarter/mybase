import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  href: string;
}

/**
 * Title row for every page: breadcrumb, title, live facts (or a short description), and the page's
 * actions on the right (they wrap below on narrow screens). Titles are 20 px; `size="lg"` (24 px) is
 * for Projects and a project's Overview; `mono` is for item pages whose title is an identifier
 * (queue, key, site): 18 px mono, click to copy (D19).
 */
export function PageHeader({
  title,
  description,
  action,
  breadcrumb,
  mono = false,
  size = "md",
  aside,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Every level up, each linked: `[project, service]`. One crumb is fine. */
  breadcrumb?: Crumb | Crumb[];
  mono?: boolean;
  size?: "md" | "lg";
  /** Next to the title (a status dot, a badge). */
  aside?: ReactNode;
}) {
  const crumbs = breadcrumb ? (Array.isArray(breadcrumb) ? breadcrumb : [breadcrumb]) : [];
  const { copied, copy } = useCopy(title);
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-full">
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex flex-wrap items-center text-muted-foreground">
              {crumbs.map((c) => (
                <li key={c.href} className="flex min-w-0 items-center">
                  <a href={c.href} className="min-w-0 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    {c.label}
                  </a>
                  <span className="px-1.5" aria-hidden="true">
                    /
                  </span>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {mono ? (
            <h1 className="min-w-0 font-mono text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
              <button type="button" onClick={() => copy(title, "name")} className="group inline-flex max-w-full items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" title="Copy">
                <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
                <span className="text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100" aria-hidden>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </span>
                <span className="sr-only">(copy)</span>
              </button>
            </h1>
          ) : (
            <h1 className={cn("min-w-0 font-semibold tracking-tight [overflow-wrap:anywhere]", size === "lg" ? "text-2xl" : "text-xl")}>{title}</h1>
          )}
          {aside}
        </div>
        {description && <div className="mt-1 max-w-prose text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

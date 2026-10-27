import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { DocMarkdown } from "@/components/docs/markdown";
import { DocsOutline, DocsSidebar } from "@/components/docs/docs-sidebar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DEFAULT_DOC, docRoute, resolveDoc, type DocEntry } from "@/lib/docs";
import { SEARCH_SHORTCUT } from "@/lib/keys";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

function DocPager({ previous, next }: { previous?: DocEntry; next?: DocEntry }) {
  if (!previous && !next) return null;
  return (
    <nav aria-label="Adjacent guides" className="mt-10 grid gap-5 border-t pt-5 sm:grid-cols-2">
      {previous && (
        <a href={href(docRoute(previous))} className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowLeft className="size-3.5" /> Previous</span>
          <span className="font-medium">{previous.title}</span>
        </a>
      )}
      {next && (
        <a href={href(docRoute(next))} className={cn("rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-right", !previous && "sm:col-start-2")}>
          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground sm:justify-end">Next <ArrowRight className="size-3.5" /></span>
          <span className="font-medium">{next.title}</span>
        </a>
      )}
    </nav>
  );
}

export function DocsPage({ service, slug, section, onSearch }: { service: string; slug: string; section: string | null; onSearch: () => void }) {
  const resolved = resolveDoc(service, slug);
  const doc = resolved?.doc;

  useEffect(() => {
    if (section) {
      const frame = requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" }));
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo({ top: 0 });
  }, [service, slug, section]);

  return (
    <>
      <PageHeader
        title="Documentation"
        description="Guides and references for building with mybase."
        action={<Button variant="outline" onClick={onSearch}><Search /> Search docs <kbd className="ml-1 font-sans text-xs text-muted-foreground">{SEARCH_SHORTCUT}</kbd></Button>}
      />
      {doc ? (
        <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)] xl:grid-cols-[12rem_minmax(0,1fr)_10rem]">
          <DocsSidebar current={doc} />
          <div className="min-w-0">
            <article aria-labelledby="doc-title" className="docs-content min-w-0">
              <header className="mb-7 border-b pb-6">
                <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-muted-foreground">
                  <span>{doc.service.name}</span><span aria-hidden="true">/</span><span>{doc.section}</span>
                </nav>
                <h1 id="doc-title" className="text-xl font-semibold tracking-tight">{doc.title}</h1>
                <p className="mt-2 max-w-prose leading-6 text-muted-foreground">{doc.summary}</p>
              </header>
              <DocMarkdown doc={doc} />
            </article>
            <DocPager previous={resolved.previous} next={resolved.next} />
          </div>
          <DocsOutline doc={doc} currentSection={section} />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-6">
          <h2 className="text-base font-semibold">Guide not found</h2>
          <p className="mt-2 mb-4 text-muted-foreground">This service or documentation page does not exist. Return to the first guide to keep reading.</p>
          <Button variant="outline" asChild><a href={href(docRoute(DEFAULT_DOC))}>Back to documentation</a></Button>
        </div>
      )}
    </>
  );
}

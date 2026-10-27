import { useEffect } from "react";
import { Search } from "lucide-react";
import { CopyField } from "@/components/copy-field";
import { DocMarkdown } from "@/components/docs/markdown";
import { DocsOutline, DocsPicker } from "@/components/docs/docs-nav";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DOC_SERVICES, docRoute, resolveDoc, type DocEntry } from "@/lib/docs";
import { SEARCH_SHORTCUT } from "@/lib/keys";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

const DOCS_HOME = href({ page: "docs-home" });

/** Every service's guides, one row per section, in the same two-column shape as Settings. */
export function DocsHomePage({ onSearch }: { onSearch: () => void }) {
  return (
    <>
      <PageHeader
        title="Documentation"
        description="How to connect your apps to mybase and use each service from code."
        action={
          <Button variant="outline" onClick={onSearch}>
            <Search />
            Search docs
            <kbd className="ml-1 font-sans text-xs text-muted-foreground">{SEARCH_SHORTCUT}</kbd>
          </Button>
        }
      />
      {DOC_SERVICES.map((service) => (
        <section key={service.id} aria-labelledby={`docs-${service.id}`} className="mb-10 last:mb-0">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <h2 id={`docs-${service.id}`} className="text-base font-semibold">
                {service.name}
                {service.version && <span className="ml-2 text-sm font-normal text-muted-foreground">v{service.version}</span>}
              </h2>
              <p className="mt-1 max-w-prose text-muted-foreground">{service.description}</p>
            </div>
            {service.packageName && (
              <div className="w-full sm:w-80">
                <CopyField id={`docs-install-${service.id}`} label="Install" value={`npm install ${service.packageName}`} />
              </div>
            )}
          </div>
          {service.sections.map((section) => (
            <div key={section.label} className="grid gap-x-8 gap-y-3 border-t py-5 md:grid-cols-[14rem_minmax(0,1fr)]">
              <h3 className="text-muted-foreground">{section.label}</h3>
              <ul className="grid gap-4">
                {section.docs.map((doc) => (
                  <li key={doc.slug}>
                    <a
                      href={href(docRoute({ service, slug: doc.slug }))}
                      className="rounded-sm font-medium underline decoration-transparent underline-offset-4 outline-none hover:decoration-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {doc.title}
                    </a>
                    <p className="mt-0.5 max-w-prose text-muted-foreground">{doc.summary}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function PagerLink({ doc, direction }: { doc: DocEntry; direction: "Previous" | "Next" }) {
  return (
    <a
      href={href(docRoute(doc))}
      rel={direction === "Previous" ? "prev" : "next"}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border px-4 py-3 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        direction === "Next" && "sm:col-start-2 sm:items-end sm:text-right",
      )}
    >
      <span className="text-xs text-muted-foreground">{direction}</span>
      <span className="font-medium">{doc.title}</span>
    </a>
  );
}

export function DocsPage({ service, slug, section }: { service: string; slug: string; section: string | null }) {
  const resolved = resolveDoc(service, slug);
  const doc = resolved?.doc;

  useEffect(() => {
    if (section) {
      const frame = requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" }));
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo({ top: 0 });
  }, [service, slug, section]);

  if (!doc) {
    return (
      <>
        <PageHeader breadcrumb={{ label: "Documentation", href: DOCS_HOME }} title="Guide not found" />
        <div className="rounded-lg border border-dashed p-6">
          <p className="mb-4 max-w-prose text-muted-foreground">
            There's no guide at this address. It may have been renamed. Pick one from the documentation index.
          </p>
          <Button variant="outline" asChild>
            <a href={DOCS_HOME}>Open documentation</a>
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader breadcrumb={{ label: "Documentation", href: DOCS_HOME }} title={doc.title} description={doc.summary} />
      <DocsPicker current={doc} />
      <div className="grid gap-12 xl:grid-cols-[minmax(0,40rem)_11rem]">
        <div className="min-w-0 max-w-[40rem]">
          <article aria-label={doc.title} className="docs-content">
            <DocMarkdown doc={doc} />
          </article>
          {(resolved.previous || resolved.next) && (
            <nav aria-label="More guides" className="mt-12 grid gap-3 sm:grid-cols-2">
              {resolved.previous && <PagerLink doc={resolved.previous} direction="Previous" />}
              {resolved.next && <PagerLink doc={resolved.next} direction="Next" />}
            </nav>
          )}
        </div>
        <DocsOutline key={`${service}/${slug}`} doc={doc} initialSection={section} />
      </div>
    </>
  );
}

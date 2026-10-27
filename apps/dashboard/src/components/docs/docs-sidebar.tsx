import { BookOpen, ChevronDown, Package } from "lucide-react";
import { DOC_SERVICES, DOCS, docRoute, docSections, type DocEntry } from "@/lib/docs";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

export function DocsSidebar({ current }: { current: DocEntry }) {
  return (
    <>
      <div className="relative mb-6 lg:hidden">
        <label htmlFor="docs-guide" className="sr-only">Documentation guide</label>
        <select
          id="docs-guide"
          value={`${current.service.id}/${current.slug}`}
          onChange={(event) => {
            const doc = DOCS.find((item) => `${item.service.id}/${item.slug}` === event.target.value);
            if (doc) navigate(docRoute(doc));
          }}
          className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {DOC_SERVICES.flatMap((service) =>
            service.sections.map((section) => (
              <optgroup key={`${service.id}/${section.label}`} label={`${service.name} — ${section.label}`}>
                {section.docs.map((doc) => (
                  <option key={doc.slug} value={`${service.id}/${doc.slug}`}>{doc.title}</option>
                ))}
              </optgroup>
            )),
          )}
        </select>
        <ChevronDown className="pointer-events-none absolute top-2.5 right-3 size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <aside className="min-w-0 max-lg:hidden">
        <nav aria-label="Documentation guides" className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto border-r pr-5 [scrollbar-width:thin]">
          {DOC_SERVICES.map((service) => (
            <section key={service.id} aria-labelledby={`docs-service-${service.id}`} className="mb-7 last:mb-0">
              <div className="mb-4 flex items-start gap-2.5 px-2.5">
                {service.packageName ? <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div className="min-w-0">
                  <h2 id={`docs-service-${service.id}`} className="truncate text-sm font-semibold">{service.name}</h2>
                  {service.packageName ? (
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={`${service.packageName} ${service.version ?? ""}`}>
                      {service.packageName}{service.version ? ` · v${service.version}` : ""}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">{service.description}</p>
                  )}
                </div>
              </div>
              {service.sections.map((section) => (
                <div key={section.label} className="mb-4 last:mb-0">
                  <h3 className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">{section.label}</h3>
                  <ul className="space-y-0.5">
                    {section.docs.map((doc) => {
                      const active = service.id === current.service.id && doc.slug === current.slug;
                      return (
                        <li key={doc.slug}>
                          <a
                            href={href(docRoute({ service, slug: doc.slug }))}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "relative flex min-h-8 items-center rounded-md px-2.5 py-1.5 leading-5 text-muted-foreground outline-none",
                              "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                              active && "bg-accent font-medium text-foreground before:absolute before:inset-y-1.5 before:-left-px before:w-0.5 before:rounded-full before:bg-primary",
                            )}
                          >
                            {doc.title}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </nav>
      </aside>
    </>
  );
}

export function DocsOutline({ doc, currentSection }: { doc: DocEntry; currentSection: string | null }) {
  const sections = docSections(doc.markdown);
  if (sections.length === 0) return null;
  return (
    <aside className="min-w-0 max-xl:hidden">
      <nav aria-label="On this page" className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto pl-1 [scrollbar-width:thin]">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">On this page</h2>
        <ul>
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={href({ ...docRoute(doc), section: section.id })}
                aria-current={currentSection === section.id ? "location" : undefined}
                className={cn(
                  "block border-l py-1.5 text-xs leading-5 text-muted-foreground outline-none hover:border-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  section.level === 3 ? "pl-6" : "pl-3",
                  currentSection === section.id && "border-foreground font-medium text-foreground",
                )}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

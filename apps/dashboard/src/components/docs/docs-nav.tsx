import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DOC_SERVICES, DOCS, docRoute, docSections, type DocEntry } from "@/lib/docs";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Small screens: the rail can't hold the guide list, so a native picker stands in for it. */
export function DocsPicker({ current }: { current: DocEntry }) {
  return (
    <div className="relative mb-6 md:hidden">
      <label htmlFor="docs-guide" className="sr-only">Guide</label>
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
            <optgroup key={`${service.id}/${section.label}`} label={DOC_SERVICES.length > 1 ? `${service.name}: ${section.label}` : section.label}>
              {section.docs.map((doc) => (
                <option key={doc.slug} value={`${service.id}/${doc.slug}`}>{doc.title}</option>
              ))}
            </optgroup>
          )),
        )}
      </select>
      <ChevronDown className="pointer-events-none absolute top-2.5 right-3 size-4 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

/** The heading the reader is in: the last one scrolled past the top quarter of the window. */
function useCurrentSection(ids: string[], initial: string | null) {
  const [current, setCurrent] = useState(initial ?? ids[0] ?? null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight / 4;
      let found = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) found = id;
      }
      // At the very bottom, short last sections can never reach the line; pick the last one.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) found = ids.at(-1) ?? found;
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids.join("\n")]);
  return current;
}

export function DocsOutline({ doc, initialSection }: { doc: DocEntry; initialSection: string | null }) {
  const sections = docSections(doc.markdown);
  const current = useCurrentSection(sections.map((s) => s.id), initialSection);
  if (sections.length < 2) return null;
  return (
    <aside className="min-w-0 max-xl:hidden">
      <nav aria-label="On this page" className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto [scrollbar-width:thin]">
        <h2 className="mb-2 text-xs text-muted-foreground">On this page</h2>
        <ul className="border-l">
          {sections.map((section) => {
            const active = current === section.id;
            return (
              <li key={section.id}>
                <a
                  href={href({ ...docRoute(doc), section: section.id })}
                  aria-current={active ? "location" : undefined}
                  className={cn(
                    "-ml-px block border-l border-transparent py-1 text-[13px] leading-5 text-muted-foreground outline-none",
                    "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    section.level === 3 ? "pl-6" : "pl-3",
                    active && "border-foreground text-foreground",
                  )}
                >
                  {section.title}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

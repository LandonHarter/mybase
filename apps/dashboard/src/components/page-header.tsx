import type { ReactNode } from "react";

/** Title row for every page: name on the left, the page's main action on the right. */
export function PageHeader({
  title,
  description,
  action,
  breadcrumb,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** For pages inside a project: a link back up, shown above the title. */
  breadcrumb?: { label: string; href: string };
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {breadcrumb && (
          <a href={breadcrumb.href} className="mb-1 inline-block text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
            {breadcrumb.label}
            <span className="px-1.5" aria-hidden="true">
              /
            </span>
          </a>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-muted-foreground">{description}</p>}
      </div>
      {action}
    </header>
  );
}

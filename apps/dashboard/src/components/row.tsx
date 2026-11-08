import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A settings-style row: label + hint on the left, content on the right (stacks on small screens).
 * `id` makes it a deep-link target (`?s=<id>` lands on `s-<id>`); `htmlFor` labels a single control.
 */
export function Row({ title, hint, children, id, className }: { title: string; hint: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <div data-row-layout="" id={id ? `s-${id}` : undefined} className={cn("grid scroll-mt-6 gap-3 rounded-sm border-t py-5 sm:grid-cols-[14rem_1fr] sm:gap-8", className)}>
      <div>
        <h3 className="font-medium">{title}</h3>
        <div className="mt-0.5 text-muted-foreground">{hint}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

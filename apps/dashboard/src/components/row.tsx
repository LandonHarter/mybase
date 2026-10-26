import type { ReactNode } from "react";

/** A settings-style row: label + hint on the left, content on the right (stacks on small screens). */
export function Row({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3 border-t py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-0.5 text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

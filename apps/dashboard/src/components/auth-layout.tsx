import type { ReactNode } from "react";

/** The frame for screens shown before signing in: no rail, one narrow column. */
export function AuthLayout({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-sm px-4 pt-[12vh] pb-10">
      <p className="mb-8 text-base font-semibold tracking-tight">mybase</p>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 mb-6 text-muted-foreground">{description}</p>
      {children}
    </main>
  );
}

import { ChevronRight, Plug } from "lucide-react";
import { useState, type ReactNode } from "react";
import { RoutedTabs } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { href, viewHref, type Route, type ServiceView } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * The service header's Connect button and its sheet (D6): how an app reaches this service, with
 * the real names filled in and Copy on everything. Settings belong in the Settings tab, not here.
 */
export function ConnectSheet({ title, description, children, label = "Connect", open: controlled, onOpenChange }: { title: string; description?: ReactNode; children: ReactNode; label?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plug />
        {label}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent wide>
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : <SheetDescription className="sr-only">How to connect an app</SheetDescription>}
          </SheetHeader>
          <SheetBody className="grid content-start gap-6 sm:[&_[data-row-layout]]:grid-cols-1 [&_[data-row-layout]]:gap-2 [&_[data-row-layout]]:py-4 [&_[data-row-layout]:first-child]:border-t-0 [&_[data-row-layout]:first-child]:pt-0">{children}</SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** One method inside a Connect sheet ("TypeScript SDK", "Over TCP"). */
export function ConnectMethod({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="font-medium">{title}</h3>
      {hint && <div className="text-muted-foreground">{hint}</div>}
      <div className="grid min-w-0 gap-3">{children}</div>
    </section>
  );
}

/**
 * The tab bar of a service page with a Settings view (A03): the service's main view and its
 * Settings (with the danger zone). `extra` adds tabs before Settings.
 */
export function ServiceViews({ route, view, label, main = "Overview", extra = [] }: { route: Route; view: ServiceView | null; label: string; main?: string; extra?: { id: string; label: string; href: string }[] }) {
  return (
    <RoutedTabs
      label={label}
      current={view ?? "main"}
      tabs={[{ id: "main", label: main, href: href(route) }, ...extra, { id: "settings", label: "Settings", href: viewHref(route, "settings") }]}
    />
  );
}

/**
 * The danger zone in a service's Settings view: "Delete [service] data and turn off…" with what
 * it removes (D5). Never on the service's first screen.
 */
export function DangerZone({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
  return (
    <section aria-labelledby="danger" className="mt-8">
      <h2 id="danger" className="mb-2 text-base font-semibold">
        {title}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-destructive/30 p-4">
        <div className="max-w-prose text-muted-foreground">{children}</div>
        {action}
      </div>
    </section>
  );
}

/** A live preview panel on the project Overview: title linking to the service, real numbers below. */
export function Panel({ title, icon: Icon, to, children, action, className }: { title: string; icon: typeof Plug; to: Route; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={cn("relative flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-4", className)} aria-label={title}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <a href={href(to)} className="group flex min-w-0 items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="truncate">{title}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </a>
        {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

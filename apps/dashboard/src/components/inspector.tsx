import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * The one inspector (D15): a right sheet for a file, row, queue message, vector document, audit
 * event, cron task, registry tag or sandbox artifact. Header = the identifier + Copy, body = typed
 * content, footer = actions. Open it from a row's name or expand control; Esc closes.
 */
export function Inspector({
  open,
  onOpenChange,
  kind,
  identifier,
  copyValue,
  description,
  actions,
  wide = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What it is: "File", "Row", "Message". */
  kind: string;
  /** The object's identifier, shown mono with a Copy button. */
  identifier: string;
  /** What Copy copies, when it isn't `identifier`. */
  copyValue?: string;
  description?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const { copied, copy } = useCopy(identifier);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent wide={wide} aria-describedby={description ? undefined : undefined}>
        <SheetHeader>
          <p className="text-xs font-medium text-muted-foreground">{kind}</p>
          <div className="flex min-w-0 items-start gap-1">
            <SheetTitle className="mono-value min-w-0 text-[15px] font-medium [overflow-wrap:anywhere]">{identifier}</SheetTitle>
            <Button type="button" variant="ghost" size="icon-xs" className="mt-0.5 shrink-0" aria-label={`Copy ${kind.toLowerCase()} ${identifier}`} onClick={() => copy(copyValue ?? identifier, kind.toLowerCase())}>
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          {description ? <SheetDescription>{description}</SheetDescription> : <SheetDescription className="sr-only">{kind} details</SheetDescription>}
        </SheetHeader>
        <SheetBody>{children}</SheetBody>
        {actions && <SheetFooter>{actions}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}

/** Label/value pairs inside an inspector or detail view. */
export function Facts({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The native select, styled like an Input (D24: native, so it works with the keyboard, phones and
 * screen readers; `color-scheme` themes the option menu). Children are `<option>`s.
 */
function Select({ className, wrapperClassName, ...props }: React.ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <span className={cn("relative inline-flex min-w-0", wrapperClassName)}>
      <select
        data-slot="select"
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-1 pr-8 pl-3 text-base outline-none transition-colors duration-150 md:text-sm dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
          className,
        )}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </span>
  );
}

export { Select };

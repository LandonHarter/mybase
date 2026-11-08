import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const MASK = "••••••••••••••••";

/**
 * A labelled value with a Copy button: for anything the user pastes into an app. The value is
 * plain selectable text (not an input). `secret` masks it until the user reveals it.
 */
export function CopyField({ id, label, value, secret = false, className }: { id: string; label: string; value: string; secret?: boolean; className?: string }) {
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopy(value);
  const hidden = secret && !revealed;

  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/30 py-0.5 pr-0.5 pl-3">
        <span
          id={id}
          aria-labelledby={`${id}-label`}
          className={cn("min-w-0 font-mono text-[13px] flex-1 py-1.5 break-all select-text", hidden && "text-muted-foreground select-none")}
        >
          {hidden ? MASK : value}
        </span>
        {secret && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setRevealed(!revealed)} aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
            {revealed ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => copy(value, label.toLowerCase())} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check /> : <Copy />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

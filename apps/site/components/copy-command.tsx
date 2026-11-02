"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A shell command on one line, with a Copy button. Scrolls sideways instead of wrapping. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex min-w-0 items-center rounded-lg border border-fd-border bg-fd-card font-mono text-[13px]">
      <span className="select-none py-2.5 pl-3.5 pr-2 text-fd-muted-foreground" aria-hidden="true">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2.5 [scrollbar-width:none]">{command}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className="m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-fd-ring"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

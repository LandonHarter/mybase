import { Check, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The delete model for one row, message, key or file (DESIGN.md "Delete"): a trash button that
 * turns into "Delete? ✓ ✕" in place. It falls back after 3 s, shows "Deleting…" while pending,
 * and keeps a failure next to the row. Never bound to a single key.
 */
export function InlineDelete({
  label,
  onDelete,
  className,
  question = "Delete?",
}: {
  /** Names the object: "Delete message 3f2a…". */
  label: string;
  /** Throws on failure; the error stays next to the button. */
  onDelete: () => Promise<void>;
  className?: string;
  question?: string;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(timer.current);
    },
    [],
  );

  function ask() {
    setError(null);
    setStep("confirm");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStep((s) => (s === "confirm" ? "idle" : s)), 3000);
  }
  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
  }, [step]);

  async function run() {
    clearTimeout(timer.current);
    setStep("pending");
    try {
      await onDelete();
      if (mounted.current) setStep("idle");
    } catch (err) {
      if (!mounted.current) return;
      setError(errorMessage(err));
      setStep("idle");
    }
  }

  return (
    <span className={cn("inline-flex items-center justify-end gap-1", className)}>
      {error && (
        <span role="alert" className="max-w-56 truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
      {step === "idle" && (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={ask}>
          <Trash2 />
        </Button>
      )}
      {step === "confirm" && (
        <span className="inline-flex items-center gap-0.5" role="group" aria-label={label}>
          <span className="pr-1 text-xs font-medium text-destructive">{question}</span>
          <Button ref={confirmRef} type="button" variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={`Confirm: ${label}`} onClick={run}>
            <Check />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel" onClick={() => setStep("idle")}>
            <X />
          </Button>
        </span>
      )}
      {step === "pending" && (
        <span className="inline-flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground" aria-live="polite">
          <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
          Deleting…
        </span>
      )}
    </span>
  );
}

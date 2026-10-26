import { Check } from "lucide-react";
import { ACCENTS, useTheme, type Accent } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const ACCENT_LABELS: Record<Accent, string> = {
  moss: "Moss",
  cobalt: "Cobalt",
  raspberry: "Raspberry",
  amber: "Amber",
  graphite: "Graphite",
};

/** Swatches render inside their own data-accent scope so each shows its real color in the current mode. */
export function AccentPicker() {
  const { accent, setAccent } = useTheme();
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2">
      {ACCENTS.map((a) => {
        const selected = a === accent;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setAccent(a)}
            data-accent={a}
            className={cn(
              "flex h-9 items-center gap-2 rounded-md border pr-3 pl-2 outline-none",
              "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
              selected && "border-foreground/40 bg-accent",
            )}
          >
            <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
              {selected && <Check className="size-3" strokeWidth={3} />}
            </span>
            {ACCENT_LABELS[a]}
          </button>
        );
      })}
    </div>
  );
}

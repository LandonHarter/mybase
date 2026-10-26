import type { ReactNode } from "react";
import { AccentPicker } from "@/components/accent-picker";
import { MODE_LABELS } from "@/components/mode-menu";
import { PageHeader } from "@/components/page-header";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { MODES, useTheme, type Mode } from "@/lib/theme";

/** A setting: label + hint on the left, control on the right (stacks on small screens). */
function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 border-t py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-0.5 text-muted-foreground">{hint}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  return (
    <>
      <PageHeader title="Settings" />
      <section aria-labelledby="appearance">
        <h2 id="appearance" className="mb-3 text-base font-semibold">
          Appearance
        </h2>
        <Row title="Color mode" hint="Saved in this browser.">
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} className="gap-2.5">
            {MODES.map((m) => (
              <div key={m} className="flex items-center gap-2">
                <RadioGroupItem id={`mode-${m}`} value={m} />
                <Label htmlFor={`mode-${m}`} className="font-normal">
                  {MODE_LABELS[m]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Row>
        <Row title="Accent color" hint="Used for the main button, focus rings, and the current page.">
          <AccentPicker />
        </Row>
      </section>
    </>
  );
}

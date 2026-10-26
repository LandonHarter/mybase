import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODES, useTheme, type Mode } from "@/lib/theme";

export const MODE_LABELS: Record<Mode, string> = { light: "Light", dark: "Dark", system: "Match system" };
const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Quick light/dark switch. Full appearance options live on the Settings page. */
export function ModeMenu() {
  const { mode, setMode } = useTheme();
  const Icon = MODE_ICONS[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Color mode: ${MODE_LABELS[mode]}`}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)}>
          {MODES.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {MODE_LABELS[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

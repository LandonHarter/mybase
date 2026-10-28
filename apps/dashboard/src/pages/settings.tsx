import { AccentPicker } from "@/components/accent-picker";
import { AccountSettings } from "@/components/account-settings";
import { AgentSetup } from "@/components/agent-setup";
import { ApiTokens } from "@/components/api-tokens";
import { MODE_LABELS } from "@/components/mode-menu";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAuth } from "@/lib/auth";
import { navigate } from "@/lib/router";
import { MODES, useTheme, type Mode } from "@/lib/theme";

export function SettingsPage({ newToken }: { newToken: boolean }) {
  const { mode, setMode } = useTheme();
  const auth = useAuth();
  return (
    <>
      <PageHeader title="Settings" />
      {auth.status === "ready" && auth.username && <AccountSettings username={auth.username} mfa={auth.mfa} />}
      <ApiTokens createOpen={newToken} onCreateOpenChange={(open) => navigate({ page: "settings", newToken: open }, { replace: true })} />
      <AgentSetup />
      <section aria-labelledby="appearance" className="mt-10">
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

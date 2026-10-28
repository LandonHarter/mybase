import { useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import type { MfaStatus, TotpSetupResponse } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { refreshAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/load";

const ErrorLine = ({ id, error }: { id: string; error: string | null }) =>
  error ? (
    <p id={id} role="alert" className="text-destructive">
      {error}
    </p>
  ) : null;

function CodeInput({ id, label = "Code", error, autoFocus = false }: { id: string; label?: string; error: string | null; autoFocus?: boolean }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name="code"
        required
        autoFocus={autoFocus}
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={20}
        placeholder="123456"
        className="font-mono"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </div>
  );
}

/** The codes, once, with copy and download: they're never shown again. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = `mybase recovery codes (each works once)\n\n${codes.join("\n")}\n`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the codes and copy them by hand.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "mybase-recovery-codes.txt" });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-3">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border p-4 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          Copy codes
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download />
          Download
        </Button>
      </div>
    </div>
  );
}

function Qr({ uri }: { uri: string }) {
  const svg = useMemo(() => renderSVG(uri, { border: 2 }), [uri]);
  // Scanners need dark modules on a light background, whatever the color mode: the one place a fixed white is right.
  return <div className="size-44 overflow-hidden rounded-md bg-white [&>svg]:size-full" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: svg }} />;
}

type SetupStep = { step: "password" } | { step: "scan"; setup: TotpSetupResponse } | { step: "codes"; codes: string[] };

function TurnOnDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<SetupStep>({ step: "password" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close(next: boolean) {
    if (pending) return;
    onOpenChange(next);
    if (!next) {
      // Codes were shown: 2FA is on now, and the page should say so.
      if (state.step === "codes") void refreshAuth();
      setState({ step: "password" });
      setError(null);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<void>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await action(form);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {state.step === "password" && (
          <form
            onSubmit={(e) => submit(e, async (form) => setState({ step: "scan", setup: await api.startTotp(String(form.get("password") ?? "")) }))}
            className="grid gap-5"
          >
            <DialogHeader className="text-left">
              <DialogTitle>Turn on 2FA</DialogTitle>
              <DialogDescription>Signing in will also need a code from an authenticator app. Enter your password to start.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="mfa-password">Password</Label>
              <Input
                id="mfa-password"
                name="password"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "mfa-password-error" : undefined}
              />
              <ErrorLine id="mfa-password-error" error={error} />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Checking…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {state.step === "scan" && (
          <form
            onSubmit={(e) => submit(e, async (form) => setState({ step: "codes", codes: (await api.confirmTotp(String(form.get("code") ?? "").trim())).codes }))}
            className="grid gap-5"
          >
            <DialogHeader className="text-left">
              <DialogTitle>Scan with your authenticator app</DialogTitle>
              <DialogDescription>Any TOTP app works (1Password, Bitwarden, Google Authenticator, …). Then enter the code it shows.</DialogDescription>
            </DialogHeader>
            <Qr uri={state.setup.uri} />
            <CopyField id="mfa-secret" label="Or enter this key by hand" value={state.setup.secret} />
            <CodeInput id="mfa-confirm-code" error={error} autoFocus />
            <ErrorLine id="mfa-confirm-code-error" error={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Turning on…" : "Turn on 2FA"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {state.step === "codes" && (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>
                2FA is on, and other browsers were signed out. If you lose your phone, each code signs you in once. They won't be shown again.
              </DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={state.codes} />
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                I saved them
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCodesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close(next: boolean) {
    if (pending) return;
    onOpenChange(next);
    if (!next) {
      if (codes) void refreshAuth();
      setCodes(null);
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setPending(true);
    setError(null);
    try {
      setCodes((await api.regenerateRecoveryCodes(code)).codes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {codes ? (
          <div className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Save your new recovery codes</DialogTitle>
              <DialogDescription>The old codes no longer work. These won't be shown again.</DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} />
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                I saved them
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-5">
            <DialogHeader className="text-left">
              <DialogTitle>Get new recovery codes</DialogTitle>
              <DialogDescription>Replaces all your recovery codes, used or not. Enter a code from your authenticator app.</DialogDescription>
            </DialogHeader>
            <CodeInput id="mfa-regen-code" error={error} autoFocus />
            <ErrorLine id="mfa-regen-code-error" error={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Checking…" : "Get new codes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TurnOffDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.disableTotp(String(form.get("password") ?? ""), String(form.get("code") ?? "").trim());
      onOpenChange(false);
      toast.success("Turned off 2FA");
      await refreshAuth();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>Turn off 2FA</DialogTitle>
            <DialogDescription>Signing in will need only the password again. Your recovery codes stop working.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="mfa-off-password">Password</Label>
            <Input id="mfa-off-password" name="password" type="password" required autoFocus autoComplete="current-password" />
          </div>
          <CodeInput id="mfa-off-code" label="Code or recovery code" error={error} />
          <ErrorLine id="mfa-off-code-error" error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Turning off…" : "Turn off 2FA"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Settings row for the admin's second factor. `mfa` comes from `/auth/me`. */
export function TwoFactor({ mfa }: { mfa: MfaStatus | undefined }) {
  const [dialog, setDialog] = useState<"on" | "codes" | "off" | null>(null);
  const opener = (name: "on" | "codes" | "off") => (open: boolean) => setDialog(open ? name : null);
  const on = mfa?.totp ?? false;

  return (
    <Row title="Two-factor authentication" hint="Sign-ins also need a code from an authenticator app. API tokens keep working without one.">
      {on ? (
        <>
          <p className="mb-3">
            <span className="font-medium">On.</span>{" "}
            <span className={mfa!.recoveryCodesLeft <= 2 ? "text-destructive" : "text-muted-foreground"}>
              {mfa!.recoveryCodesLeft === 1 ? "1 recovery code left." : `${mfa!.recoveryCodesLeft} recovery codes left.`}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog("codes")}>
              Get new recovery codes
            </Button>
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
              Turn off 2FA
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-muted-foreground">Off. Anyone with the password can sign in.</p>
          <Button variant="outline" onClick={() => setDialog("on")}>
            Turn on 2FA
          </Button>
        </>
      )}
      <TurnOnDialog open={dialog === "on"} onOpenChange={opener("on")} />
      <NewCodesDialog open={dialog === "codes"} onOpenChange={opener("codes")} />
      <TurnOffDialog open={dialog === "off"} onOpenChange={opener("off")} />
    </Row>
  );
}

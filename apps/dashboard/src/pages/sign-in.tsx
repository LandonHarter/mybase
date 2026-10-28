import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { refreshAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";

// Anything loaded while signed out failed; load it again.
const signedIn = () => Promise.all([refreshAuth(), refreshProjects()]);

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set once the password checked out and 2FA is on.
  const [challenge, setChallenge] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await api.login({ username: String(form.get("username") ?? "").trim(), password: String(form.get("password") ?? "") });
      if (res.mfaRequired && res.challenge) {
        setChallenge(res.challenge);
        setPending(false);
        return;
      }
      await signedIn();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  if (challenge) {
    return (
      <CodeStep
        challenge={challenge}
        onBack={() => {
          setChallenge(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <AuthLayout title="Sign in" description="Use the admin account for this server.">
      <form onSubmit={onSubmit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="username">Username</Label>
          <Input id="username" name="username" required autoFocus autoComplete="username" spellCheck={false} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          {error && (
            <p id="sign-in-error" role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}

function CodeStep({ challenge, onBack }: { challenge: string; onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recovery, setRecovery] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setPending(true);
    setError(null);
    try {
      await api.loginMfa({ challenge, code });
      await signedIn();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Enter your code"
      description={recovery ? "Use one of the recovery codes you saved. Each works once." : "Open your authenticator app and enter the 6-digit code for mybase."}
    >
      <form onSubmit={onSubmit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="code">{recovery ? "Recovery code" : "Code"}</Label>
          <Input
            key={recovery ? "recovery" : "totp"}
            id="code"
            name="code"
            required
            autoFocus
            autoComplete={recovery ? "off" : "one-time-code"}
            inputMode={recovery ? "text" : "numeric"}
            pattern={recovery ? undefined : "[0-9 ]{6,7}"}
            maxLength={recovery ? 20 : 7}
            spellCheck={false}
            placeholder={recovery ? "XXXX-XXXX-XXXX" : "123456"}
            className="font-mono"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "code-error" : undefined}
          />
          {error && (
            <p id="code-error" role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Checking…" : "Sign in"}
        </Button>
        <div className="flex justify-between">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRecovery(!recovery);
              setError(null);
            }}
          >
            {recovery ? "Use a code from the app" : "Use a recovery code"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

import { useState, type FormEvent } from "react";
import { ADMIN_PASSWORD_MIN } from "@mybase/shared";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { refreshAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";

/** First run: create the one admin account. The API only allows this from this machine or the LAN. */
export function SetupPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirm")) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.setup({ username: String(form.get("username") ?? "").trim(), password });
      await Promise.all([refreshAuth(), refreshProjects()]);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Create the admin account"
      description="This is the only account on this server. It signs in to the dashboard and the CLI."
    >
      <form onSubmit={onSubmit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="username">Username</Label>
          <Input id="username" name="username" required autoFocus defaultValue="admin" autoComplete="username" spellCheck={false} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" aria-describedby="password-hint" />
          <p id="password-hint" className="text-muted-foreground">
            At least {ADMIN_PASSWORD_MIN} characters. Use a long one if this server is reachable from the internet.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            required
            autoComplete="new-password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "setup-error" : undefined}
          />
          {error && (
            <p id="setup-error" role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Creating…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}

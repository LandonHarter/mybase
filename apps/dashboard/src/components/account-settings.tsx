import { useState, type FormEvent } from "react";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { ADMIN_PASSWORD_MIN } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { refreshAuth, signOut } from "@/lib/auth";
import { errorMessage } from "@/lib/load";

function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const newPassword = String(form.get("new-password") ?? "");
    if (newPassword !== form.get("confirm-password")) {
      setError("The new passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.changePassword({ currentPassword: String(form.get("current-password") ?? ""), newPassword });
      formEl.reset();
      toast.success("Changed password");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-sm gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input id="current-password" name="current-password" type="password" required autoComplete="current-password" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" name="new-password" type="password" required minLength={ADMIN_PASSWORD_MIN} autoComplete="new-password" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          name="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "password-error" : undefined}
        />
      </div>
      {error && (
        <p id="password-error" role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

export function AccountSettings({ username }: { username: string }) {
  const [everywhereOpen, setEverywhereOpen] = useState(false);

  async function signOutEverywhere() {
    try {
      await api.logoutEverywhere();
      await refreshAuth();
    } catch (err) {
      toast.error(`Couldn't sign out: ${errorMessage(err)}`);
    }
  }

  return (
    <section aria-labelledby="account">
      <h2 id="account" className="mb-3 text-base font-semibold">
        Account
      </h2>
      <Row title="Signed in as" hint="The admin account for this server.">
        <p className="mb-3 font-medium">{username}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={signOut}>
            <LogOut />
            Sign out
          </Button>
          <Button variant="ghost" onClick={() => setEverywhereOpen(true)}>
            Sign out everywhere
          </Button>
        </div>
      </Row>
      <Row title="Password" hint="Changing it signs out every other browser. API tokens keep working.">
        <ChangePasswordForm />
      </Row>
      <ConfirmDialog
        open={everywhereOpen}
        onOpenChange={setEverywhereOpen}
        title="Sign out everywhere"
        description="Signs out every browser, this one included. API tokens keep working; revoke them below."
        confirm="Sign out everywhere"
        pendingLabel="Signing out…"
        onConfirm={signOutEverywhere}
        destructive={false}
      />
    </section>
  );
}

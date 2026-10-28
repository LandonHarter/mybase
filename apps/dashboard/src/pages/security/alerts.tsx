import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { AlertChannel, AlertChannelKind } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { timeAgo, formatDate } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { SecurityLayout } from "./layout";

const KINDS: Record<AlertChannelKind, { name: string; hint: string; placeholder: string }> = {
  ntfy: { name: "ntfy", hint: "Push notifications to your phone: a topic on ntfy.sh or your own ntfy server.", placeholder: "https://ntfy.sh/mybase-alerts-7f3a" },
  webhook: { name: "Webhook", hint: "A signed JSON POST to your URL. Verify it like a cron call.", placeholder: "https://example.com/hooks/mybase" },
};

const VERIFY_SNIPPET = `import { verifyCronSignature } from "@mybase-dev/sdk/cron";

const body = await req.text();
await verifyCronSignature({ body, signature: req.headers.get("X-Mybase-Signature"), secret: process.env.MYBASE_ALERT_SECRET! });
const alert = JSON.parse(body); // { rule, title, detail, at, instance }`;

function AddChannelDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (c: AlertChannel) => void }) {
  const [kind, setKind] = useState<AlertChannelKind>("ntfy");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setPending(true);
    try {
      const channel = await api.createAlertChannel({
        kind,
        url: String(form.get("url")),
        name: String(form.get("name") ?? "") || undefined,
        token: kind === "ntfy" ? String(form.get("token") ?? "") || null : undefined,
      });
      toast.success(`Added ${channel.name}`);
      onAdded(channel);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add alert channel</DialogTitle>
          <DialogDescription>Every alert rule that's on sends here.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <RadioGroup value={kind} onValueChange={(v) => setKind(v as AlertChannelKind)} className="gap-3">
            {(Object.keys(KINDS) as AlertChannelKind[]).map((k) => (
              <label key={k} className="flex items-start gap-3">
                <RadioGroupItem value={k} className="mt-0.5" />
                <span>
                  <span className="font-medium">{KINDS[k].name}</span>
                  <span className="block text-muted-foreground">{KINDS[k].hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <div className="grid gap-2">
            <Label htmlFor="alert-url">{kind === "ntfy" ? "Topic URL" : "URL"}</Label>
            <Input id="alert-url" name="url" type="url" required autoFocus autoComplete="off" spellCheck={false} placeholder={KINDS[kind].placeholder} className="font-mono text-xs md:text-xs" />
            {kind === "ntfy" && <p className="text-muted-foreground">On ntfy.sh anyone who knows the topic can read it, so pick a long random name.</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alert-name">Name (optional)</Label>
            <Input id="alert-name" name="name" autoComplete="off" placeholder="My phone" />
          </div>
          {kind === "ntfy" && (
            <div className="grid gap-2">
              <Label htmlFor="alert-token">Access token (optional)</Label>
              <Input id="alert-token" name="token" type="password" autoComplete="off" placeholder="tk_…" className="font-mono text-xs md:text-xs" />
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRow({ channel, onChange }: { channel: AlertChannel; onChange: () => void }) {
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testAlertChannel(channel.id);
      if (r.ok) toast.success(`Sent a test alert to ${channel.name}`);
      else toast.error(`Not delivered to ${channel.name}: ${r.error}`);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };
  const toggle = async (enabled: boolean) => {
    try {
      await api.updateAlertChannel(channel.id, { enabled });
      toast.success(enabled ? `Resumed ${channel.name}` : `Paused ${channel.name}`);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const rotate = async () => {
    try {
      await api.rotateAlertSecret(channel.id);
      toast.success("Rotated the signing secret. Update your webhook handler.");
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-3 border-t py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 font-medium">
          {channel.name}
          {!channel.enabled && <span className="rounded-sm border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Paused</span>}
        </h3>
        <p className="mt-0.5 text-muted-foreground">{KINDS[channel.kind].name}</p>
        {channel.lastError ? (
          <p className="mt-1 text-destructive">Last send failed: {channel.lastError}</p>
        ) : (
          channel.lastSentAt && (
            <p className="mt-1 text-muted-foreground" title={formatDate(channel.lastSentAt)}>
              Last sent {timeAgo(channel.lastSentAt)}
            </p>
          )
        )}
      </div>
      <div className="grid min-w-0 gap-3">
        <p className="truncate font-mono text-xs" title={channel.url}>
          {channel.url}
        </p>
        {channel.secret && <CopyField id={`alert-secret-${channel.id}`} label="Signing secret" value={channel.secret} secret />}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={testing}>
            {testing ? "Sending…" : "Send test alert"}
          </Button>
          {channel.kind === "webhook" && (
            <Button variant="ghost" size="sm" onClick={() => void rotate()}>
              Rotate secret
            </Button>
          )}
          <label className="ml-2 flex items-center gap-2 text-muted-foreground">
            <Switch checked={channel.enabled} onCheckedChange={(v) => void toggle(v)} aria-label={`Send alerts to ${channel.name}`} />
            On
          </label>
          <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${channel.name}?`}
        description="Alerts will no longer be sent there. Rules stay as they are."
        confirm="Remove channel"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await api.deleteAlertChannel(channel.id);
          toast.success(`Removed ${channel.name}`);
          onChange();
        }}
      />
    </div>
  );
}

export function AlertsTab() {
  const { state, refresh } = useLoad("alerts", () => api.alerts());
  const [adding, setAdding] = useState(false);

  const setRule = async (rule: string, name: string, enabled: boolean) => {
    try {
      await api.setAlertRule(rule, enabled);
      toast.success(`${name}: ${enabled ? "on" : "off"}`);
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const action = (
    <Button onClick={() => setAdding(true)}>
      <Plus />
      Add channel
    </Button>
  );

  return (
    <SecurityLayout tab="alerts" action={action}>
      {state.status === "loading" && <LoadingLines label="Loading alerts" lines={4} />}
      {state.status === "error" && <LoadError what="alert settings" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" && (
        <>
          <section aria-labelledby="alert-channels">
            <h2 id="alert-channels" className="mb-3 text-base font-semibold">
              Channels
            </h2>
            {state.data.channels.length === 0 ? (
              <div className="max-w-prose rounded-lg border border-dashed p-5">
                <p className="font-medium">No channels yet</p>
                <p className="mt-1 text-muted-foreground">Alerts are recorded in the server log until you add somewhere to send them. ntfy is the quickest: install the app, pick a topic, add its URL here.</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => setAdding(true)}>
                  <Plus />
                  Add channel
                </Button>
              </div>
            ) : (
              state.data.channels.map((c) => <ChannelRow key={c.id} channel={c} onChange={() => void refresh()} />)
            )}
            {state.data.channels.some((c) => c.kind === "webhook") && (
              <details className="mt-4">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Verify webhook calls</summary>
                <pre className="mt-2 overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{VERIFY_SNIPPET}</pre>
              </details>
            )}
          </section>
          <section aria-labelledby="alert-rules" className="mt-10">
            <h2 id="alert-rules" className="mb-3 text-base font-semibold">
              Rules
            </h2>
            {state.data.rules.map((r) => (
              <Row key={r.id} title={r.name} hint={r.description}>
                <Switch checked={r.enabled} onCheckedChange={(v) => void setRule(r.id, r.name, v)} aria-label={r.name} />
              </Row>
            ))}
          </section>
        </>
      )}
      <AddChannelDialog open={adding} onOpenChange={setAdding} onAdded={() => void refresh()} />
    </SecurityLayout>
  );
}

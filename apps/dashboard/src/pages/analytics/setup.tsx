import { useEffect, useState, type FormEvent } from "react";
import { RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AnalyticsSettings, Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const scriptSnippet = (s: AnalyticsSettings, project: string) =>
  `<script defer src="${s.scriptUrl}"
  data-project="${project}" data-key="${s.writeKey}"></script>

<!-- custom events, anywhere after it -->
<script>
  document.querySelector("#buy")?.addEventListener("click", () => mybase.track("buy", { plan: "pro" }));
</script>`;

const sdkSnippet = (s: AnalyticsSettings, project: string) => `import { createAnalytics } from "@mybase-dev/sdk/analytics";

export const analytics = createAnalytics({
  apiUrl: "${s.apiUrl}",
  project: "${project}",
  key: "${s.writeKey}", // public: fine in browser code
});

analytics.track("signup", { plan: "pro" });
analytics.captureError(err);`;

function Limits({ project, settings, onSaved }: { project: string; settings: AnalyticsSettings; onSaved: (s: AnalyticsSettings) => void }) {
  const [origins, setOrigins] = useState(settings.allowedOrigins.join("\n"));
  const [retention, setRetention] = useState(String(settings.retentionDays));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setOrigins(settings.allowedOrigins.join("\n"));
    setRetention(String(settings.retentionDays));
  }, [settings]);

  const list = origins
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
  const unchanged = list.join("\n") === settings.allowedOrigins.join("\n") && retention.trim() === String(settings.retentionDays);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const days = Number(retention.trim());
    if (!Number.isInteger(days) || days < 1 || days > 365) return setError("Keep events for a whole number of days, from 1 to 365.");
    setPending(true);
    setError(null);
    try {
      onSaved(await api.updateAnalyticsSettings(project, { allowedOrigins: list, retentionDays: days }));
      toast.success("Saved analytics settings");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-md gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="origins">Allowed origins</Label>
        <Textarea
          id="origins"
          rows={3}
          placeholder={"https://shop.example.com\nhttps://www.shop.example.com"}
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          className="font-mono text-xs md:text-xs"
        />
        <p className="text-muted-foreground">One per line. Leave empty to accept events from any site. Server-side events aren't affected.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="retention">Keep events for (days)</Label>
        <Input id="retention" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value)} className="max-w-32" />
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="outline" disabled={pending || unchanged}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function AnalyticsSetup({ project }: { project: Project }) {
  const name = project.name;
  const { state, refresh } = useLoad(`analytics-settings:${name}`, () => api.analyticsSettings(name));
  const [saved, setSaved] = useState<AnalyticsSettings | null>(null);
  const [dialog, setDialog] = useState<"rotate" | "clear" | "off" | null>(null);
  const settings = saved ?? (state.status === "ready" ? state.data : null);

  if (state.status === "loading") return <LoadingLines label="Loading analytics settings" />;
  if (state.status === "error") return <LoadError what="analytics settings" message={state.message} onRetry={refresh} />;
  if (!settings) return null;

  async function rotate() {
    try {
      setSaved(await api.rotateAnalyticsKey(name));
      toast.success("Rotated the write key");
    } catch (err) {
      toast.error(`Couldn't rotate the key: ${errorMessage(err)}`);
    }
  }
  async function clear() {
    try {
      await api.clearAnalytics(name);
      toast.success(`Deleted every analytics event for ${name}`);
    } catch (err) {
      toast.error(`Couldn't delete events: ${errorMessage(err)}`);
    }
  }
  async function turnOff() {
    try {
      await api.disableService(name, "analytics");
      await refreshProjects();
      toast.success(`Turned off analytics for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off analytics: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <section aria-labelledby="connect" className="mb-10">
        <h2 id="connect" className="mb-3 text-base font-semibold">
          Connect your app
        </h2>
        <Row title="Write key" hint="Public by design: it goes in browser code, and can only add events. Rotate it if someone floods your project.">
          <div className="grid gap-3">
            <CopyField id="analytics-key" label="Write key" value={settings.writeKey} />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setDialog("rotate")}>
                <RotateCw />
                Rotate key
              </Button>
            </div>
          </div>
        </Row>
        <Row title="Script tag" hint="For any site. Records page views, client-side route changes, and uncaught errors.">
          {code(scriptSnippet(settings, name))}
        </Row>
        <Row
          title="npm"
          hint={
            <>
              For bundled apps and servers: <code className="font-mono text-[0.85em] text-foreground">npm install @mybase-dev/sdk</code>. Same automatic tracking in the
              browser.
            </>
          }
        >
          {code(sdkSnippet(settings, name))}
        </Row>
        <Row title="Ingest URL" hint="For sending events from other languages. See the analytics API guide in Docs.">
          <CopyField id="analytics-ingest" label="POST" value={settings.ingestUrl} />
        </Row>
      </section>

      <section aria-labelledby="limits" className="mb-10">
        <h2 id="limits" className="mb-3 text-base font-semibold">
          Limits
        </h2>
        <Row title="Origins and retention" hint="Older events are deleted every hour. Visitors are counted without cookies, and IP addresses are never stored.">
          <Limits project={name} settings={settings} onSaved={setSaved} />
        </Row>
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Delete data
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Delete every page view, event, and error, keeping the write key and settings.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("clear")}>
            <Trash2 />
            Delete events
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Turn analytics off, deleting its data. Turning it back on makes a new write key.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off analytics
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rotate write key"
        description="The current key stops working right away. Events from apps still using it are rejected until you deploy the new one."
        confirm="Rotate"
        pendingLabel="Rotating…"
        onConfirm={rotate}
      />
      <ConfirmDialog
        open={dialog === "clear"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete analytics events for ${name}`}
        description="Every recorded page view, custom event, and error is deleted. This can't be undone."
        confirm="Delete events"
        pendingLabel="Deleting…"
        onConfirm={clear}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off analytics for ${name}`}
        description={SERVICE_PAGES.analytics.turnOff}
        confirm="Turn off analytics"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

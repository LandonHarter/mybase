import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { EmailServerStatus, EmailSettings } from "@mybase/shared";
import { RETENTION_DAYS } from "./limits";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineDelete } from "@/components/inline-delete";
import { Row } from "@/components/row";
import { DangerZone } from "@/components/service-layout";
import { SERVICE_PAGES } from "@/components/service-card";
import { ErrorPanel, LinesSkeleton } from "@/components/states";
import { Badge, Empty, InlineCode, Mono, StatusDot } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { invalidate, mutate, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { navigate } from "@/lib/router";

const REASON = { bounce: "Bounced", complaint: "Marked as spam", manual: "Added by hand" } as const;

function Account({ status }: { status: EmailServerStatus | null }) {
  if (!status) return <LinesSkeleton label="Loading the sending account" lines={2} />;
  if (!status.configured) return <Empty />;
  return (
    <div className="grid gap-2">
      <p className="flex flex-wrap items-center gap-2">
        Amazon SES <Mono>{status.region}</Mono>
        {status.sandbox ? (
          <Badge tone="warning" dot>
            Sandbox
          </Badge>
        ) : (
          <Badge>Production</Badge>
        )}
      </p>
      {status.sandbox && (
        <p className="max-w-prose text-muted-foreground">
          While SES is in the sandbox, email only reaches addresses verified in SES, 200 a day. To send to anyone, open SES in the AWS console and choose Request production access (Account dashboard).
        </p>
      )}
      {status.quota && (
        <p className="text-muted-foreground">
          {status.quota.sentLast24Hours.toLocaleString()} of {status.quota.max24Hour.toLocaleString()} sent in the last 24 hours, up to {status.quota.maxPerSecond} a second
        </p>
      )}
      <StatusDot
        health={status.eventsReady ? "ok" : "warning"}
        label={status.eventsReady ? "Delivery events arrive" : "Delivery events aren't set up"}
        detail={status.eventsReady ? undefined : "statuses stay at Sent"}
      />
      {status.sendingEnabled === false && <p className="text-destructive">SES has paused sending for this account. Check the account dashboard in the AWS console.</p>}
      {status.error && <p className="text-destructive [overflow-wrap:anywhere]">{status.error}</p>}
    </div>
  );
}

function Suppressions({ project }: { project: string }) {
  const list = useLoad(`email:${project}:suppressions`, () => api.emailSuppressions(project));
  if (list.state.status === "loading") return <LinesSkeleton label="Loading suppressions" lines={2} />;
  if (list.state.status === "error") return <ErrorPanel title="Couldn't load suppressions" message={list.state.message} onRetry={() => void list.refresh()} />;
  if (list.state.data.length === 0) return <p className="py-1.5 text-muted-foreground">None. Addresses that bounce for good or mark your email as spam land here automatically.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Address</TableHead>
          <TableHead>Why</TableHead>
          <TableHead className="hidden sm:table-cell">Since</TableHead>
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.state.data.map((s) => (
          <TableRow key={s.address} className="h-10">
            <TableCell>
              <Mono>{s.address}</Mono>
            </TableCell>
            <TableCell>{REASON[s.reason]}</TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              <TimeAgo iso={s.createdAt} />
            </TableCell>
            <TableCell>
              <InlineDelete
                label={`Remove ${s.address} from suppressions`}
                question="Email again?"
                onDelete={async () => {
                  await api.removeEmailSuppression(project, s.address);
                  invalidate(`email:${project}:suppressions`);
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SettingsForm({ project, settings }: { project: string; settings: EmailSettings }) {
  const key = `email:${project}:settings`;
  const [error, setError] = useState<{ field: string; message: string } | null>(null);

  async function patch(field: string, body: Partial<EmailSettings>, done: string) {
    setError(null);
    try {
      const next = await api.updateEmailSettings(project, body);
      mutate<EmailSettings>(key, () => next);
      toast.success(done);
    } catch (err) {
      setError({ field, message: errorMessage(err) });
    }
  }

  async function toggle(field: "trackOpens" | "trackClicks", on: boolean) {
    const rollback = mutate<EmailSettings>(key, (s) => ({ ...s!, [field]: on }));
    try {
      await api.updateEmailSettings(project, { [field]: on });
    } catch (err) {
      rollback();
      toast.error(errorMessage(err), { duration: Infinity });
    }
  }

  const fieldError = (field: string) =>
    error?.field === field && (
      <p role="alert" className="w-full text-destructive">
        {error.message}
      </p>
    );

  return (
    <>
      <Row title="Default from" hint="Used when neither the send nor the template sets one. Must be at a verified domain." id="from">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get("from") ?? "").trim();
            void patch("from", { defaultFrom: value || null }, value ? `Default from is now ${value}` : "Removed the default from");
          }}
        >
          <Input key={settings.defaultFrom ?? ""} name="from" defaultValue={settings.defaultFrom ?? ""} placeholder='"Acme" <hello@acme.com>' aria-label="Default from" className="w-80 max-w-full font-mono" />
          <Button type="submit" variant="outline">
            Save
          </Button>
          {fieldError("from")}
        </form>
      </Row>
      <Row title="Keep sent email" hint="Days to keep the log and each email's content. Older ones are deleted every hour." id="retention">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const days = Number(new FormData(e.currentTarget).get("days"));
            void patch("retention", { retentionDays: days }, `Keeping sent email for ${days} days`);
          }}
        >
          <Input key={settings.retentionDays} name="days" type="number" min={RETENTION_DAYS.min} max={RETENTION_DAYS.max} defaultValue={settings.retentionDays} aria-label="Days to keep" className="w-28" />
          <span className="text-muted-foreground">days</span>
          <Button type="submit" variant="outline">
            Save
          </Button>
          {fieldError("retention")}
        </form>
      </Row>
      <Row title="Track opens" hint="SES adds an invisible image. Image proxies (Apple Mail, Gmail) make counts approximate." id="opens">
        <Switch checked={settings.trackOpens} onCheckedChange={(on) => void toggle("trackOpens", on)} aria-label="Track opens" />
      </Row>
      <Row title="Track clicks" hint="SES rewrites links through its own domain to record clicks." id="clicks">
        <Switch checked={settings.trackClicks} onCheckedChange={(on) => void toggle("trackClicks", on)} aria-label="Track clicks" />
      </Row>
    </>
  );
}

export function EmailSettingsView({ project, status }: { project: string; status: EmailServerStatus | null }) {
  const settings = useLoad(`email:${project}:settings`, () => api.emailSettings(project), { refetchOnFocus: false });
  const [off, setOff] = useState(false);

  return (
    <section aria-labelledby="email-settings" className="max-w-5xl">
      <h2 id="email-settings" className="sr-only">
        Settings
      </h2>
      <Row
        title="Sending account"
        hint={
          <>
            This server's SES account, shared by every project. Change it with <InlineCode>mybase server email</InlineCode>.
          </>
        }
        id="account"
      >
        <Account status={status} />
      </Row>
      {settings.state.status === "loading" && <LinesSkeleton label="Loading email settings" lines={4} />}
      {settings.state.status === "error" && <ErrorPanel title="Couldn't load email settings" message={settings.state.message} onRetry={() => void settings.refresh()} />}
      {settings.state.status === "ready" && <SettingsForm project={project} settings={settings.state.data} />}
      <Row title="Suppressed addresses" hint="Never emailed: sends that include one are refused. Remove an address to email it again." id="suppressions">
        <Suppressions project={project} />
      </Row>
      <DangerZone title="Delete email data and turn off" action={<Button variant="danger-outline" onClick={() => setOff(true)}>Turn off email…</Button>}>
        {SERVICE_PAGES.email.turnOff}
      </DangerZone>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off email for ${project}`}
        description={SERVICE_PAGES.email.turnOff!}
        confirm="Turn off email"
        pendingLabel="Turning off…"
        onConfirm={async () => {
          await api.disableService(project, "email");
          await refreshProjects();
          toast.success(`Turned off email for ${project}`);
          navigate({ page: "project", name: project });
        }}
      />
    </section>
  );
}

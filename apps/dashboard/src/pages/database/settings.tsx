import { useEffect, useState, type FormEvent } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { databaseUrl, type DatabaseDetails, type DbPublicStatus, type Project } from "@mybase/shared";
import { CopyField } from "@/components/copy-field";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { DatabaseLayout } from "@/pages/database/layout";

function Stats({ details }: { details: DatabaseDetails }) {
  const items = [
    ["Size on disk", formatBytes(details.sizeBytes)],
    ["Tables", details.tables.toLocaleString()],
    ["Open connections", details.activeConnections.toLocaleString()],
  ];
  return (
    <dl className="grid grid-cols-3 gap-4">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 text-base font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Public Postgres (port forward + Let's Encrypt + DDNS): what's working and what isn't. */
function PublicAccess({ status }: { status: DbPublicStatus }) {
  if (!status.enabled) {
    return (
      <p className="max-w-prose text-muted-foreground">
        Off. Apps outside your network use the serverless connection below. To give them a normal connection string instead, forward port {status.port} on
        your router and run <span className="font-mono text-[0.9em]">mybase server database-public</span>.
      </p>
    );
  }
  if (status.problem) return <p className="max-w-prose text-destructive">{status.problem}</p>;
  const { tls, dns } = status;
  const items: [string, string, boolean][] = [
    [
      "Certificate",
      tls.error
        ? tls.error
        : tls.notAfter
          ? `Let's Encrypt${tls.staging ? " (staging)" : ""}, valid until ${day(tls.notAfter)}`
          : "Requesting…",
      Boolean(tls.error),
    ],
    ["DNS", dns.error ? dns.error : dns.ip ? `${status.host} → ${dns.ip}` : "Checking…", Boolean(dns.error)],
  ];
  return (
    <div className="grid gap-3">
      <dl className="grid gap-2">
        {items.map(([label, value, bad]) => (
          <div key={label} className="grid grid-cols-[7rem_1fr] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={bad ? "text-destructive" : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="max-w-prose text-muted-foreground">
        Your router must forward TCP port {status.port} to this machine. Only project roles can sign in from the internet, to their own database, over TLS.
      </p>
    </div>
  );
}

function ConnectionLimit({ project, current, onSaved }: { project: string; current: number | null; onSaved: (d: DatabaseDetails) => void }) {
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => setValue(current === null ? "" : String(current)), [current]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const limit = trimmed === "" ? null : Number(trimmed);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      setError("Use a whole number from 1 to 1000, or leave it empty for no limit.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onSaved(await api.updateDatabase(project, { connectionLimit: limit }));
      toast.success(limit === null ? "Removed the connection limit" : `Connection limit set to ${limit}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const unchanged = value.trim() === (current === null ? "" : String(current));
  return (
    <form onSubmit={onSubmit} className="grid max-w-sm gap-2">
      <Label htmlFor="conn-limit">Max connections</Label>
      <div className="flex gap-2">
        <Input
          id="conn-limit"
          inputMode="numeric"
          placeholder="No limit"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "conn-limit-error" : undefined}
        />
        <Button type="submit" variant="outline" disabled={pending || unchanged}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && (
        <p id="conn-limit-error" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function DatabaseSettingsTab({ project }: { project: Project }) {
  const { state, refresh } = useLoad(`db:${project.name}`, () => api.database(project.name));
  const [saved, setSaved] = useState<DatabaseDetails | null>(null);
  const details = saved ?? (state.status === "ready" ? state.data : null);
  const { database } = project;
  const publicAccess = useLoad("db-public", () => api.dbPublic());

  return (
    <DatabaseLayout project={project} tab="settings">
      <Row title="Connection" hint="The password was shown once, when the project was created.">
        <div className="grid gap-3">
          <CopyField id="db-host" label="Host and port" value={`${database.host}:${database.port}`} />
          <CopyField id="db-name" label="Database and user" value={database.name} />
          <CopyField id="db-url" label="Connection string" value={databaseUrl(database)} />
        </div>
      </Row>
      <Row title="Public access" hint="A connection string that works from anywhere, with any Postgres driver.">
        {publicAccess.state.status === "ready" ? (
          <PublicAccess status={publicAccess.state.data} />
        ) : publicAccess.state.status === "error" ? (
          <p className="text-muted-foreground">{publicAccess.state.message}</p>
        ) : (
          <Skeleton className="h-10 w-full max-w-sm" />
        )}
      </Row>
      <Row
        title="Serverless connection"
        hint={
          <>
            For apps that can't reach port {database.port}, like ones on Vercel. Use{" "}
            <span className="font-mono text-[0.9em]">@neondatabase/serverless</span> with this as its WebSocket proxy and <span className="font-mono text-[0.9em]">ssl: false</span>.
          </>
        }
      >
        <CopyField id="db-ws-url" label="WebSocket URL" value={database.wsUrl} />
      </Row>
      <Row title="Usage" hint="Open connections counts your apps, not the dashboard.">
        {details ? (
          <Stats details={details} />
        ) : state.status === "error" ? (
          <div role="alert">
            <p className="text-muted-foreground">{state.message}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={refresh}>
              <RotateCw />
              Retry
            </Button>
          </div>
        ) : (
          <Skeleton className="h-10 w-full max-w-sm" />
        )}
      </Row>
      <Row title="Connection limit" hint="Caps how many connections apps can open at once. Helps keep a small server from running out of memory.">
        {details ? <ConnectionLimit project={project.name} current={details.connectionLimit} onSaved={setSaved} /> : <Skeleton className="h-9 w-full max-w-sm" />}
      </Row>
    </DatabaseLayout>
  );
}

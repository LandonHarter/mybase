import { useEffect, useState, type FormEvent } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import type { DatabaseDetails, Project } from "@mybase/shared";
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

  return (
    <DatabaseLayout project={project} tab="settings">
      <Row title="Connection" hint="The password was shown once, when the project was created.">
        <div className="grid gap-3">
          <CopyField id="db-host" label="Host and port" value={`${database.host}:${database.port}`} />
          <CopyField id="db-name" label="Database and user" value={database.name} />
          <CopyField
            id="db-url"
            label="Connection string"
            value={`postgres://${database.user}:<password>@${database.host}:${database.port}/${database.name}`}
          />
        </div>
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

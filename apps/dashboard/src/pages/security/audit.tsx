import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AUDIT_ACTION_GROUPS, AUDIT_OUTCOMES, type AuditEventRecord } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { useProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { SecurityLayout } from "./layout";

const PAGE = 50;
const OUTCOME_LABELS = { ok: "OK", denied: "Denied", failed: "Failed" } as const;
const selectClass = "h-9 rounded-md border bg-transparent px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function actorLabel(e: AuditEventRecord) {
  if (e.actor.kind === "token") return `API key "${e.actor.name}"`;
  if (e.actor.kind === "session") return e.actor.name ?? "admin";
  if (e.actor.kind === "system") return "mybase";
  return e.actor.name ? `${e.actor.name} (not signed in)` : "Not signed in";
}

const metaText = (meta: AuditEventRecord["meta"]) => (meta ? Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" ") : "");

function Events({ project, action, outcome }: { project: string | null; action: string | null; outcome: string | null }) {
  const key = `audit:${project}:${action}:${outcome}`;
  const { state, refresh } = useLoad(key, () => api.audit({ project, action, outcome, limit: PAGE }));
  // Older pages, appended below the first. Reset when the filters change.
  const [older, setOlder] = useState<AuditEventRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setOlder([]);
    setNext(state.status === "ready" ? state.data.next : null);
  }, [key, state]);

  if (state.status === "loading") return <LoadingLines label="Loading the audit log" lines={6} />;
  if (state.status === "error") return <LoadError what="the audit log" message={state.message} onRetry={() => void refresh()} />;
  const events = [...state.data.events, ...older];
  if (events.length === 0) {
    return (
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">{project || action || outcome ? "Nothing matches these filters" : "Nothing recorded yet"}</p>
        <p className="mt-1 text-muted-foreground">Sign-ins, API key and project changes, service toggles, secret reads, and database changes show up here.</p>
      </div>
    );
  }

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await api.audit({ project, action, outcome, before: next, limit: PAGE });
      setOlder((o) => [...o, ...page.events]);
      setNext(page.next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>On</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground" title={formatDate(e.at)}>
                {timeAgo(e.at)}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{e.action}</span>
                {e.outcome !== "ok" && <span className={cn("ml-2 rounded-sm border px-1.5 py-0.5 text-xs", e.outcome === "denied" ? "text-destructive" : "text-muted-foreground")}>{OUTCOME_LABELS[e.outcome]}</span>}
                {e.meta && (
                  <div className="mt-0.5 max-w-[22rem] truncate font-mono text-xs text-muted-foreground" title={metaText(e.meta)}>
                    {metaText(e.meta)}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {actorLabel(e)}
                {e.ip && <div className="font-mono text-xs text-muted-foreground">{e.ip}</div>}
              </TableCell>
              <TableCell>
                {e.project && (
                  <a href={href({ page: "project", name: e.project })} className="hover:underline">
                    {e.project}
                  </a>
                )}
                {e.target && (
                  <div className="max-w-[14rem] truncate font-mono text-xs text-muted-foreground" title={e.target}>
                    {e.target}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {next && (
        <Button variant="outline" className="mt-4" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load older"}
        </Button>
      )}
    </>
  );
}

function Retention() {
  const { state, refresh } = useLoad("audit-settings", () => api.auditSettings());
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const days = Number(new FormData(e.currentTarget).get("days"));
    try {
      await api.updateAuditSettings({ retentionDays: days });
      toast.success(`Audit entries are now kept for ${days} days`);
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (state.status !== "ready") return null;
  return (
    <section aria-labelledby="audit-retention" className="mt-10">
      <h2 id="audit-retention" className="mb-3 text-base font-semibold">
        Settings
      </h2>
      <Row title="Keep entries for" hint="Older entries are deleted every hour. 7 to 365 days.">
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <Input key={state.data.retentionDays} name="days" type="number" min={7} max={365} defaultValue={state.data.retentionDays} className="w-24" aria-label="Days" />
          <span className="text-muted-foreground">days</span>
          <Button type="submit" variant="outline">
            Save
          </Button>
          {error && (
            <p role="alert" className="w-full text-destructive">
              {error}
            </p>
          )}
        </form>
      </Row>
    </section>
  );
}

export function AuditTab({ project, action, outcome }: { project: string | null; action: string | null; outcome: string | null }) {
  const { state } = useProjects();
  const auth = useAuth();
  const isAdmin = auth.status === "ready" && (auth.permissions?.includes("admin") ?? false);
  const go = (change: { project?: string | null; action?: string | null; outcome?: string | null }) =>
    navigate({ page: "security", tab: "audit", project, action, outcome, ...change }, { replace: true });

  return (
    <SecurityLayout tab="audit">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-project">Project</Label>
          <select id="audit-project" className={selectClass} value={project ?? ""} onChange={(e) => go({ project: e.target.value || null })}>
            <option value="">All</option>
            {state.status === "ready" && state.projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">What</Label>
          <select id="audit-action" className={selectClass} value={action ?? ""} onChange={(e) => go({ action: e.target.value || null })}>
            <option value="">Everything</option>
            {AUDIT_ACTION_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-outcome">Outcome</Label>
          <select id="audit-outcome" className={selectClass} value={outcome ?? ""} onChange={(e) => go({ outcome: e.target.value || null })}>
            <option value="">Any</option>
            {AUDIT_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
          </select>
        </div>
      </div>
      <Events project={project} action={action} outcome={outcome} />
      {isAdmin && <Retention />}
    </SecurityLayout>
  );
}

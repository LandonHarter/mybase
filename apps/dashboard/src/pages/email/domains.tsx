import { useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { EmailDnsRecord, EmailDomain } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorPanel, TableSkeleton } from "@/components/states";
import { Badge, StatusDot, type Health } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { useCopy } from "@/lib/clipboard";
import { useCommands } from "@/lib/commands";
import { invalidate, type Load } from "@/lib/load";

const DOMAIN_STATUS: Record<EmailDomain["status"], { label: string; health: Health }> = {
  pending: { label: "Waiting for DNS", health: "progress" },
  verified: { label: "Verified", health: "ok" },
  failed: { label: "Not verified", health: "error" },
};

const PURPOSE: Record<EmailDnsRecord["purpose"], string> = {
  dkim: "DKIM signing",
  "mail-from": "Bounces (MAIL FROM)",
  dmarc: "DMARC, if you have none",
};

const STATE: Record<NonNullable<EmailDnsRecord["state"]>, { label: string; tone: "success" | "neutral" | "warning" }> = {
  added: { label: "Added", tone: "success" },
  present: { label: "Already there", tone: "neutral" },
  conflict: { label: "Conflict", tone: "warning" },
};

function AddDomainDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.addEmailDomain(project, domain.trim());
      invalidate(`email:${project}:domains`);
      onOpenChange(false);
      setDomain("");
      toast.success(d.dns === "cloudflare" ? `Added ${d.domain} and its DNS records in Cloudflare` : `Added ${d.domain}. Add its DNS records next.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a sending domain</DialogTitle>
            <DialogDescription>mybase registers it with SES. If the server has a Cloudflare DNS token, the DNS records are added for you; otherwise you get them to add yourself.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-domain">Domain</Label>
            <Input
              id="email-domain"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="mail.acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="font-mono"
              aria-invalid={!!error}
              aria-describedby={error ? "email-domain-error" : "email-domain-hint"}
            />
            {error ? (
              <p id="email-domain-error" role="alert" className="text-destructive">
                {error}
              </p>
            ) : (
              <p id="email-domain-hint" className="text-muted-foreground">
                Apps can then send from any address at it. A subdomain keeps your main domain's reputation separate.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !domain.trim()}>
              {busy ? "Adding…" : "Add domain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A DNS name or value: wraps anywhere (they're long), with a Copy icon that stays in place. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <div className="group flex min-w-0 items-start gap-1">
      <span className="mono-value min-w-0 flex-1 py-1 break-all select-text">{value}</span>
      <Button type="button" variant="ghost" size="icon-sm" className="-my-0.5 shrink-0 text-muted-foreground" onClick={() => copy(value, label)} aria-label={`Copy ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function Records({ domain }: { domain: EmailDomain }) {
  const auto = domain.dns === "cloudflare";
  const cols = auto ? "md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)_6.5rem]" : "md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]";
  return (
    <div role="table" aria-label={`DNS records for ${domain.domain}`} className="min-w-0 text-sm">
      <div role="row" className={`hidden gap-x-4 border-b pb-2 text-xs font-medium text-muted-foreground md:grid ${cols}`}>
        <span role="columnheader">Type</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Value</span>
        {auto && <span role="columnheader">In Cloudflare</span>}
      </div>
      {domain.records.map((r, i) => (
        <div
          role="row"
          key={`${r.type}-${r.name}-${i}`}
          className={`grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0 ${cols}`}
        >
          <div role="cell" className="row-span-2 md:row-span-1">
            <span className="mono-value block py-1">{r.type}</span>
            <span className="block text-xs text-muted-foreground">{PURPOSE[r.purpose]}</span>
          </div>
          <div role="cell" className="min-w-0">
            <span className="text-xs text-muted-foreground md:hidden">Name</span>
            <CopyValue value={r.name} label={`${r.type} name`} />
          </div>
          <div role="cell" className="col-start-2 min-w-0 md:col-start-auto">
            <span className="text-xs text-muted-foreground md:hidden">Value</span>
            <CopyValue value={r.value} label={`${r.type} value`} />
            {r.priority !== undefined && <span className="text-xs text-muted-foreground">Priority {r.priority}</span>}
          </div>
          {auto && (
            <div role="cell" className="col-start-2 md:col-start-auto md:py-1">
              {r.state && <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DomainItem({ project, d, onRemove }: { project: string; d: EmailDomain; onRemove: () => void }) {
  const [checking, setChecking] = useState(false);
  const [showRecords, setShowRecords] = useState(false);
  const verified = d.status === "verified";
  const conflicts = d.records.filter((r) => r.state === "conflict").length;

  async function check() {
    setChecking(true);
    try {
      const res = await api.checkEmailDomain(project, d.domain);
      invalidate(`email:${project}:domains`);
      if (res.status === "verified") toast.success(`${d.domain} is verified`);
      else toast(`${d.domain}: ${DOMAIN_STATUS[res.status].label.toLowerCase()}`, { description: "SES hasn't seen every record yet. mybase keeps checking every 10 minutes." });
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity, action: { label: "Retry", onClick: () => void check() } });
    } finally {
      setChecking(false);
    }
  }

  return (
    <article aria-labelledby={`domain-${d.domain}`} className="border-t py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 id={`domain-${d.domain}`} className="mono-value text-[15px] font-semibold">
          {d.domain}
        </h3>
        <StatusDot health={DOMAIN_STATUS[d.status].health} label={DOMAIN_STATUS[d.status].label} />
        <span className="text-xs text-muted-foreground">
          {d.dns === "cloudflare" ? "DNS in Cloudflare" : "DNS by hand"}
          {d.checkedAt && (
            <>
              {" · "}
              <TimeAgo iso={d.checkedAt} prefix="checked " />
            </>
          )}
        </span>
        <span className="ml-auto flex gap-1">
          {!verified && (
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
              <RefreshCw />
              {checking ? "Checking…" : "Check now"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${d.domain}`}>
            Remove
          </Button>
        </span>
      </div>

      {d.error && <p className="mt-2 max-w-prose text-destructive">{d.error}</p>}
      {conflicts > 0 && (
        <p className="mt-2 max-w-prose text-warning">
          {recordCount(conflicts)} already exists in Cloudflare with a different value. Change {conflicts === 1 ? "it" : "them"} to the value below, then check again.
        </p>
      )}

      {verified ? (
        <div className="mt-1">
          <button
            type="button"
            className="focus-ring inline-flex items-center gap-1 rounded-sm text-left text-muted-foreground hover:text-foreground"
            aria-expanded={showRecords}
            onClick={() => setShowRecords((s) => !s)}
          >
            {showRecords ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
            {showRecords ? "Hide DNS records" : `Show DNS records (${d.records.length})`}
          </button>
          {showRecords && (
            <div className="mt-2">
              <p className="mb-3 text-muted-foreground">Keep these in place: SES checks DKIM again from time to time and stops sending if they're gone.</p>
              <Records domain={d} />
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="mt-1 mb-3 max-w-prose text-muted-foreground">
            {d.dns === "cloudflare"
              ? "mybase added these records. SES usually sees them within minutes."
              : "Add these records at your DNS provider. SES usually sees them within minutes, at most 72 hours."}{" "}
            mybase checks again every 10 minutes.
          </p>
          <Records domain={d} />
        </>
      )}
    </article>
  );
}

const recordCount = (n: number) => (n === 1 ? "A record" : `${n} records`);

export function EmailDomains({ project, load, adding, onAddingChange }: { project: string; load: Load<EmailDomain[]>; adding: boolean; onAddingChange: (open: boolean) => void }) {
  const [removing, setRemoving] = useState<EmailDomain | null>(null);
  useCommands([{ id: "email-add-domain", label: "Add email domain", icon: Plus, run: () => onAddingChange(true) }]);

  return (
    <section aria-label="Domains">
      {load.state.status === "loading" && <TableSkeleton label="Loading domains" columns={3} />}
      {load.state.status === "error" && !load.data && <ErrorPanel title="Couldn't load domains" message={load.state.message} onRetry={() => void load.refresh()} />}
      {load.data && load.data.length === 0 && (
        <EmptyState title="Add a domain to send from" action={<Button onClick={() => onAddingChange(true)}>Add domain</Button>}>
          Apps send from addresses at domains you verify, like hello@acme.com. SES needs three DKIM records and a bounce subdomain; mybase adds them in Cloudflare when the server has a DNS token.
        </EmptyState>
      )}
      {load.data && load.data.length > 0 && (
        <div>
          {load.data.map((d) => (
            <DomainItem key={d.domain} project={project} d={d} onRemove={() => setRemoving(d)} />
          ))}
        </div>
      )}
      <AddDomainDialog project={project} open={adding} onOpenChange={onAddingChange} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.domain ?? ""}`}
        description="Email from this domain stops right away. mybase deletes it from SES and removes the DNS records it added; records you added yourself stay."
        confirm="Remove domain"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await api.removeEmailDomain(project, removing!.domain);
          invalidate(`email:${project}:domains`);
          toast.success(`Removed ${removing!.domain}`);
        }}
      />
    </section>
  );
}

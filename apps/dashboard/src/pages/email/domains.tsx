import { useState, type FormEvent } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { EmailDnsRecord, EmailDomain } from "@mybase/shared";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { EmptyState, ErrorPanel, TableSkeleton } from "@/components/states";
import { Badge, Mono, StatusDot, type Health } from "@/components/status";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { invalidate, type Load } from "@/lib/load";

const DOMAIN_STATUS: Record<EmailDomain["status"], { label: string; health: Health }> = {
  pending: { label: "Waiting for DNS", health: "progress" },
  verified: { label: "Verified", health: "ok" },
  failed: { label: "Not verified", health: "error" },
};

const PURPOSE: Record<EmailDnsRecord["purpose"], string> = {
  dkim: "DKIM (signs your email)",
  "mail-from": "MAIL FROM (bounces, SPF)",
  dmarc: "DMARC (only if you have none)",
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
      toast.success(d.dns === "cloudflare" ? `Added ${d.domain}; DNS records are in Cloudflare` : `Added ${d.domain}; add its DNS records next`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a sending domain</DialogTitle>
            <DialogDescription>
              mybase registers it with SES and adds the DNS records in Cloudflare when the server has a DNS token (MYBASE_DNS_TOKEN); otherwise you get the records to add yourself.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-domain">Domain</Label>
            <Input id="email-domain" required autoFocus placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} className="font-mono" aria-invalid={!!error} aria-describedby={error ? "email-domain-error" : "email-domain-hint"} />
            <p id="email-domain-hint" className="text-xs text-muted-foreground">
              Send from any address at it, like hello@acme.com. A subdomain (mail.acme.com) keeps your main domain's reputation separate.
            </p>
            {error && (
              <p id="email-domain-error" role="alert" className="text-destructive">
                {error}
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

function Records({ domain }: { domain: EmailDomain }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Type</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="hidden w-48 lg:table-cell">For</TableHead>
          {domain.dns === "cloudflare" && <TableHead className="w-28">In Cloudflare</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {domain.records.map((r, i) => (
          <TableRow key={`${r.type}-${r.name}-${i}`} className="align-top">
            <TableCell>
              <Mono>{r.type}</Mono>
            </TableCell>
            <TableCell className="min-w-0">
              <CopyField id={`rec-name-${domain.domain}-${i}`} label={`${r.type} name`} value={r.name} />
            </TableCell>
            <TableCell className="min-w-0">
              <CopyField id={`rec-value-${domain.domain}-${i}`} label={`${r.type} value${r.priority !== undefined ? ` (priority ${r.priority})` : ""}`} value={r.value} />
            </TableCell>
            <TableCell className="hidden text-muted-foreground lg:table-cell">{PURPOSE[r.purpose]}</TableCell>
            {domain.dns === "cloudflare" && <TableCell>{r.state ? <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge> : "—"}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function EmailDomains({ project, load }: { project: string; load: Load<EmailDomain[]> }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EmailDomain | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  useCommands([{ id: "email-add-domain", label: "Add email domain", icon: Plus, run: () => setAdding(true) }]);

  async function check(d: EmailDomain) {
    setChecking(d.domain);
    try {
      const res = await api.checkEmailDomain(project, d.domain);
      invalidate(`email:${project}:domains`);
      toast.success(res.status === "verified" ? `${d.domain} is verified` : `${d.domain}: ${DOMAIN_STATUS[res.status].label.toLowerCase()}`);
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    } finally {
      setChecking(null);
    }
  }

  return (
    <section aria-label="Domains">
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-muted-foreground">Apps can send from any address at a verified domain.</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add domain
        </Button>
      </div>
      {load.state.status === "loading" && <TableSkeleton label="Loading domains" columns={3} />}
      {load.state.status === "error" && <ErrorPanel title="Couldn't load domains" message={load.state.message} onRetry={() => void load.refresh()} />}
      {load.data && load.data.length === 0 && (
        <EmptyState title="No sending domains yet" action={<Button onClick={() => setAdding(true)}>Add domain</Button>}>
          Verify a domain you own to send from it. SES needs three DKIM records and a bounce subdomain; mybase adds them in Cloudflare when it can.
        </EmptyState>
      )}
      <div className="grid gap-8">
        {load.data?.map((d) => (
          <article key={d.domain} aria-labelledby={`domain-${d.domain}`}>
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <h3 id={`domain-${d.domain}`} className="font-mono text-[15px] font-semibold">
                {d.domain}
              </h3>
              <StatusDot health={DOMAIN_STATUS[d.status].health} label={DOMAIN_STATUS[d.status].label} />
              {d.checkedAt && <TimeAgo iso={d.checkedAt} prefix="checked " className="text-xs text-muted-foreground" />}
              <span className="ml-auto flex gap-2">
                {d.status !== "verified" && (
                  <Button variant="ghost" size="sm" disabled={checking === d.domain} onClick={() => void check(d)}>
                    <RefreshCw />
                    {checking === d.domain ? "Checking…" : "Re-check"}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setRemoving(d)}>
                  Remove
                </Button>
              </span>
            </div>
            {d.error && <p className="mb-2 text-destructive">{d.error}</p>}
            {d.status === "verified" ? (
              <p className="text-muted-foreground">Ready to send. Keep the DNS records in place: SES re-checks DKIM regularly.</p>
            ) : (
              <>
                <p className="mb-2 text-muted-foreground">
                  {d.dns === "cloudflare"
                    ? "mybase added these records in Cloudflare. SES usually sees them within minutes; this page re-checks every 10 minutes."
                    : "Add these records at your DNS provider. SES usually sees them within minutes (up to 72 hours); this page re-checks every 10 minutes."}
                </p>
                <Records domain={d} />
              </>
            )}
          </article>
        ))}
      </div>
      <AddDomainDialog project={project} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.domain ?? ""}`}
        description="Email from this domain stops at once. mybase deletes it from SES and removes the DNS records it added (records you added stay)."
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

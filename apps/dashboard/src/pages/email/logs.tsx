import { useEffect, useState, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import { toast } from "sonner";
import type { EmailMessage, EmailMessageSummary } from "@mybase/shared";
import { EMAIL_STATUSES } from "./limits";
import { Facts, Inspector } from "@/components/inspector";
import { EmptyState, ErrorPanel, TableSkeleton } from "@/components/states";
import { Badge, Empty, LiveIndicator, Mono, StatusDot } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { invalidate, POLL, useLoad } from "@/lib/load";
import { formatDate, formatDuration } from "@/lib/format";
import { href, navigate } from "@/lib/router";
import { emailRoute, STATUS, type EmailRoute } from "./index";

const inProgress = (m: { status: string }) => m.status === "queued" || m.status === "sending";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

const EVENT_LABEL: Record<string, string> = {
  send: "Accepted by SES",
  delivery: "Delivered",
  delay: "Delayed",
  bounce: "Bounced",
  complaint: "Marked as spam",
  reject: "Rejected by SES",
  open: "Opened",
  click: "Clicked",
  rendering_failure: "Rendering failed",
  failed: "Failed",
  canceled: "Canceled",
};

function eventDetail(e: EmailMessage["events"][number]): string | null {
  const d = e.detail as Record<string, unknown> | undefined;
  if (!d) return null;
  if (e.type === "bounce") {
    const r = (d.recipients as { address?: string; diagnostic?: string }[] | undefined)?.map((x) => [x.address, x.diagnostic].filter(Boolean).join(": "));
    return [d.bounceType, d.bounceSubType].filter(Boolean).join(" / ") + (r?.length ? ` · ${r.join("; ")}` : "");
  }
  if (e.type === "click") return String(d.link ?? "");
  if (e.type === "delay") return String(d.delayType ?? "");
  if (e.type === "reject") return String(d.reason ?? "");
  if (e.type === "failed" || e.type === "rendering_failure") return String(d.error ?? "");
  if (e.type === "delivery" && d.smtpResponse) return String(d.smtpResponse);
  return null;
}

function TextBody({ project, id }: { project: string; id: string }) {
  const text = useLoad(`email:${project}:text:${id}`, () => api.emailMessageText(project, id));
  return (
    <pre className="code-block max-h-[28rem] overflow-auto rounded-md bg-surface p-3 whitespace-pre-wrap">
      {text.data ? (text.data.text ?? "No text part") : text.state.status === "error" ? text.state.message : "Loading…"}
    </pre>
  );
}

function MessageInspector({ project, id, onClose }: { project: string; id: string; onClose: () => void }) {
  const msg = useLoad(`email:${project}:message:${id}`, () => api.emailMessage(project, id), { interval: (m) => (m && inProgress(m) ? POLL.progress : null) });
  const [view, setView] = useState<"html" | "text">("html");
  const m = msg.data;

  async function cancel() {
    try {
      await api.cancelEmail(project, id);
      toast.success("Canceled the email");
      invalidate(`email:${project}:`);
    } catch (err) {
      toast.error(errorMessage(err), { duration: Infinity });
    }
  }

  return (
    <Inspector
      open
      onOpenChange={(open) => !open && onClose()}
      kind="Email"
      identifier={id}
      wide
      description={m?.subject}
      actions={
        m && m.status === "queued" ? (
          <Button variant="danger-outline" onClick={() => void cancel()}>
            Cancel {new Date(m.sendAt) > new Date() ? "scheduled email" : "email"}
          </Button>
        ) : undefined
      }
    >
      {msg.state.status === "error" && <ErrorPanel title="Couldn't load the email" message={msg.state.message} onRetry={() => void msg.refresh()} />}
      {m && (
        <div className="grid gap-6">
          <Facts
            items={[
              ["Status", <StatusDot health={STATUS[m.status].health} label={STATUS[m.status].label} detail={m.error ?? undefined} />],
              ["From", <Mono>{m.from}</Mono>],
              ["To", <Mono>{m.to.join(", ")}</Mono>],
              ...(m.cc.length ? ([["Cc", <Mono>{m.cc.join(", ")}</Mono>]] as [ReactNode, ReactNode][]) : []),
              ...(m.bcc.length ? ([["Bcc", <Mono>{m.bcc.join(", ")}</Mono>]] as [ReactNode, ReactNode][]) : []),
              ...(m.replyTo.length ? ([["Reply to", <Mono>{m.replyTo.join(", ")}</Mono>]] as [ReactNode, ReactNode][]) : []),
              ["Template", m.template ? <a className="text-primary hover:underline" href={href(emailRoute(project, { tab: "templates", template: m.template }))}>{m.template}</a> : "—"],
              ["Queued", <span title={formatDate(m.createdAt)}><TimeAgo iso={m.createdAt} /></span>],
              ...(new Date(m.sendAt).getTime() - new Date(m.createdAt).getTime() > 5000 ? ([["Scheduled for", <TimeAgo iso={m.sendAt} live />]] as [ReactNode, ReactNode][]) : []),
              ...(Object.keys(m.tags).length
                ? ([["Tags", <span className="flex flex-wrap gap-1">{Object.entries(m.tags).map(([k, v]) => <Badge key={k} tone="outline" mono>{k}={v}</Badge>)}</span>]] as [ReactNode, ReactNode][])
                : []),
              ...(m.attachments.length
                ? ([["Attachments", <span className="grid gap-0.5">{m.attachments.map((a) => <span key={a.filename} className="flex items-center gap-1.5"><Paperclip className="size-3.5 text-muted-foreground" aria-hidden />{a.filename}</span>)}</span>]] as [ReactNode, ReactNode][])
                : []),
            ]}
          />
          <section aria-labelledby="email-events">
            <h3 id="email-events" className="mb-2 text-sm font-semibold">
              Events
            </h3>
            {m.events.length === 0 ? (
              <p className="text-muted-foreground">{inProgress(m) ? "Waiting to be sent…" : "No delivery events yet. They arrive from SES within a minute or so."}</p>
            ) : (
              <ol className="grid gap-2.5">
                {m.events.map((e, i) => {
                  const after = new Date(e.at).getTime() - new Date(m.createdAt).getTime();
                  return (
                    <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-3">
                      <time dateTime={e.at} title={formatDate(e.at)} className="text-muted-foreground tabular-nums">
                        {clock.format(new Date(e.at))}
                      </time>
                      <span className="min-w-0">
                        {EVENT_LABEL[e.type] ?? e.type}
                        {after >= 1000 && <span className="text-muted-foreground"> · {formatDuration(after)} later</span>}
                        {eventDetail(e) && <span className="block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{eventDetail(e)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
          <section aria-labelledby="email-body">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="email-body" className="text-sm font-semibold">
                What was sent
              </h3>
              <SegmentedControl label="Body" value={view} onChange={setView} options={[{ value: "html", label: "HTML" }, { value: "text", label: "Text" }]} />
            </div>
            {view === "html" ? (
              // Served with a sandbox CSP; sandbox="" here too: no scripts, no same-origin.
              <iframe sandbox="" src={`/projects/${project}/email/messages/${id}/html`} title="Email as sent" className="h-[32rem] w-full rounded-md border bg-white" />
            ) : (
              <TextBody project={project} id={id} />
            )}
          </section>
        </div>
      )}
    </Inspector>
  );
}

export function EmailLogs({ project, route, hasDomain }: { project: string; route: EmailRoute; hasDomain: boolean }) {
  const status = route.status ?? "";
  const [q, setQ] = useState(route.q ?? "");
  const [pages, setPages] = useState<EmailMessageSummary[][]>([]);
  const [next, setNext] = useState<string | null>(null);
  const key = `email:${project}:messages:${status}:${route.q ?? ""}`;
  const load = useLoad(key, () => api.emailMessages(project, { status: status || undefined, to: route.q || undefined, limit: 50 }), {
    interval: (d) => (d?.messages.some(inProgress) ? POLL.progress : POLL.list),
    keepPrevious: true,
  });

  // Filters are in the URL (replacing history); typing debounces.
  useEffect(() => {
    if (q === (route.q ?? "")) return;
    const t = setTimeout(() => navigate(emailRoute(project, { status: status || null, q }), { replace: true }), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPages([]);
    setNext(null);
  }, [key]);

  const first = load.data?.messages ?? [];
  const rows = [...first, ...pages.flat().filter((m) => !first.some((f) => f.id === m.id))];
  const cursor = pages.length ? next : (load.data?.next ?? null);

  async function more() {
    if (!cursor) return;
    try {
      const page = await api.emailMessages(project, { status: status || undefined, to: route.q || undefined, before: cursor, limit: 50 });
      setPages((p) => [...p, page.messages]);
      setNext(page.next);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const open = (id: string | null) => navigate(emailRoute(project, { status: status || null, q: route.q, message: id }));

  return (
    <section aria-label="Sent email" className="w-full">
      <div className={load.data && first.length === 0 && !status && !route.q ? "hidden" : "mb-3 flex flex-wrap items-center gap-2"}>
        <Input data-filter type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by recipient" aria-label="Filter by recipient" className="w-64 max-w-full" />
        <Select aria-label="Status" value={status} onChange={(e) => navigate(emailRoute(project, { status: e.target.value || null, q: route.q }), { replace: true })} wrapperClassName="w-44">
          <option value="">Any status</option>
          {EMAIL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
        <LiveIndicator load={load} className="ml-auto" />
      </div>
      {load.state.status === "loading" && <TableSkeleton label="Loading sent email" columns={5} />}
      {load.state.status === "error" && !load.data && <ErrorPanel title="Couldn't load sent email" message={load.state.message} onRetry={() => void load.refresh()} />}
      {load.data && rows.length === 0 && !status && !route.q ? (
        <EmptyState
          title="No email sent yet"
          action={
            hasDomain ? (
              <Button asChild variant="outline">
                <a href={href(emailRoute(project, { tab: "templates" }))}>Go to templates</a>
              </Button>
            ) : (
              <Button asChild>
                <a href={href(emailRoute(project, { tab: "domains" }))}>Add a domain</a>
              </Button>
            )
          }
        >
          Every email your apps send shows up here: who got it, what it said, and whether it was delivered, bounced, or opened.{" "}
          {hasDomain ? "Send a test from any template, or send from your app (see Connect)." : "Start by verifying a domain to send from."}
        </EmptyState>
      ) : (
        load.data && (
          <>
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead className="w-36">Sent</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="hidden lg:table-cell">Template</TableHead>
                  <TableHead className="w-40">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableEmpty colSpan={5}>No email matches these filters.</TableEmpty>}
                {rows.map((m) => (
                  <TableRow key={m.id} data-row data-state={route.message === m.id ? "selected" : undefined} className="relative h-10">
                    <TableCell className="text-muted-foreground" title={formatDate(m.createdAt)}>
                      <TimeAgo iso={m.createdAt} />
                    </TableCell>
                    <TableCell className="max-w-56 truncate">
                      <a
                        href={href(emailRoute(project, { status: status || null, q: route.q, message: m.id }))}
                        className="outline-none after:absolute after:inset-0 focus-visible:underline"
                        aria-label={`Email to ${m.to.join(", ")}: ${m.subject}`}
                      >
                        <Mono>{m.to[0]}</Mono>
                        {m.to.length > 1 && <span className="text-muted-foreground"> +{m.to.length - 1}</span>}
                      </a>
                    </TableCell>
                    <TableCell className="max-w-96 truncate">{m.subject}</TableCell>
                    <TableCell className="hidden lg:table-cell">{m.template ? <Mono>{m.template}</Mono> : <Empty />}</TableCell>
                    <TableCell title={m.error ?? undefined}>
                      <StatusDot health={STATUS[m.status].health} label={STATUS[m.status].label} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {cursor && (
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => void more()}>
                  Load older
                </Button>
              </div>
            )}
          </>
        )
      )}
      {route.message && <MessageInspector project={project} id={route.message} onClose={() => open(null)} />}
    </section>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import type { EmailDomain, EmailTemplate } from "@mybase/shared";
import { TEMPLATE_ID_PATTERN } from "./limits";
import { CodeEditor } from "@/components/code-editor";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorPanel, LinesSkeleton, TableSkeleton } from "@/components/states";
import { Badge, Mono } from "@/components/status";
import { SegmentedControl } from "@/components/tabs";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { invalidate, useLoad } from "@/lib/load";
import { href, navigate } from "@/lib/router";
import { emailRoute, type EmailRoute } from "./index";
import { useRenderFrame, type Rendered } from "./render-frame";

const starter = (from: string | null) => `import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";

// {{name}} placeholders: anything in PreviewProps becomes a variable apps pass when sending.
export const subject = "Welcome, {{name}}";
${from ? `export const from = "${from}";` : `// export const from = "hello@your-domain.com"; (a verified domain; or pass from when sending)`}
export const PreviewProps = { name: "Ann", url: "https://example.com/start" };

export default function Welcome({ name, url }: { name: string; url: string }) {
  return (
    <Html>
      <Head />
      <Preview>Thanks for signing up, {name}</Preview>
      <Body style={{ backgroundColor: "#f6f7f9", fontFamily: "system-ui, sans-serif" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "32px", borderRadius: "8px", margin: "40px auto", maxWidth: "480px" }}>
          <Heading style={{ fontSize: "22px", margin: "0 0 12px" }}>Hi {name},</Heading>
          <Text style={{ fontSize: "15px", lineHeight: "24px", color: "#374151" }}>
            Thanks for signing up. Click below to get started.
          </Text>
          <Button href={url} style={{ backgroundColor: "#111827", color: "#ffffff", padding: "10px 18px", borderRadius: "6px", fontSize: "14px" }}>
            Get started
          </Button>
        </Container>
      </Body>
    </Html>
  );
}
`;

// ---- list ---------------------------------------------------------------------

function TemplateList({ project }: { project: string }) {
  const list = useLoad(`email:${project}:templates`, () => api.emailTemplates(project));
  const create = () => navigate(emailRoute(project, { tab: "templates", template: "new" }));
  useCommands([{ id: "email-new-template", label: "New email template", icon: Plus, run: create }]);

  return (
    <section aria-label="Templates">
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-muted-foreground">React Email components. Apps send them by id with variables.</p>
        <Button size="sm" onClick={create}>
          <Plus />
          New template
        </Button>
      </div>
      {list.state.status === "loading" && <TableSkeleton label="Loading templates" columns={4} />}
      {list.state.status === "error" && <ErrorPanel title="Couldn't load templates" message={list.state.message} onRetry={() => void list.refresh()} />}
      {list.data && list.data.length === 0 && (
        <EmptyState title="No templates yet" action={<Button onClick={create}>New template</Button>}>
          Write one here in TSX with a live preview, or keep them in your repo (emails/*.tsx) and run <Mono>mybase email sync</Mono>.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Id</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="hidden md:table-cell">Variables</TableHead>
              <TableHead className="w-28">Source</TableHead>
              <TableHead className="hidden w-32 sm:table-cell">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((t) => (
              <TableRow key={t.id} data-row className="relative h-10">
                <TableCell>
                  <a href={href(emailRoute(project, { tab: "templates", template: t.id }))} className="outline-none after:absolute after:inset-0 focus-visible:underline">
                    <Mono>{t.id}</Mono>
                  </a>
                </TableCell>
                <TableCell className="max-w-80 truncate">{t.subject}</TableCell>
                <TableCell className="hidden max-w-60 truncate text-muted-foreground md:table-cell">{t.variables.map((v) => v.name).join(", ") || "—"}</TableCell>
                <TableCell>
                  <Badge tone="outline">{t.source === "code" ? "Code" : "Dashboard"}</Badge>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  <TimeAgo iso={t.updatedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

// ---- send test ----------------------------------------------------------------

function SendTestDialog({ project, id, samples, open, onOpenChange }: { project: string; id: string; samples: Record<string, string>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [to, setTo] = useState(() => {
    try {
      return localStorage.getItem("mybase.email.testTo") ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendTestEmail(project, id, to.trim(), samples);
      try {
        localStorage.setItem("mybase.email.testTo", to.trim());
      } catch {}
      onOpenChange(false);
      invalidate(`email:${project}:messages`);
      toast.success(`Sent a test to ${to.trim()}`, { action: { label: "View", onClick: () => navigate(emailRoute(project, { message: res.id })) } });
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
            <DialogTitle>Send a test of {id}</DialogTitle>
            <DialogDescription>With the sample values. In the SES sandbox, the address must be verified in SES.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-test-to">To</Label>
            <Input id="email-test-to" type="email" required autoFocus value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "email-test-error" : undefined} />
            {error && (
              <p id="email-test-error" role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !to.trim()}>
              {busy ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- editor -------------------------------------------------------------------

const WIDTHS = { desktop: 640, mobile: 375 } as const;

function Editor({ project, id: routeId, existing, domains }: { project: string; id: string | null; existing: EmailTemplate | null; domains: EmailDomain[] }) {
  const isNew = routeId === null;
  const readOnly = existing?.source === "code";
  const defaultFrom = domains.find((d) => d.status === "verified")?.domain;
  const [id, setId] = useState(existing?.id ?? "");
  const [source, setSource] = useState(existing?.tsx ?? starter(defaultFrom ? `hello@${defaultFrom}` : null));
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [view, setView] = useState<"html" | "text">("html");
  const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
  const [result, setResult] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { Frame, render, ready } = useRenderFrame();
  const latest = useRef(0);

  // Re-render on every edit (debounced), and when the view or samples change.
  useEffect(() => {
    if (!ready || readOnly) return;
    const run = ++latest.current;
    const t = setTimeout(async () => {
      const r = await render(source, view, samples);
      if (run !== latest.current) return;
      if (r.ok) {
        setResult(r);
        setError(null);
      } else setError(r.error);
    }, 300);
    return () => clearTimeout(t);
  }, [source, view, samples, ready, readOnly, render]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (readOnly) return;
    setSaveError(null);
    const finalId = (isNew ? id : routeId!).trim();
    if (!TEMPLATE_ID_PATTERN.test(finalId)) return setSaveError("Id: lowercase letters, digits, - and _ (like welcome or reset-password)");
    // Save what the code renders now, not a stale preview.
    const r = await render(source, view, samples);
    if (!r.ok) return setSaveError(`Fix the template first: ${r.error}`);
    setSaving(true);
    try {
      await api.saveEmailTemplate(project, finalId, { tsx: source, subject: r.subject, from: r.from, html: r.html, text: r.text, variables: r.variables, name: finalId });
      setDirty(false);
      invalidate(`email:${project}:template`);
      toast.success(`Saved ${finalId}`);
      if (isNew) navigate(emailRoute(project, { tab: "templates", template: finalId }), { replace: true });
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  useCommands(readOnly ? [] : [{ id: "email-save-template", label: "Save template", shortcut: "⌘S", run: () => void save() }]);

  const variables = result?.variables ?? existing?.variables ?? [];
  const testSamples = Object.fromEntries(variables.map((v) => [v.name, samples[v.name] ?? v.sample]));
  const back = href(emailRoute(project, { tab: "templates" }));
  const previewUrl = existing && readOnly ? `/projects/${project}/email/templates/${encodeURIComponent(existing.id)}/preview?vars=${encodeURIComponent(JSON.stringify(testSamples))}` : null;

  return (
    <section aria-label="Template editor" className="w-full">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <a href={back}>
            <ArrowLeft />
            Templates
          </a>
        </Button>
        {isNew ? (
          <Input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="template-id" aria-label="Template id" className="w-56 font-mono" autoFocus />
        ) : (
          <Mono className="text-base">{routeId}</Mono>
        )}
        {readOnly && <Badge tone="outline">From code: edit in the repo, then mybase email sync</Badge>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {!isNew && (
            <Button variant="outline" size="sm" onClick={() => setTesting(true)} disabled={dirty}>
              <Send />
              Send test
            </Button>
          )}
          {!readOnly && !isNew && (
            <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : isNew ? "Create template" : "Save"}
            </Button>
          )}
        </span>
      </div>
      {saveError && (
        <p role="alert" className="mb-3 text-destructive">
          {saveError}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-h-[32rem] flex-col gap-3">
          {readOnly ? (
            <div className="grid gap-2 rounded-md border p-3">
              <p>
                <span className="text-muted-foreground">Subject</span> {existing?.subject}
              </p>
              <p>
                <span className="text-muted-foreground">From</span> {existing?.from ?? "—"}
              </p>
            </div>
          ) : (
            <CodeEditor
              label="Template source (TSX)"
              value={source}
              onChange={(v) => {
                setSource(v);
                setDirty(true);
              }}
              onSave={() => void save()}
              className="h-[32rem] lg:h-[calc(100dvh-16rem)]"
            />
          )}
          {variables.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">Sample values</legend>
              {variables.map((v) => (
                <div key={v.name} className="grid grid-cols-[8rem_1fr] items-center gap-2">
                  <Label htmlFor={`email-var-${v.name}`} className="font-mono text-[13px]">
                    {v.name}
                  </Label>
                  <Input id={`email-var-${v.name}`} value={samples[v.name] ?? v.sample} onChange={(e) => setSamples((s) => ({ ...s, [v.name]: e.target.value }))} />
                </div>
              ))}
            </fieldset>
          )}
        </div>
        <div className="flex min-h-[32rem] flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl label="Preview width" value={width} onChange={setWidth} options={[{ value: "desktop", label: "Desktop" }, { value: "mobile", label: "Mobile" }]} />
            {!readOnly && <SegmentedControl label="Part" value={view} onChange={setView} options={[{ value: "html", label: "HTML" }, { value: "text", label: "Text" }]} />}
            {(result || readOnly) && (
              <p className="min-w-0 truncate text-muted-foreground">
                Subject: <span className="text-foreground">{readOnly ? existing?.subject : result?.subject}</span>
              </p>
            )}
          </div>
          {error && !readOnly && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 font-mono text-[13px] whitespace-pre-wrap text-destructive">
              {error}
            </p>
          )}
          <div className="flex min-h-0 flex-1 justify-center rounded-md bg-surface p-2">
            {readOnly ? (
              <iframe sandbox="" src={previewUrl!} title="Email preview" className="h-full min-h-[30rem] rounded-md border bg-white" style={{ width: WIDTHS[width], maxWidth: "100%" }} />
            ) : (
              <Frame width={WIDTHS[width]} className="min-h-[30rem]" />
            )}
          </div>
        </div>
      </div>
      {!isNew && <SendTestDialog project={project} id={routeId!} samples={testSamples} open={testing} onOpenChange={setTesting} />}
      {!isNew && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete template ${routeId}`}
          description="Apps sending it get an error until you make it again. Sent emails stay in the log."
          confirm="Delete template"
          pendingLabel="Deleting…"
          onConfirm={async () => {
            await api.deleteEmailTemplate(project, routeId!);
            invalidate(`email:${project}:template`);
            toast.success(`Deleted ${routeId}`);
            navigate(emailRoute(project, { tab: "templates" }));
          }}
        />
      )}
    </section>
  );
}

function EditExisting({ project, id, domains }: { project: string; id: string; domains: EmailDomain[] }) {
  const t = useLoad(`email:${project}:template:${id}`, () => api.emailTemplate(project, id), { refetchOnFocus: false });
  if (t.state.status === "loading") return <LinesSkeleton label="Loading template" lines={8} />;
  if (t.state.status === "error") return <ErrorPanel title={`Couldn't load template ${id}`} message={t.state.message} onRetry={() => void t.refresh()} />;
  return <Editor key={id} project={project} id={id} existing={t.state.data} domains={domains} />;
}

export function EmailTemplates({ project, route, domains }: { project: string; route: EmailRoute; domains: EmailDomain[] }) {
  if (route.template === "new") return <Editor project={project} id={null} existing={null} domains={domains} />;
  if (route.template) return <EditExisting project={project} id={route.template} domains={domains} />;
  return <TemplateList project={project} />;
}

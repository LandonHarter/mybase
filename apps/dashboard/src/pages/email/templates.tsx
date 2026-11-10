import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Send } from "lucide-react";
import { toast } from "sonner";
import type { EmailDomain, EmailTemplate, EmailTemplateSummary, EmailTemplateVariable } from "@mybase/shared";
import { TEMPLATE_ID_PATTERN } from "./limits";
import { CodeBlock } from "@/components/code-block";
import { CodeEditor } from "@/components/code-editor";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Facts } from "@/components/inspector";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorPanel, LinesSkeleton, TableSkeleton } from "@/components/states";
import { Badge, Empty, InlineCode, Mono } from "@/components/status";
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

// Anything in PreviewProps becomes a {{variable}} apps pass when they send.
export const subject = "Welcome, {{name}}";
${from ? `export const from = "${from}";` : `// export const from = "hello@your-domain.com"; (a verified domain, or pass from when sending)`}
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

const samplesOf = (variables: EmailTemplateVariable[], overrides: Record<string, string> = {}) => Object.fromEntries(variables.map((v) => [v.name, overrides[v.name] ?? v.sample]));

const SourceBadge = ({ source }: { source: EmailTemplateSummary["source"] }) =>
  source === "code" ? <Badge tone="outline" title="Kept in your repo and uploaded with mybase email sync">Code</Badge> : <Badge tone="outline">Dashboard</Badge>;

// ---- list ---------------------------------------------------------------------

export function EmailTemplates({ project }: { project: string }) {
  const list = useLoad(`email:${project}:templates`, () => api.emailTemplates(project));
  const [testing, setTesting] = useState<EmailTemplateSummary | null>(null);
  const create = () => navigate(emailRoute(project, { tab: "templates", template: "new" }));
  useCommands([{ id: "email-new-template", label: "New email template", icon: Plus, run: create }]);

  return (
    <section aria-label="Templates">
      {list.state.status === "loading" && <TableSkeleton label="Loading templates" columns={4} />}
      {list.state.status === "error" && !list.data && <ErrorPanel title="Couldn't load templates" message={list.state.message} onRetry={() => void list.refresh()} />}
      {list.data && list.data.length === 0 && (
        <EmptyState title="No templates yet" action={<Button onClick={create}>New template</Button>}>
          A template is a React Email component apps send by id, with variables like {"{{name}}"}. Write one here with a live preview, or keep them in your repo (<InlineCode>emails/*.tsx</InlineCode>) and run <InlineCode>mybase email sync</InlineCode>.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Id</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="hidden md:table-cell">Variables</TableHead>
              <TableHead className="hidden w-28 sm:table-cell">Made in</TableHead>
              <TableHead className="hidden w-32 sm:table-cell">Updated</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
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
                <TableCell className="hidden max-w-60 truncate md:table-cell">{t.variables.length ? <Mono className="text-muted-foreground">{t.variables.map((v) => v.name).join(", ")}</Mono> : <Empty />}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  <SourceBadge source={t.source} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  <TimeAgo iso={t.updatedAt} />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon-sm" className="relative z-10" aria-label={`Send a test of ${t.id}`} title="Send test" onClick={() => setTesting(t)}>
                    <Send />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {testing && <SendTestDialog project={project} id={testing.id} samples={samplesOf(testing.variables)} open onOpenChange={(o) => !o && setTesting(null)} />}
    </section>
  );
}

// ---- send test ----------------------------------------------------------------

function SendTestDialog({ project, id, samples, open, onOpenChange }: { project: string; id: string; samples: Record<string, string>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const status = useLoad("email:status", () => api.emailStatus(), { maxAge: 60_000 });
  const [to, setTo] = useState(() => {
    try {
      return localStorage.getItem("mybase.email.testTo") ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = Object.keys(samples);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = to.trim();
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendTestEmail(project, id, address, samples);
      try {
        localStorage.setItem("mybase.email.testTo", address);
      } catch {}
      onOpenChange(false);
      invalidate(`email:${project}:messages`);
      toast.success(`Sent a test of ${id} to ${address}`, { action: { label: "View", onClick: () => navigate(emailRoute(project, { message: res.id })) } });
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
            <DialogDescription>
              {names.length ? (
                <>
                  Filled with the sample values ({names.join(", ")}). It shows up in Sent like any other email.
                </>
              ) : (
                "It shows up in Sent like any other email."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-test-to">To</Label>
            <Input
              id="email-test-to"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "email-test-error" : status.data?.sandbox ? "email-test-hint" : undefined}
            />
            {error ? (
              <p id="email-test-error" role="alert" className="text-destructive">
                {error}
              </p>
            ) : (
              status.data?.sandbox && (
                <p id="email-test-hint" className="text-muted-foreground">
                  SES is in the sandbox, so this address must be verified in SES.
                </p>
              )
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !to.trim()}>
              <Send />
              {busy ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- editor -------------------------------------------------------------------

const WIDTHS = { desktop: 600, mobile: 375 } as const;

/** Preview width + HTML/Text, then the email in a white frame at that width. */
function Preview({ width, onWidth, view, onView, children, footer }: { width: keyof typeof WIDTHS; onWidth: (w: keyof typeof WIDTHS) => void; view?: "html" | "text"; onView?: (v: "html" | "text") => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-lg border lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-2 py-1.5">
        <span className="px-1 text-xs font-medium text-muted-foreground">Preview</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {view && onView && <SegmentedControl label="Part" value={view} onChange={onView} options={[{ value: "html", label: "HTML" }, { value: "text", label: "Text" }]} />}
          <SegmentedControl label="Preview width" value={width} onChange={onWidth} options={[{ value: "desktop", label: "Desktop" }, { value: "mobile", label: "Mobile" }]} />
        </span>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-surface">{children}</div>
      {footer}
    </div>
  );
}

function SampleValues({ variables, samples, onChange }: { variables: EmailTemplateVariable[]; samples: Record<string, string>; onChange: (name: string, value: string) => void }) {
  if (!variables.length) return null;
  return (
    <fieldset className="max-h-48 overflow-y-auto border-t px-3 py-2.5">
      <legend className="sr-only">Sample values</legend>
      <p className="mb-2 text-xs font-medium text-muted-foreground">Sample values (preview and test sends)</p>
      <div className="grid gap-2">
        {variables.map((v) => (
          <div key={v.name} className="grid grid-cols-[minmax(5rem,9rem)_1fr] items-center gap-2">
            <Label htmlFor={`email-var-${v.name}`} className="mono-value truncate font-normal">
              {v.name}
            </Label>
            <Input id={`email-var-${v.name}`} className="h-8" value={samples[v.name] ?? v.sample} onChange={(e) => onChange(v.name, e.target.value)} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** "Subject … · From …" under the title: what the recipient sees first. */
function Envelope({ subject, from }: { subject: string | null | undefined; from: string | null | undefined }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
      <span className="min-w-0 truncate">
        Subject <span className="text-foreground">{subject || "—"}</span>
      </span>
      <span className="min-w-0 truncate">
        From {from ? <Mono className="text-foreground">{from}</Mono> : <span>the default from</span>}
      </span>
    </span>
  );
}

function crumbs(project: string) {
  return [
    { label: project, href: href({ page: "project", name: project }) },
    { label: "Email", href: href(emailRoute(project, { tab: "templates" })) },
  ];
}

/** Templates from `mybase email sync`: read-only here, previewed from the stored HTML. */
function CodeTemplate({ project, template }: { project: string; template: EmailTemplate }) {
  const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const values = samplesOf(template.variables, samples);
  const previewUrl = `/projects/${project}/email/templates/${encodeURIComponent(template.id)}/preview?vars=${encodeURIComponent(JSON.stringify(values))}`;

  return (
    <>
      <PageHeader
        mono
        title={template.id}
        breadcrumb={crumbs(project)}
        aside={<SourceBadge source="code" />}
        description={<Envelope subject={template.subject} from={template.from} />}
        action={
          <Button variant="outline" onClick={() => setTesting(true)}>
            <Send />
            Send test
          </Button>
        }
      />
      <div className="grid gap-4 lg:h-[calc(100dvh-12rem)] lg:min-h-[34rem] lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <section aria-labelledby="tpl-source">
            <h2 id="tpl-source" className="mb-1 font-medium">
              Edited in your repo
            </h2>
            <p className="mb-3 text-muted-foreground">
              This template comes from <InlineCode>emails/{template.id}.tsx</InlineCode>. Change it there, then upload it again:
            </p>
            <CodeBlock code="mybase email sync" lang="sh" />
          </section>
          <Facts
            items={[
              ["Variables", template.variables.length ? <Mono>{template.variables.map((v) => v.name).join(", ")}</Mono> : <Empty />],
              ["Updated", <TimeAgo iso={template.updatedAt} />],
            ]}
          />
        </div>
        <Preview width={width} onWidth={setWidth} footer={<SampleValues variables={template.variables} samples={values} onChange={(n, v) => setSamples((s) => ({ ...s, [n]: v }))} />}>
          <iframe sandbox="" src={previewUrl} title="Email preview" className="h-full min-h-[30rem] bg-white" style={{ width: WIDTHS[width], maxWidth: "100%" }} />
        </Preview>
      </div>
      <SendTestDialog project={project} id={template.id} samples={values} open={testing} onOpenChange={setTesting} />
    </>
  );
}

function Editor({ project, id: routeId, existing, domains }: { project: string; id: string | null; existing: EmailTemplate | null; domains: EmailDomain[] }) {
  const isNew = routeId === null;
  const defaultFrom = domains.find((d) => d.status === "verified")?.domain;
  const [id, setId] = useState("");
  const [source, setSource] = useState(existing?.tsx ?? starter(defaultFrom ? `hello@${defaultFrom}` : null));
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [view, setView] = useState<"html" | "text">("html");
  const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
  const [result, setResult] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(isNew);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { Frame, render, ready } = useRenderFrame();
  const latest = useRef(0);
  const idInput = useRef<HTMLInputElement>(null);

  // Re-render on every edit (debounced), and when the view or samples change.
  useEffect(() => {
    if (!ready) return;
    const run = ++latest.current;
    const t = setTimeout(async () => {
      const r = await render(source, view, samples);
      if (run !== latest.current) return;
      if (r.ok) {
        setResult(r);
        setRenderError(null);
      } else setRenderError(r.error);
    }, 300);
    return () => clearTimeout(t);
  }, [source, view, samples, ready, render]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty || isNew) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, isNew]);

  async function save() {
    if (saving) return;
    setSaveError(null);
    setIdError(null);
    const finalId = (isNew ? id : routeId!).trim();
    if (!TEMPLATE_ID_PATTERN.test(finalId)) {
      setIdError(finalId ? "Use lowercase letters, digits, - and _, starting with a letter or digit." : "Give the template an id.");
      idInput.current?.focus();
      return;
    }
    // Save what the code renders now, not a stale preview.
    const r = await render(source, view, samples);
    if (!r.ok) return setSaveError(`Fix the template first: ${r.error}`);
    setSaving(true);
    try {
      await api.saveEmailTemplate(project, finalId, { tsx: source, subject: r.subject, from: r.from, html: r.html, text: r.text, variables: r.variables, name: finalId });
      setDirty(false);
      invalidate(`email:${project}:template`);
      toast.success(isNew ? `Created ${finalId}` : `Saved ${finalId}`);
      if (isNew) navigate(emailRoute(project, { tab: "templates", template: finalId }), { replace: true });
    } catch (err) {
      const message = errorMessage(err);
      if (isNew && /exist|taken|conflict/i.test(message)) setIdError(message);
      else setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  // ⌘S / Ctrl+S anywhere on the page, not only inside the editor.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useCommands([
    { id: "email-save-template", label: isNew ? "Create template" : "Save template", shortcut: "⌘S", run: () => void save() },
    ...(!isNew ? [{ id: "email-test-template", label: "Send a test email", icon: Send, run: () => setTesting(true) }] : []),
  ]);

  const variables = result?.variables ?? existing?.variables ?? [];
  const values = samplesOf(variables, samples);
  const subject = result?.subject ?? existing?.subject;
  const from = result ? result.from : existing?.from;

  return (
    <>
      <PageHeader
        mono={!isNew}
        title={isNew ? "New template" : routeId!}
        breadcrumb={crumbs(project)}
        aside={!isNew && dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : undefined}
        description={<Envelope subject={subject} from={from} />}
        action={
          <>
            {!isNew && (
              <>
                <Button variant="ghost" onClick={() => setDeleting(true)}>
                  Delete
                </Button>
                <Button variant="outline" onClick={() => setTesting(true)} disabled={dirty} title={dirty ? "Save first: tests send the saved version" : undefined}>
                  <Send />
                  Send test
                </Button>
              </>
            )}
            <Button onClick={() => void save()} disabled={saving || (!isNew && !dirty)}>
              {saving ? (isNew ? "Creating…" : "Saving…") : isNew ? "Create template" : "Save"}
            </Button>
          </>
        }
      />

      {isNew && (
        <div className="mb-4 grid max-w-xl gap-1.5">
          <Label htmlFor="email-template-id">Id</Label>
          <Input
            ref={idInput}
            id="email-template-id"
            value={id}
            onChange={(e) => {
              setId(e.target.value.toLowerCase());
              setIdError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void save()}
            placeholder="welcome"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="w-72 max-w-full font-mono"
            aria-invalid={!!idError}
            aria-describedby={idError ? "email-template-id-error" : "email-template-id-hint"}
          />
          {idError ? (
            <p id="email-template-id-error" role="alert" className="text-destructive">
              {idError}
            </p>
          ) : (
            <p id="email-template-id-hint" className="text-muted-foreground">
              Apps send it by this id. It can't be changed later.
            </p>
          )}
        </div>
      )}

      {saveError && (
        <ErrorPanel title={isNew ? "Couldn't create the template" : "Couldn't save the template"} message={saveError} className="mb-4" />
      )}

      <div className={isNew ? "grid gap-4 lg:h-[calc(100dvh-18rem)] lg:min-h-[34rem] lg:grid-cols-2" : "grid gap-4 lg:h-[calc(100dvh-12rem)] lg:min-h-[34rem] lg:grid-cols-2"}>
        <CodeEditor
          label="Template source (TSX)"
          value={source}
          onChange={(v) => {
            setSource(v);
            setDirty(true);
          }}
          className="h-[34rem] rounded-lg lg:h-full"
        />
        <Preview
          width={width}
          onWidth={setWidth}
          view={view}
          onView={setView}
          footer={
            <>
              {renderError && (
                <div role="alert" className="max-h-40 overflow-auto border-t border-destructive/30 bg-destructive/12 px-3 py-2">
                  <p className="text-xs font-medium text-destructive">Can't render. The preview shows the last version that worked.</p>
                  <pre className="mt-1 font-mono text-[12.5px] whitespace-pre-wrap text-destructive">{renderError}</pre>
                </div>
              )}
              <SampleValues variables={variables} samples={values} onChange={(n, v) => setSamples((s) => ({ ...s, [n]: v }))} />
            </>
          }
        >
          <Frame width={WIDTHS[width]} className="min-h-[30rem] rounded-none border-0" />
        </Preview>
      </div>

      {!isNew && <SendTestDialog project={project} id={routeId!} samples={values} open={testing} onOpenChange={setTesting} />}
      {!isNew && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete template ${routeId}`}
          description="Apps that send it get an error until you make it again. Emails already sent stay in the log."
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
    </>
  );
}

function ExistingTemplate({ project, id, domains }: { project: string; id: string; domains: EmailDomain[] }) {
  const t = useLoad(`email:${project}:template:${id}`, () => api.emailTemplate(project, id), { refetchOnFocus: false });
  const breadcrumb = crumbs(project);
  if (t.state.status !== "ready") {
    return (
      <>
        <PageHeader mono title={id} breadcrumb={breadcrumb} />
        {t.state.status === "loading" ? (
          <LinesSkeleton label="Loading template" lines={8} />
        ) : (
          <ErrorPanel
            title={`Couldn't load template ${id}`}
            message={t.state.message}
            onRetry={() => void t.refresh()}
            action={
              <Button asChild variant="ghost" size="sm">
                <a href={href(emailRoute(project, { tab: "templates" }))}>All templates</a>
              </Button>
            }
          />
        )}
      </>
    );
  }
  if (t.state.data.source === "code" || t.state.data.tsx === null) return <CodeTemplate project={project} template={t.state.data} />;
  return <Editor key={id} project={project} id={id} existing={t.state.data} domains={domains} />;
}

/** One template as an item page: `project / Email` breadcrumb, its id as the title. */
export function TemplatePage({ project, route, domains }: { project: string; route: EmailRoute; domains: EmailDomain[] }) {
  if (route.template === "new") return <Editor key="new" project={project} id={null} existing={null} domains={domains} />;
  return <ExistingTemplate project={project} id={route.template!} domains={domains} />;
}

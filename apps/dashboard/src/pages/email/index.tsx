import { useState } from "react";
import { Plus } from "lucide-react";
import type { EmailDomain, EmailServerStatus, EmailStatus, Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { ServiceOff } from "@/components/service-off";
import { ConnectMethod, ConnectSheet } from "@/components/service-layout";
import { CodeBlock } from "@/components/code-block";
import { EmptyState } from "@/components/states";
import { Badge, InlineCode, type Health } from "@/components/status";
import { RoutedTabs } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { href, navigate, type EmailTab, type Route } from "@/lib/router";
import { plural } from "@/lib/format";
import { EmailLogs } from "./logs";
import { EmailTemplates, TemplatePage } from "./templates";
import { EmailDomains } from "./domains";
import { EmailSettingsView } from "./settings";

export type EmailRoute = Extract<Route, { page: "email" }>;

export const emailRoute = (name: string, patch: Partial<Omit<EmailRoute, "page" | "name">> = {}): EmailRoute => ({
  page: "email",
  name,
  tab: "logs",
  template: null,
  message: null,
  ...patch,
});

export const STATUS: Record<EmailStatus, { label: string; health: Health }> = {
  queued: { label: "Queued", health: "progress" },
  sending: { label: "Sending", health: "progress" },
  sent: { label: "Sent", health: "neutral" },
  delivered: { label: "Delivered", health: "ok" },
  delayed: { label: "Delayed", health: "warning" },
  bounced: { label: "Bounced", health: "error" },
  complained: { label: "Marked as spam", health: "warning" },
  failed: { label: "Failed", health: "error" },
  canceled: { label: "Canceled", health: "neutral" },
};

const sendSnippet = (apiUrl: string, project: string) => `import { createEmailClient } from "@mybase-dev/sdk/email";

const email = createEmailClient({
  apiUrl: "${apiUrl}",
  project: "${project}",
  apiKey: process.env.MYBASE_API_KEY!,
});

await email.send({
  template: "welcome",
  to: "ann@example.com",
  variables: { name: "Ann" },
});`;

const syncSnippet = (project: string) => `// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";
export default defineConfig({ project: "${project}", email: { templates: "./emails" } });

// emails/welcome.tsx
import { Html, Body, Heading, Button } from "@react-email/components";
export const subject = "Welcome, {{name}}";
export const PreviewProps = { name: "Ann" };
export default function Welcome({ name }: { name: string }) {
  return <Html><Body><Heading>Hi {name}</Heading><Button href="https://example.com">Get started</Button></Body></Html>;
}`;

/** The server has no SES keys: nothing on the page can work until the owner runs one command. */
function NotSetUp() {
  return (
    <EmptyState title="Set up sending on this server first">
      <p>mybase sends through your own Amazon SES account. On the server, run this with an IAM user's access keys, then reload this page:</p>
      <CodeBlock code="mybase server email" lang="sh" className="mt-3" />
    </EmptyState>
  );
}

/** Live facts under the title: domains first (nothing sends without one), then SES limits. */
function facts(domains: EmailDomain[] | undefined, status: EmailServerStatus | null) {
  if (!domains) return undefined;
  const verified = domains.filter((d) => d.status === "verified").length;
  const waiting = domains.length - verified;
  const parts = [domains.length ? plural(verified, "verified domain", "verified domains") : "No sending domain yet"];
  if (waiting) parts.push(`${waiting} waiting for DNS`);
  if (status?.quota) parts.push(`${status.quota.sentLast24Hours.toLocaleString()} of ${status.quota.max24Hour.toLocaleString()} sent today`);
  return parts.join(" · ");
}

function Email({ project, route }: { project: Project; route: EmailRoute }) {
  const name = project.name;
  const status = useLoad("email:status", () => api.emailStatus(), { maxAge: 60_000 });
  const domains = useLoad(`email:${name}:domains`, () => api.emailDomains(name));
  const [addingDomain, setAddingDomain] = useState(false);
  const notSetUp = status.data ? !status.data.configured : false;
  const breadcrumb = { label: name, href: href({ page: "project", name }) };

  // The template editor is its own item page: no tabs, its own header and actions.
  if (route.template && !notSetUp) return <TemplatePage project={name} route={route} domains={domains.data ?? []} />;

  const tabs: { id: EmailTab; label: string }[] = [
    { id: "logs", label: "Sent" },
    { id: "templates", label: "Templates" },
    { id: "domains", label: "Domains" },
    { id: "settings", label: "Settings" },
  ];

  const primary =
    route.tab === "templates" ? (
      <Button onClick={() => navigate(emailRoute(name, { tab: "templates", template: "new" }))}>
        <Plus />
        New template
      </Button>
    ) : route.tab === "domains" ? (
      <Button onClick={() => setAddingDomain(true)}>
        <Plus />
        Add domain
      </Button>
    ) : null;

  const summary = notSetUp ? undefined : facts(domains.data, status.data ?? null);

  return (
    <>
      <PageHeader
        title="Email"
        breadcrumb={breadcrumb}
        aside={
          status.data?.sandbox ? (
            <a href={href(emailRoute(name, { tab: "settings" }))} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" title="SES only delivers to verified addresses, 200 a day. See Settings.">
              <Badge tone="warning" dot>
                SES sandbox
              </Badge>
            </a>
          ) : undefined
        }
        description={summary && <span aria-live="polite">{summary}</span>}
        action={
          !notSetUp && (
            <>
              <ConnectSheet title={`Send email from ${name}`}>
                <ConnectMethod title="From your app" hint={<>Server-side only, with an API key that has <InlineCode>email:write</InlineCode> for this project.</>}>
                  <CodeBlock code={sendSnippet(location.origin, name)} lang="ts" />
                </ConnectMethod>
                <ConnectMethod title="Templates in your repo" hint={<>React Email components in <InlineCode>emails/*.tsx</InlineCode>, rendered on your machine by <InlineCode>mybase email sync</InlineCode>.</>}>
                  <CodeBlock code={syncSnippet(name)} lang="tsx" />
                </ConnectMethod>
              </ConnectSheet>
              {primary}
            </>
          )
        }
      />
      {notSetUp ? (
        <NotSetUp />
      ) : (
        <>
          <RoutedTabs label="Email" current={route.tab} tabs={tabs.map((t) => ({ ...t, href: href(emailRoute(name, { tab: t.id })) }))} />
          {route.tab === "logs" && <EmailLogs project={name} route={route} hasDomain={(domains.data?.length ?? 0) > 0} />}
          {route.tab === "templates" && <EmailTemplates project={name} />}
          {route.tab === "domains" && <EmailDomains project={name} load={domains} adding={addingDomain} onAddingChange={setAddingDomain} />}
          {route.tab === "settings" && <EmailSettingsView project={name} status={status.data ?? null} />}
        </>
      )}
    </>
  );
}

export function EmailPage({ route }: { route: EmailRoute }) {
  return (
    <ProjectGate name={route.name} title="Email" backToProject>
      {(project) => {
        if (!project.services.includes("email")) {
          return (
            <ServiceOff project={project} id="email">
              Turn it on to send email from your own domains with React templates, and see who got what. Sends go through this server's Amazon SES account.
            </ServiceOff>
          );
        }
        return <Email project={project} route={route} />;
      }}
    </ProjectGate>
  );
}

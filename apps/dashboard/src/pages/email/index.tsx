import type { EmailServerStatus, EmailStatus, Project } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { ServiceOff } from "@/components/service-off";
import { ConnectSheet } from "@/components/service-layout";
import { Row } from "@/components/row";
import { CodeBlock } from "@/components/code-block";
import { ErrorPanel } from "@/components/states";
import { InlineCode, type Health } from "@/components/status";
import { RoutedTabs } from "@/components/tabs";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/load";
import { href, type EmailTab, type Route } from "@/lib/router";
import { plural } from "@/lib/format";
import { EmailLogs } from "./logs";
import { EmailTemplates } from "./templates";
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

const email = createEmailClient({ apiUrl: "${apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! });

await email.send({ template: "welcome", to: "ann@example.com", variables: { name: "Ann" } });`;

const syncSnippet = (project: string) => `// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";
export default defineConfig({ project: "${project}", email: { templates: "./emails" } });

// emails/welcome.tsx
import { Html, Body, Heading, Text, Button } from "@react-email/components";
export const subject = "Welcome, {{name}}";
export const PreviewProps = { name: "Ann" };
export default function Welcome({ name }: { name: string }) {
  return <Html><Body><Heading>Hi {name}</Heading><Button href="https://example.com">Get started</Button></Body></Html>;
}

// then: mybase email sync`;

/** Shown when the server has no SES keys: nothing on the page can work yet. */
function NotSetUp() {
  return (
    <ErrorPanel
      title="Email isn't set up on this server"
      message={
        <>
          mybase sends through your Amazon SES account. On the server, run <InlineCode>mybase server email</InlineCode> with an IAM user's keys, then reload this page.
        </>
      }
    />
  );
}

function SandboxNote({ status }: { status: EmailServerStatus }) {
  if (!status.sandbox) return null;
  return (
    <p className="mb-6 max-w-prose rounded-md border border-warning/40 bg-warning/12 px-3 py-2 text-warning">
      SES is in the sandbox ({status.region}): email only reaches addresses verified in SES, 200 a day. In the AWS console, open SES → Account dashboard → Request production access.
    </p>
  );
}

function Email({ project, route }: { project: Project; route: EmailRoute }) {
  const name = project.name;
  const status = useLoad("email:status", () => api.emailStatus(), { maxAge: 60_000 });
  const domains = useLoad(`email:${name}:domains`, () => api.emailDomains(name));
  const verified = domains.data?.filter((d) => d.status === "verified").length ?? 0;
  const apiUrl = location.origin;

  const tabs: { id: EmailTab; label: string }[] = [
    { id: "logs", label: "Sent" },
    { id: "templates", label: "Templates" },
    { id: "domains", label: "Domains" },
    { id: "settings", label: "Settings" },
  ];

  const facts = domains.data
    ? domains.data.length
      ? `${plural(verified, "verified domain", "verified domains")}${domains.data.length > verified ? ` · ${domains.data.length - verified} pending` : ""}`
      : "No domains yet"
    : undefined;

  return (
    <>
      <PageHeader
        title="Email"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description={facts && <span aria-live="polite">{facts}</span>}
        action={
          <ConnectSheet title={`Send email from ${name}`}>
            <Row title="From your app" hint="An API key with email:write for this project. Server-side only.">
              <CodeBlock code={sendSnippet(apiUrl, name)} lang="ts" />
            </Row>
            <Row title="Templates in your repo" hint="React Email components in emails/*.tsx, rendered on your machine and uploaded.">
              <CodeBlock code={syncSnippet(name)} lang="tsx" />
            </Row>
          </ConnectSheet>
        }
      />
      {status.data && !status.data.configured ? (
        <NotSetUp />
      ) : (
        <>
          {status.data && <SandboxNote status={status.data} />}
          {!route.template && <RoutedTabs label="Email" current={route.tab} tabs={tabs.map((t) => ({ ...t, href: href(emailRoute(name, { tab: t.id })) }))} />}
          {route.tab === "logs" && <EmailLogs project={name} route={route} />}
          {route.tab === "templates" && <EmailTemplates project={name} route={route} domains={domains.data ?? []} />}
          {route.tab === "domains" && <EmailDomains project={name} load={domains} />}
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

import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { Project } from "@mybase/shared";
import type { AiSettings } from "@mybase-dev/sdk/ai";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { CodeBlock } from "@/components/code-block";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { ConnectMethod, ConnectSheet } from "@/components/service-layout";
import { ServiceOff } from "@/components/service-off";
import { RoutedTabs, SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useLoad } from "@/lib/load";
import { AI_RANGES, AI_TABS, href, navigate, type AiRange, type AiTab } from "@/lib/router";
import { AiLogs } from "@/pages/ai/logs";
import { AiModels } from "@/pages/ai/models";
import { AiOverview } from "@/pages/ai/overview";
import { usd } from "@/pages/ai/parts";
import { AiPlayground } from "@/pages/ai/playground";
import { AiProviders } from "@/pages/ai/providers";
import { AiSettingsTab } from "@/pages/ai/settings";

const TAB_LABELS: Record<AiTab, string> = { overview: "Overview", logs: "Logs", playground: "Playground", providers: "Providers", models: "Models", settings: "Settings" };
const RANGE_LABELS: Record<AiRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

const openaiSnippet = (s: AiSettings) => `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: process.env.MYBASE_AI_URL, // ${s.baseURL}
  apiKey: process.env.MYBASE_API_KEY,
});
const res = await openai.chat.completions.create({
  model: "openai/gpt-5-mini", // or anthropic/…, google/…, an alias
  messages: [{ role: "user", content: "Hello" }],
});`;

const aiSdkSnippet = (s: AiSettings) => `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const mybase = createOpenAICompatible({
  name: "mybase",
  baseURL: "${s.baseURL}",
  apiKey: process.env.MYBASE_API_KEY,
  includeUsage: true,
});
const { text } = await generateText({ model: mybase("anthropic/claude-sonnet-4-5"), prompt: "Hello" });`;

const anthropicSnippet = (s: AiSettings) => `import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: "${s.nativeBaseURL}/anthropic",
  apiKey: process.env.MYBASE_API_KEY, // a mybase key: the gateway adds the real one
});`;

const curlSnippet = (s: AiSettings) => `curl ${s.baseURL}/chat/completions \\
  -H "Authorization: Bearer $MYBASE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"openai/gpt-5-mini","messages":[{"role":"user","content":"Hi"}],"mybase":{"tags":["test"]}}'`;

function Connect({ project, settings }: { project: string; settings: AiSettings }) {
  const [key, setKey] = useState(false);
  return (
    <>
      <ConnectSheet title={`Call models through ${project}'s AI gateway`} description="Apps hold a mybase API key with ai:write. Provider keys stay here.">
        <Row title="Base URL" hint="OpenAI-compatible: chat, embeddings, images, responses, models.">
          <CopyField id="ai-base" label="Base URL" value={settings.baseURL} />
        </Row>
        <Row title="Native SDKs" hint="A provider's own API, for its official SDK: append the provider id.">
          <CopyField id="ai-native" label="Native base URL" value={`${settings.nativeBaseURL}/<provider>`} />
        </Row>
        <Row title="API key" hint="Server-side only, as MYBASE_API_KEY. Limit it to this project.">
          <Button variant="outline" size="sm" onClick={() => setKey(true)}>
            <KeyRound />
            Create API key
          </Button>
        </Row>
        <ConnectMethod title="OpenAI SDK">
          <CodeBlock code={openaiSnippet(settings)} lang="ts" />
        </ConnectMethod>
        <ConnectMethod title="AI SDK" hint="Any OpenAI-compatible provider package works the same way.">
          <CodeBlock code={aiSdkSnippet(settings)} lang="ts" />
        </ConnectMethod>
        <ConnectMethod title="Anthropic SDK">
          <CodeBlock code={anthropicSnippet(settings)} lang="ts" />
        </ConnectMethod>
        <ConnectMethod title="curl">
          <CodeBlock code={curlSnippet(settings)} lang="bash" />
        </ConnectMethod>
      </ConnectSheet>
      <KeyDialog open={key} onOpenChange={setKey} preset={{ name: `${project} AI`, permissions: ["ai:write"], projects: [project] }} />
    </>
  );
}

interface AiRoute {
  name: string;
  tab: AiTab;
  range: AiRange;
  log?: string | null;
  model?: string | null;
  status?: string | null;
  tag?: string | null;
}

function AiLayout({ project, route }: { project: Project; route: AiRoute }) {
  const name = project.name;
  const settings = useLoad(`ai-settings:${name}`, () => api.aiSettings(name));
  const s = settings.data;
  const to = (tab: AiTab) => href({ page: "ai", name, tab, range: route.range });
  useCommands(AI_TABS.map((t) => ({ id: `ai-${t}`, label: `AI gateway: ${TAB_LABELS[t]}`, run: () => navigate({ page: "ai", name, tab: t, range: route.range }) })));

  return (
    <>
      <PageHeader
        title="AI gateway"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description={
          s ? (
            <span aria-live="polite">
              {usd(s.monthToDateUsd)} this month{s.budgetUsd !== null ? ` of ${usd(s.budgetUsd)}` : ""}
              {s.captureContent ? " · capturing content" : ""}
            </span>
          ) : (
            " "
          )
        }
        action={
          <>
            {route.tab === "overview" && (
              <SegmentedControl
                label="Time range"
                value={route.range}
                options={AI_RANGES.map((r) => ({ value: r, label: r, title: RANGE_LABELS[r] }))}
                onChange={(r) => navigate({ page: "ai", name, tab: route.tab, range: r }, { replace: true })}
              />
            )}
            {s && <Connect project={name} settings={s} />}
          </>
        }
      />
      <RoutedTabs label="AI gateway" current={route.tab} tabs={AI_TABS.map((t) => ({ id: t, label: TAB_LABELS[t], href: to(t) }))} />
      {route.tab === "overview" && <AiOverview project={name} range={route.range} />}
      {route.tab === "logs" && (
        <AiLogs project={name} range={route.range} log={route.log ?? null} model={route.model ?? null} status={route.status ?? null} tag={route.tag ?? null} />
      )}
      {route.tab === "playground" && <AiPlayground project={name} />}
      {route.tab === "models" && <AiModels project={name} />}
      {(route.tab === "providers" || route.tab === "settings") && (
        <>
          {settings.state.status === "loading" && <LoadingLines label="Loading settings" />}
          {settings.state.status === "error" && <LoadError what="AI settings" message={settings.state.message} onRetry={settings.refresh} />}
          {s && route.tab === "providers" && <AiProviders project={name} keysEnv={s.keysEnv} />}
          {s && route.tab === "settings" && <AiSettingsTab project={name} settings={s} onSaved={settings.refresh} />}
        </>
      )}
    </>
  );
}

export function AiPage(route: AiRoute) {
  return (
    <ProjectGate name={route.name} title="AI gateway" backToProject>
      {(project) =>
        project.services.includes("ai") ? (
          <AiLayout project={project} route={route} />
        ) : (
          <ServiceOff project={project} id="ai">
            One OpenAI-compatible endpoint for every LLM provider. Provider keys stay in this project's secrets; apps use a mybase API key, and every call is logged and priced.
          </ServiceOff>
        )
      }
    </ProjectGate>
  );
}

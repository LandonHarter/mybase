import { SERVICES, type ServiceId } from "@mybase/shared";
import Link from "next/link";
import { CopyCommand } from "@/components/copy-command";
import { githubUrl, installCommand } from "@/lib/shared";

/** Doc page for each service in SERVICES. */
const SERVICE_DOCS: Record<ServiceId, string> = {
  database: "database",
  storage: "storage",
  cron: "cron",
  analytics: "analytics",
  cache: "cache",
  ratelimit: "rate-limits",
  queue: "queues",
  search: "web-search",
  secrets: "secrets",
  vector: "vector",
  users: "users",
  captcha: "captcha",
  realtime: "realtime",
  sandbox: "sandboxes",
  registry: "registry",
  hosting: "hosting",
};

/** What `mybase project create shop` prints (apps/cli/src/index.ts), with made-up credentials. */
const TRANSCRIPT: { text: string; tone?: "muted" | "accent" | "command" }[] = [
  { text: "mybase project create shop", tone: "command" },
  { text: 'Created project "shop"', tone: "accent" },
  { text: "" },
  { text: "Postgres:" },
  { text: "  postgres://shop:9f2c…e41a@pi.local:5432/shop", tone: "muted" },
  { text: "" },
  { text: "Storage (S3):" },
  { text: "  endpoint           http://pi.local:3900", tone: "muted" },
  { text: "  region             garage", tone: "muted" },
  { text: "  bucket             shop", tone: "muted" },
  { text: "  access key id      GK3b9e0c4f1a7d2e85b6c0a913", tone: "muted" },
  { text: "  secret access key  4d1f…c07b", tone: "muted" },
  { text: "" },
  { text: "Save these now. The password and secret key aren't stored, so they can't be shown again." },
];

const SDK_SNIPPET = `import { createQueueClient } from "@mybase-dev/sdk/queue";

const queue = createQueueClient({ apiUrl, project: "shop", apiKey });

await queue.send("emails", { to: "ada@example.com" });
queue.consume("emails", async (msg) => sendEmail(msg.json()));`;

const HOSTS = [
  { name: "Raspberry Pi 4 or 5", detail: "4 GB is enough. Writes are batched to spare the SD card; an SSD is better for Postgres." },
  { name: "Any Linux or macOS box", detail: "Every image is built for arm64 and amd64. Docker Compose 2.23.1 or newer." },
  { name: "Reachable from anywhere", detail: "A Cloudflare Tunnel gives you HTTPS on your domain with no open router ports." },
];

const AGENT_WAYS = [
  { command: "mybase agent init", detail: "Writes AGENTS.md, a skill, and .mcp.json into your app." },
  { command: "/mcp", detail: "MCP server on every instance. Tools are limited to what the API key may do." },
  { command: "/llms.txt", detail: "These docs, served by your own instance, matching its version." },
];

export default function HomePage() {
  const core = SERVICES.filter((s) => s.core);
  const optional = SERVICES.filter((s) => !s.core);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-24 md:px-8">
      <section className="pt-16 md:pt-24">
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.02em] text-balance md:text-6xl">
          Your own backend platform, on hardware you already own.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-fd-muted-foreground">
          mybase gives every project its own Postgres database, S3 bucket, and credentials, plus cron, queues, cache, auth,
          realtime, and more when you need them. One Docker host runs all of it. Even a Raspberry Pi.
        </p>
        <div className="mt-8 max-w-2xl">
          <CopyCommand command={installCommand} />
          <p className="mt-2 text-sm text-fd-muted-foreground">Installs the CLI and starts the setup wizard. Nothing changes until you confirm.</p>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/docs/quickstart"
            className="inline-flex h-9 items-center rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
          >
            Read the quickstart
          </Link>
          <a
            href={githubUrl}
            className="inline-flex h-9 items-center rounded-md border border-fd-border px-4 text-sm font-medium hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <section aria-label="Creating a project" className="mt-16">
        <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card">
          <div className="flex items-center justify-between border-b border-fd-border px-4 py-2 text-xs text-fd-muted-foreground">
            <span className="font-mono">~/shop</span>
            <span>One command, one backend</span>
          </div>
          <pre className="terminal overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6">
            {TRANSCRIPT.map((line, i) => (
              <span
                key={i}
                style={{ animationDelay: `${i === 0 ? 0 : 600 + i * 70}ms` }}
                className={
                  line.tone === "command"
                    ? "terminal-command inline-block align-top"
                    : line.tone === "accent"
                      ? "block text-fd-primary"
                      : line.tone === "muted"
                        ? "block text-fd-muted-foreground"
                        : "block"
                }
              >
                {line.tone === "command" && <span className="select-none text-fd-muted-foreground">$ </span>}
                {line.text || " "}
              </span>
            ))}
          </pre>
        </div>
      </section>

      <section className="mt-24">
        <h2 className="text-2xl font-semibold tracking-tight">What a project gets</h2>
        <p className="mt-2 max-w-2xl text-fd-muted-foreground">
          One shared server per service, an isolated slice per project. Postgres and storage are always on; the rest you turn
          on per project, from the dashboard or the CLI.
        </p>
        <ServiceRows title="Always on" services={core} />
        <ServiceRows title="Turn on when you need it" services={optional} />
      </section>

      <section className="mt-24 grid gap-10 md:grid-cols-[14rem_1fr]">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Where it runs</h2>
          <p className="mt-2 text-fd-muted-foreground">No cloud account, no bill.</p>
        </div>
        <dl className="grid gap-6 sm:grid-cols-3">
          {HOSTS.map((h) => (
            <div key={h.name} className="border-t border-fd-border pt-4">
              <dt className="font-medium">{h.name}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fd-muted-foreground">{h.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-24 grid gap-10 md:grid-cols-[14rem_1fr]">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">From your app</h2>
          <p className="mt-2 text-fd-muted-foreground">
            Postgres is plain Postgres and storage is plain S3. Everything else is one zero-dependency SDK.
          </p>
          <Link href="/docs/sdk/getting-started" className="mt-4 inline-block text-sm font-medium text-fd-primary hover:underline">
            SDK guide
          </Link>
        </div>
        <div className="min-w-0 overflow-hidden rounded-xl border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border px-4 py-2 font-mono text-xs text-fd-muted-foreground">worker.ts</div>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6">{SDK_SNIPPET}</pre>
        </div>
      </section>

      <section className="mt-24 grid gap-10 md:grid-cols-[14rem_1fr]">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Built for agents</h2>
          <p className="mt-2 text-fd-muted-foreground">Your coding agent can read the docs and use your backend directly.</p>
          <Link href="/docs/agents" className="mt-4 inline-block text-sm font-medium text-fd-primary hover:underline">
            Using mybase with agents
          </Link>
        </div>
        <dl className="divide-y divide-fd-border border-y border-fd-border">
          {AGENT_WAYS.map((a) => (
            <div key={a.command} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="font-mono text-sm">{a.command}</dt>
              <dd className="text-sm text-fd-muted-foreground">{a.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-32 flex flex-col gap-4 border-t border-fd-border pt-6 text-sm text-fd-muted-foreground sm:flex-row sm:justify-between">
        <span>mybase is MIT licensed.</span>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/docs" className="hover:text-fd-foreground">Docs</Link>
          <Link href="/docs/cli" className="hover:text-fd-foreground">CLI reference</Link>
          <a href="/llms.txt" className="hover:text-fd-foreground">llms.txt</a>
          <a href={githubUrl} className="hover:text-fd-foreground">GitHub</a>
          <a href="https://www.npmjs.com/package/@mybase-dev/sdk" className="hover:text-fd-foreground">npm</a>
        </nav>
      </footer>
    </main>
  );
}

function ServiceRows({ title, services }: { title: string; services: readonly (typeof SERVICES)[number][] }) {
  return (
    <div className="mt-10 grid gap-2 md:grid-cols-[14rem_1fr] md:gap-10">
      <h3 className="text-sm font-medium text-fd-muted-foreground">{title}</h3>
      <ul className="divide-y divide-fd-border border-y border-fd-border">
        {services.map((s) => (
          <li key={s.id}>
            <Link
              href={`/docs/${SERVICE_DOCS[s.id]}`}
              className="group grid gap-0.5 py-3 hover:bg-fd-accent/50 focus-visible:outline-2 focus-visible:outline-fd-ring sm:grid-cols-[12rem_1fr] sm:gap-4 sm:px-2"
            >
              <span className="font-medium group-hover:text-fd-primary">{s.name}</span>
              <span className="text-sm text-fd-muted-foreground">{s.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { ReactNode } from "react";
import { Plus, Bot, Box, Container, ChartColumn, ChevronRight, Clock, Database, Gauge, Globe, Rocket, HardDrive, KeySquare, Layers, type LucideIcon, RadioTower, Sparkles, UsersRound, Zap } from "lucide-react";
import type { ServiceId } from "@mybase/shared";
import { Switch } from "@/components/ui/switch";
import type { Route } from "@/lib/router";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Each service's icon and page. A new service adds an entry here and a page.
 * Optional services also say what turning them on and off does, for the confirm step.
 */
/** Rail groups inside a project (N02). */
export type ServiceGroup = "data" | "compute" | "app";
export const SERVICE_GROUPS: { id: ServiceGroup; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "compute", label: "Compute" },
  { id: "app", label: "App" },
];

export interface ServicePage {
  icon: LucideIcon;
  route: (project: string) => Route;
  group: ServiceGroup;
  /** One line of value, for "Add a service" and the command menu. */
  summary: string;
  /** "What you get", on the turned-off page. */
  bullets?: string[];
  /** Heading of the turned-off page: "Queues are off". */
  offLabel: string;
  /** Platform docs slug (`docs/<slug>.md`), for the header's `?`. */
  docs: string;
  turnOn?: string;
  turnOff?: string;
  /** Extra ⌘K destinations inside the service (N15). */
  commands?: (project: string) => { label: string; keywords?: string; icon?: LucideIcon; to: Route }[];
}

export const SERVICE_PAGES: Record<ServiceId, ServicePage> = {
  database: { icon: Database, group: "data", summary: "Postgres: tables, SQL, extensions", offLabel: "Database", docs: "database", commands: (name) => [
      { label: "SQL editor", keywords: "query run", to: { page: "database", name, tab: "sql", table: null } },
      { label: "Database extensions", keywords: "postgis pgvector", to: { page: "database", name, tab: "extensions", table: null } },
      { label: "Database connection and settings", keywords: "connection string url password", to: { page: "database", name, tab: "settings", table: null } },
    ],
    route: (name) => ({ page: "database", name, tab: "tables", table: null }) },
  storage: { icon: HardDrive, group: "data", summary: "S3-compatible file storage", offLabel: "Storage", docs: "storage", route: (name) => ({ page: "storage", name, prefix: "" }) },
  cron: {
    icon: Clock, group: "compute", summary: "Call your app on a schedule", offLabel: "Cron is off", docs: "cron", bullets: ["Signed HTTP calls on a cron schedule, with retries", "Run history with status and duration", "One-off tasks scheduled from app code"],
    commands: (name) => [{ label: "New cron job", keywords: "create schedule", icon: Plus, to: { page: "cron", name, job: null, create: true } }],
    route: (name) => ({ page: "cron", name, job: null, create: false }),
    turnOn: "mybase will call your app's endpoints on a schedule, signed with a new secret only this project has.",
    turnOff: "Deletes every cron job, pending task, and run history. Jobs defined in code come back the next time you sync.",
  },
  analytics: {
    icon: ChartColumn, group: "app", summary: "Cookieless page views, events, errors", offLabel: "Analytics is off", docs: "analytics", bullets: ["Page views, routes, referrers, countries", "Custom events and error groups", "A script tag or the SDK; no cookies"],
    commands: (name) => [
      { label: "Analytics events", to: { page: "analytics", name, tab: "events", range: "7d" } },
      { label: "Analytics errors", keywords: "exceptions bugs", to: { page: "analytics", name, tab: "errors", range: "7d" } },
      { label: "Analytics setup and write key", keywords: "script tag", to: { page: "analytics", name, tab: "setup", range: "7d" } },
    ],
    route: (name) => ({ page: "analytics", name, tab: "overview", range: "7d" }),
    turnOn: "mybase will accept page views, events, and errors from your apps, sent with a new public write key.",
    turnOff: "Deletes every recorded page view, event, and error. Apps still sending events get 401s.",
  },
  cache: {
    icon: Zap, group: "data", summary: "Redis-compatible key-value cache", offLabel: "The cache is off", docs: "cache", bullets: ["Valkey over TCP (ioredis, redis-cli) or HTTP", "Keys scoped to this project", "A key browser to inspect and edit values"],
    route: (name) => ({ page: "cache", name, key: null, query: "" }),
    turnOn: "Your apps get a Redis-compatible cache: over TCP with a new password shown once, or over HTTP with an API key. Keys live in memory and may be evicted when it's full.",
    turnOff: "Deletes every key in this project's cache and its password. Apps still connected are disconnected.",
  },
  ratelimit: {
    icon: Gauge, group: "app", summary: "Shared request limits per user or IP", offLabel: "Rate limits are off", docs: "rate-limits", bullets: ["Sliding window, fixed window, token bucket", "Rules here or in mybase.config.ts", "Allowed/blocked stats per hour"],
    route: (name) => ({ page: "ratelimit", name }),
    turnOn: "Your apps can check shared rate limits with an API key. Define rules here or in mybase.config.ts.",
    turnOff: "Deletes every rule, counter, and stat. Apps still checking limits get 401s, which the SDK throws on instead of failing open.",
  },
  queue: {
    icon: Layers, group: "compute", summary: "Standard and FIFO message queues", offLabel: "Queues are off", docs: "queues", bullets: ["SQS-style queues with visibility timeouts", "Dead-letter queues and redrive", "Peek at messages without receiving them"],
    route: (name) => ({ page: "queue", name, queue: null }),
    turnOn: "Your apps can send and receive messages through queues with an API key. Define queues here, in mybase.config.ts, or from app code.",
    turnOff: "Deletes every queue and every message in them, including unprocessed ones. Apps still using queues get 401s.",
  },
  search: {
    icon: Globe, group: "app", summary: "Web search and page reading for AI agents", offLabel: "Web search is off", docs: "web-search", bullets: ["Search through this server's SearXNG", "Read any public URL as markdown", "Cached in the shared cache"],
    route: (name) => ({ page: "search", name }),
    turnOn: "Your apps can search the web and read pages as markdown with an API key, through this server's own SearXNG. Searches go out from this machine's IP.",
    turnOff: "Clears this project's cached searches and pages. Apps still searching get 404s.",
  },
  secrets: {
    icon: KeySquare, group: "data", summary: "Encrypted env vars per environment", offLabel: "Secrets are off", docs: "secrets", bullets: ["dev, staging, prod and branch environments", "Every change kept and restorable", "mybase run -- <cmd> injects them"],
    route: (name) => ({ page: "secrets", name, env: null }),
    turnOn: "Keep env vars and secrets here, encrypted, in dev, staging, and prod environments. Apps get them with mybase run or the SDK.",
    turnOff: "Deletes every environment, value, and revision. They can't be recovered. Apps reading secrets get 404s, and mybase run won't start them.",
  },
  vector: {
    icon: Sparkles, group: "data", summary: "Semantic + keyword search over documents", offLabel: "Vector search is off", docs: "vector", bullets: ["Named indexes in this project's database", "Vector, keyword, and hybrid queries", "Optional embedding provider"],
    route: (name) => ({ page: "vector", name, index: null }),
    turnOn: "Your apps can index documents and search them by meaning, keywords, or both, with an API key. Documents live in this project's database, in the mybase_vector schema.",
    turnOff: "Drops the mybase_vector schema: every index and document is deleted. Apps still querying get 404s.",
  },
  users: {
    icon: UsersRound, group: "app", summary: "Sign-in for your app with Better Auth", offLabel: "Users are off", docs: "users", bullets: ["Better Auth's tables in this database", "Users, sessions, bans in one place", "Sign-ins in the audit log"],
    route: (name) => ({ page: "users", name, user: null, query: "" }),
    turnOn: "Creates an auth schema in this project's database for Better Auth, which runs in your app and signs your users in. You'll see the users here, and sign-ins in the audit log.",
    turnOff: "Drops the auth schema: every user account, session, and sign-in method is deleted. Nobody can sign in to the app until it's set up again.",
  },
  captcha: {
    icon: Bot, group: "app", summary: "Self-hosted proof-of-work captcha", offLabel: "Captcha is off", docs: "captcha", bullets: ["No puzzles, cookies, or third party", "A widget script and server-side verify", "Turnstile-compatible siteverify"],
    route: (name) => ({ page: "captcha", name }),
    turnOn: "Your forms can check for bots with a self-hosted proof-of-work captcha: no puzzles, no cookies, no third party. Gets a new secret for your server.",
    turnOff: "Deletes the captcha's keys. Forms that check it refuse every submission until you remove the check.",
  },
  realtime: {
    icon: RadioTower, group: "app", summary: "WebSocket channels and presence", offLabel: "Realtime is off", docs: "realtime", bullets: ["Browsers subscribe, your server publishes", "Presence channels and webhooks", "Works with serverless hosts"],
    route: (name) => ({ page: "realtime", name }),
    turnOn: "Browsers can keep a WebSocket open to this server and subscribe to channels; your app's backend publishes over HTTP and signs tokens with a new secret. Works with apps on serverless hosts.",
    turnOff: "Closes every open connection and deletes the secret and settings. Pages listening for updates stop getting them.",
  },
  sandbox: {
    icon: Box, group: "compute", summary: "Isolated Node.js + Chromium workspaces", offLabel: "Sandboxes are off", docs: "sandboxes", bullets: ["Run untrusted code and browser automation", "Workspace files and artifacts", "Needs mybase server sandbox on the host"],
    commands: (name) => [
      { label: "Create sandbox", icon: Plus, to: { page: "sandbox", name, tab: "runs", sandbox: null, execution: null, query: "", action: "create" } },
      { label: "Sandbox setup and API key", to: { page: "sandbox", name, tab: "setup", sandbox: null, execution: null, query: "" } },
    ],
    route: (name) => ({ page: "sandbox", name, tab: "runs", sandbox: null, execution: null, query: "" }),
    turnOn: "Temporary, isolated Node.js + Chromium workspaces for untrusted code: user-submitted scripts, browser automation, screenshots and PDFs, file processing, or AI agent tools. Use them from the SDK, CLI, or dashboard. First run mybase server sandbox once on the Docker host; it installs and configures the worker automatically.",
    turnOff: "Stops every sandbox and deletes all sandbox artifacts and execution history for this project.",
  },
  registry: {
    icon: Container, group: "compute", summary: "Private Docker image registry", offLabel: "The registry is off", docs: "registry", bullets: ["docker push and pull with an API key", "Repos and tags per project", "Needs mybase server registry on the host"],
    route: (name) => ({ page: "registry", name, repo: null }),
    turnOn: "A private Docker image registry for this project: sign in with an API key (registry:write), then docker push and pull <host>/<project>/<name>. First run mybase server registry once on the Docker host (mybase server hosting includes it).",
    turnOff: "Every image in this project's registry is deleted. Turn hosting off first if it's on: it stores its site images here.",
  },
  hosting: {
    icon: Rocket, group: "compute", summary: "Run your sites as containers here", offLabel: "Hosting is off", docs: "hosting", bullets: ["mybase deploy builds and ships", "Zero-downtime switch after a health check", "Custom domains, logs, rollbacks"],
    route: (name) => ({ page: "hosting", name, site: null }),
    turnOn: "Your sites run as containers on this server, at <site>.<your domain>. Build and push with mybase deploy. Turns on the container registry too (site images live there). First run mybase server hosting once on the Docker host.",
    turnOff: "Every site in this project goes offline, and its deploys, images, and env vars are deleted.",
  },
};

/**
 * One service on the project page. When it's on, the whole card links to the service's page.
 * When it's off, the card is greyed out and only the switch works. Core services have no switch.
 */
export function ServiceCard({
  id,
  project,
  name,
  description,
  status,
  on,
  onToggle,
}: {
  id: ServiceId;
  project: string;
  name: string;
  description: string;
  /** One short line of live state, e.g. size and table count. Replaced by "Off" when off. */
  status: ReactNode;
  on: boolean;
  /** Asks to turn the service on or off. Omitted for core services. */
  onToggle?: (on: boolean) => void;
}) {
  const { icon: Icon, route } = SERVICE_PAGES[id];
  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 rounded-lg border p-4",
        on
          ? "group hover:bg-accent has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50"
          : "border-dashed text-muted-foreground",
      )}
    >
      <span className="flex items-center gap-2.5">
        <Icon className="size-4 text-muted-foreground" />
        {on ? (
          // The link's ::after covers the card, so the whole card is clickable.
          <a href={href(route(project))} className="font-medium outline-none after:absolute after:inset-0 after:rounded-lg">
            {name}
          </a>
        ) : (
          <span className="font-medium">{name}</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {on && !onToggle && <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
          {onToggle && (
            // Above the link's overlay so clicking it doesn't open the page.
            <Switch className="relative z-10" checked={on} onCheckedChange={onToggle} aria-label={name} />
          )}
        </span>
      </span>
      <span className="text-muted-foreground">{description}</span>
      <span className="mt-auto border-t pt-3 text-muted-foreground">{on ? status : "Off"}</span>
    </div>
  );
}

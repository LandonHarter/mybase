import type { ReactNode } from "react";
import { Bot, ChartColumn, ChevronRight, Clock, Database, Gauge, Globe, HardDrive, KeySquare, Layers, type LucideIcon, RadioTower, Sparkles, UsersRound, Zap } from "lucide-react";
import type { ServiceId } from "@mybase/shared";
import { Switch } from "@/components/ui/switch";
import type { Route } from "@/lib/router";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Each service's icon and page. A new service adds an entry here and a page.
 * Optional services also say what turning them on and off does, for the confirm step.
 */
export const SERVICE_PAGES: Record<
  ServiceId,
  { icon: LucideIcon; route: (project: string) => Route; turnOn?: string; turnOff?: string }
> = {
  database: { icon: Database, route: (name) => ({ page: "database", name, tab: "tables", table: null }) },
  storage: { icon: HardDrive, route: (name) => ({ page: "storage", name, prefix: "" }) },
  cron: {
    icon: Clock,
    route: (name) => ({ page: "cron", name, job: null, create: false }),
    turnOn: "mybase will call your app's endpoints on a schedule, signed with a new secret only this project has.",
    turnOff: "Deletes every cron job, pending task, and run history. Jobs defined in code come back the next time you sync.",
  },
  analytics: {
    icon: ChartColumn,
    route: (name) => ({ page: "analytics", name, tab: "overview", range: "7d" }),
    turnOn: "mybase will accept page views, events, and errors from your apps, sent with a new public write key.",
    turnOff: "Deletes every recorded page view, event, and error. Apps still sending events get 401s.",
  },
  cache: {
    icon: Zap,
    route: (name) => ({ page: "cache", name, key: null, query: "" }),
    turnOn: "Your apps get a Redis-compatible cache: over TCP with a new password shown once, or over HTTP with an API key. Keys live in memory and may be evicted when it's full.",
    turnOff: "Deletes every key in this project's cache and its password. Apps still connected are disconnected.",
  },
  ratelimit: {
    icon: Gauge,
    route: (name) => ({ page: "ratelimit", name }),
    turnOn: "Your apps can check shared rate limits with an API key. Define rules here or in mybase.config.ts.",
    turnOff: "Deletes every rule, counter, and stat. Apps still checking limits get 401s, which the SDK throws on instead of failing open.",
  },
  queue: {
    icon: Layers,
    route: (name) => ({ page: "queue", name, queue: null }),
    turnOn: "Your apps can send and receive messages through queues with an API key. Define queues here, in mybase.config.ts, or from app code.",
    turnOff: "Deletes every queue and every message in them, including unprocessed ones. Apps still using queues get 401s.",
  },
  search: {
    icon: Globe,
    route: (name) => ({ page: "search", name }),
    turnOn: "Your apps can search the web and read pages as markdown with an API key, through this server's own SearXNG. Searches go out from this machine's IP.",
    turnOff: "Clears this project's cached searches and pages. Apps still searching get 404s.",
  },
  secrets: {
    icon: KeySquare,
    route: (name) => ({ page: "secrets", name, env: null }),
    turnOn: "Keep env vars and secrets here, encrypted, in dev, staging, and prod environments. Apps get them with mybase run or the SDK.",
    turnOff: "Deletes every environment, value, and revision. They can't be recovered. Apps reading secrets get 404s, and mybase run won't start them.",
  },
  vector: {
    icon: Sparkles,
    route: (name) => ({ page: "vector", name, index: null }),
    turnOn: "Your apps can index documents and search them by meaning, keywords, or both, with an API key. Documents live in this project's database, in the mybase_vector schema.",
    turnOff: "Drops the mybase_vector schema: every index and document is deleted. Apps still querying get 404s.",
  },
  users: {
    icon: UsersRound,
    route: (name) => ({ page: "users", name, user: null, query: "" }),
    turnOn: "Creates an auth schema in this project's database for Better Auth, which runs in your app and signs your users in. You'll see the users here, and sign-ins in the audit log.",
    turnOff: "Drops the auth schema: every user account, session, and sign-in method is deleted. Nobody can sign in to the app until it's set up again.",
  },
  captcha: {
    icon: Bot,
    route: (name) => ({ page: "captcha", name }),
    turnOn: "Your forms can check for bots with a self-hosted proof-of-work captcha: no puzzles, no cookies, no third party. Gets a new secret for your server.",
    turnOff: "Deletes the captcha's keys. Forms that check it refuse every submission until you remove the check.",
  },
  realtime: {
    icon: RadioTower,
    route: (name) => ({ page: "realtime", name }),
    turnOn: "Browsers can keep a WebSocket open to this server and subscribe to channels; your app's backend publishes over HTTP and signs tokens with a new secret. Works with apps on serverless hosts.",
    turnOff: "Closes every open connection and deletes the secret and settings. Pages listening for updates stop getting them.",
  },
  sandbox: {
    icon: Bot,
    route: () => ({ page: "docs", service: "mybase", slug: "sandboxes", section: null }),
    turnOn: "Enable temporary isolated JavaScript and Chromium workspaces through the SDK and CLI. Requires a configured gVisor sandbox worker.",
    turnOff: "Stops every sandbox and deletes all sandbox artifacts and execution history for this project.",
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

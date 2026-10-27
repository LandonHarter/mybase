import type { ReactNode } from "react";
import { ChevronRight, Clock, Database, HardDrive, type LucideIcon } from "lucide-react";
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
    turnOff: "Deletes every cron job and its run history. Jobs defined in code come back the next time you sync.",
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

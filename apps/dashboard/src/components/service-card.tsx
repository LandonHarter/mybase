import type { ReactNode } from "react";
import { ChevronRight, Clock, Database, HardDrive, type LucideIcon } from "lucide-react";
import type { ServiceId } from "@mybase/shared";
import type { Route } from "@/lib/router";
import { href } from "@/lib/router";

/** Each service's icon and page. A new service adds an entry here and a page. */
export const SERVICE_PAGES: Record<ServiceId, { icon: LucideIcon; route: (project: string) => Route }> = {
  database: { icon: Database, route: (name) => ({ page: "database", name, tab: "tables", table: null }) },
  storage: { icon: HardDrive, route: (name) => ({ page: "storage", name, prefix: "" }) },
  cron: { icon: Clock, route: (name) => ({ page: "cron", name, job: null, create: false }) },
};

/** One service on the project page. The whole card links to the service's page. */
export function ServiceCard({
  id,
  project,
  name,
  description,
  status,
}: {
  id: ServiceId;
  project: string;
  name: string;
  description: string;
  /** One short line of live state, e.g. size and table count. */
  status: ReactNode;
}) {
  const { icon: Icon, route } = SERVICE_PAGES[id];
  return (
    <a
      href={href(route(project))}
      className="group flex flex-col gap-3 rounded-lg border p-4 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex items-center gap-2.5">
        <Icon className="size-4 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="text-muted-foreground">{description}</span>
      <span className="mt-auto border-t pt-3 text-muted-foreground">{status}</span>
    </a>
  );
}

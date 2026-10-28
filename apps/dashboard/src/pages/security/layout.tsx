import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { href, SECURITY_TABS, type SecurityTab } from "@/lib/router";
import { cn } from "@/lib/utils";

export const SECURITY_TAB_LABELS: Record<SecurityTab, string> = {
  advisor: "Advisor",
  audit: "Audit log",
  alerts: "Alerts",
};

const DESCRIPTIONS: Record<SecurityTab, string> = {
  advisor: "Read-only checks for common mistakes across this server and every project.",
  audit: "Who did what: sign-ins, API keys, projects, services, secret reads, and database changes.",
  alerts: "Get a message when something suspicious happens: a burst of failed sign-ins, 2FA turned off, a new admin key.",
};

/** Header + tab bar shared by every Security tab. */
export function SecurityLayout({ tab, action, children }: { tab: SecurityTab; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader title="Security" description={DESCRIPTIONS[tab]} action={action} />
      {SECURITY_TABS.length > 1 && (
        <nav aria-label="Security" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
          {SECURITY_TABS.map((t) => (
            <a
              key={t}
              href={href({ page: "security", tab: t, project: null })}
              aria-current={t === tab ? "page" : undefined}
              className={cn(
                "border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground outline-none",
                "hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
                t === tab && "border-foreground font-medium text-foreground",
              )}
            >
              {SECURITY_TAB_LABELS[t]}
            </a>
          ))}
        </nav>
      )}
      {children}
    </>
  );
}

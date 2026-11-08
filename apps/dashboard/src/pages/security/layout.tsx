import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { RoutedTabs } from "@/components/tabs";
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
        <RoutedTabs label="Security" current={tab} tabs={SECURITY_TABS.map((t) => ({ id: t, label: SECURITY_TAB_LABELS[t], href: href({ page: "security", tab: t, project: null }) }))} />
      )}
      {children}
    </>
  );
}

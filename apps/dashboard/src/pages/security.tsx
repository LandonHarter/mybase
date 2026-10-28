import type { SecurityTab } from "@/lib/router";
import { AdvisorTab } from "@/pages/security/advisor";
import { AlertsTab } from "@/pages/security/alerts";
import { AuditTab } from "@/pages/security/audit";

/** Instance-wide security: the advisor's checks, the audit log, and alerts. */
export function SecurityPage({ tab, project, action, outcome }: { tab: SecurityTab; project: string | null; action: string | null; outcome: string | null }) {
  switch (tab) {
    case "advisor":
      return <AdvisorTab project={project} />;
    case "audit":
      return <AuditTab project={project} action={action} outcome={outcome} />;
    case "alerts":
      return <AlertsTab />;
  }
}

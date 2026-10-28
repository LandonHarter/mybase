import { CircleAlert, CircleCheck, Info, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { ADVISOR_SEVERITIES, type AdvisorFinding, type AdvisorSeverity } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { timeAgo, formatDate } from "@/lib/format";
import { useLoad } from "@/lib/load";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { SecurityLayout } from "./layout";

const SEVERITY: Record<AdvisorSeverity, { label: string; heading: string; icon: LucideIcon; className: string }> = {
  critical: { label: "Critical", heading: "Fix now", icon: CircleAlert, className: "text-destructive" },
  warn: { label: "Warning", heading: "Worth fixing", icon: TriangleAlert, className: "text-foreground" },
  info: { label: "Info", heading: "Good to know", icon: Info, className: "text-muted-foreground" },
};

function FindingRow({ finding }: { finding: AdvisorFinding }) {
  const { icon: Icon, label, className } = SEVERITY[finding.severity];
  return (
    <li className="grid gap-1 border-t py-4 sm:grid-cols-[14rem_1fr] sm:gap-8">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-label={label} />
        <div className="min-w-0">
          <p className="font-medium">{finding.title}</p>
          {finding.project && (
            <a href={href({ page: "project", name: finding.project })} className="text-muted-foreground hover:text-foreground hover:underline">
              {finding.project}
            </a>
          )}
        </div>
      </div>
      <div className="min-w-0 max-sm:pl-6">
        <p>{finding.detail}</p>
        <p className="mt-1 text-muted-foreground">
          <span className="font-medium text-foreground">Fix:</span> {finding.fix}
        </p>
        {finding.docs && (
          <a href={href({ page: "docs", service: "mybase", slug: finding.docs, section: null })} className="mt-1 inline-block text-muted-foreground hover:text-foreground hover:underline">
            Read more
          </a>
        )}
      </div>
    </li>
  );
}

export function AdvisorTab({ project }: { project: string | null }) {
  const { state, refresh } = useLoad(`advisor:${project ?? ""}`, () => (project ? api.projectAdvisor(project) : api.advisor()));
  const action = (
    <Button variant="outline" onClick={() => void refresh()} disabled={state.status === "loading"}>
      <RotateCw />
      Run checks again
    </Button>
  );

  return (
    <SecurityLayout tab="advisor" action={action}>
      {project && (
        <p className="mb-4 text-muted-foreground">
          Showing project <span className="font-medium text-foreground">{project}</span> only.{" "}
          <a href={href({ page: "security", tab: "advisor", project: null })} className="underline hover:text-foreground">
            Show everything
          </a>
        </p>
      )}
      {state.status === "loading" && <LoadingLines label="Running checks" lines={4} />}
      {state.status === "error" && <LoadError what="the security checks" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" &&
        (state.data.findings.length === 0 ? (
          <div className="flex max-w-prose items-start gap-3 rounded-lg border border-dashed p-5">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="font-medium">No problems found</p>
              <p className="mt-1 text-muted-foreground">
                All {state.data.checks.length} checks passed, {timeAgo(state.data.checkedAt)}. They run each time you open this page.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 text-muted-foreground" title={formatDate(state.data.checkedAt)}>
              {state.data.findings.length} finding{state.data.findings.length === 1 ? "" : "s"} from {state.data.checks.length} checks, {timeAgo(state.data.checkedAt)}.
            </p>
            {ADVISOR_SEVERITIES.map((severity) => {
              const findings = state.data.findings.filter((f) => f.severity === severity);
              if (findings.length === 0) return null;
              return (
                <section key={severity} aria-labelledby={`advisor-${severity}`} className="mt-6">
                  <h2 id={`advisor-${severity}`} className="mb-1 text-base font-semibold">
                    {SEVERITY[severity].heading} <span className="font-normal text-muted-foreground">{findings.length}</span>
                  </h2>
                  <ul>
                    {findings.map((f) => (
                      <FindingRow key={`${f.project}:${f.id}`} finding={f} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        ))}
    </SecurityLayout>
  );
}

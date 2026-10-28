// `mybase doctor [project]`: the security advisor's findings (read-only).
import type { AdvisorFinding, AdvisorReport } from "@mybase/shared";
import { api } from "./api";
import { CliError, jsonMode, print } from "./output";

export const doctorUsage = `  doctor [<project>]             Security checks: the whole instance (admin key), or one project. Exits 1 on critical findings`;

const LABELS: Record<AdvisorFinding["severity"], string> = { critical: "CRITICAL", warn: "warning", info: "info" };

/** Handles `mybase doctor …`. */
export async function doctor(args: string[]): Promise<void> {
  const project = args.find((a) => !a.startsWith("-"));
  const report = await api<AdvisorReport>(project ? `/projects/${encodeURIComponent(project)}/advisor` : "/advisor");
  print(report, () => {
    const scope = project ? `project "${project}"` : "this instance";
    if (report.findings.length === 0) {
      console.log(`No problems found in ${scope} (${report.checks.length} checks).`);
      return;
    }
    console.log(`${report.findings.length} finding(s) in ${scope}:\n`);
    for (const f of report.findings) {
      console.log(`${LABELS[f.severity]}  ${f.title}${f.project && !project ? `  [${f.project}]` : ""}`);
      console.log(`  ${f.detail}`);
      console.log(`  Fix: ${f.fix}\n`);
    }
  });
  const critical = report.findings.filter((f) => f.severity === "critical").length;
  // With --json the report is already printed; the exit code still says whether to worry.
  if (critical) {
    if (jsonMode) process.exit(1);
    throw new CliError(`${critical} critical finding(s)`);
  }
}

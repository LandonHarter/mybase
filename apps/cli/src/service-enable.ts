// `mybase <service> enable`: turns on an optional service and, when the project has linked
// secrets envs (`mybase secrets link`), offers to add the service's keys to them.
import type { EnableServiceResponse, SecretsOverview, ServiceId } from "@mybase/shared";
import { api } from "./api";
import { jsonMode } from "./output";

/** Linked secrets envs; empty when secrets are off or the key can't read them. */
async function linkedEnvs(project: string): Promise<string[]> {
  const overview = await api<SecretsOverview>(`/projects/${encodeURIComponent(project)}/secrets`).catch(() => null);
  return overview?.envs.filter((e) => e.linked).map((e) => e.name) ?? [];
}

/**
 * Turns on `id`. With linked envs, `--link` adds its keys to them, `--no-link` doesn't, and
 * otherwise the CLI asks (no terminal, or `--json`: it doesn't). `linked` = the envs written.
 */
export async function enableService(
  project: string,
  id: ServiceId,
  flags: Map<string, string | true>,
): Promise<{ result: EnableServiceResponse | undefined; linked: string[] }> {
  const envs = flags.has("no-link") ? [] : await linkedEnvs(project);
  let link = envs.length > 0 && flags.has("link");
  if (envs.length > 0 && !link && !jsonMode && process.stdin.isTTY) {
    const answer = prompt(`Add the ${id} keys to the linked secrets envs (${envs.join(", ")})? [Y/n]`);
    link = !answer?.trim() || /^y/i.test(answer.trim());
  }
  const path = `/projects/${encodeURIComponent(project)}/services/${id}`;
  const result = await api<EnableServiceResponse | undefined>(path, link ? { method: "PUT", body: JSON.stringify({ link: true }) } : { method: "PUT" });
  return { result, linked: link ? envs : [] };
}

/** One line after the service's own output, when its keys went into secrets. */
export function printLinked(project: string, linked: string[], flags: Map<string, string | true>) {
  if (linked.length > 0) console.log(`\nKeys added to the linked secrets envs: ${linked.join(", ")} (mybase run -p ${project} -e ${linked[0]} -- …)`);
  else if (flags.has("link")) console.log(`\nNo linked secrets envs yet: mybase secrets link -p ${project} -e prod`);
}

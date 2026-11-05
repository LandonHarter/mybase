// `mybase registry …`: a project's private container registry (docker push/pull with an API key).
import type { RegistryOverview, RegistryTag, RegistryTags } from "@mybase/shared";
import { api } from "./api";
import { need, parseArgs } from "./cron";
import { confirm, print, usageError } from "./output";

export const registryUsage = `  registry enable <project>      Turn on the container registry (needs \`mybase server registry\` once)
  registry info <project>        docker login instructions and the image prefix (<host>/<project>/<name>)
  registry list <project>        Repositories and their tag counts
  registry tags <project> <repo>  Tags of one repository: digest, size, platforms
  registry delete <project> <repo> <digest> [--yes]  Delete an image (every tag pointing at it)
  registry disable <project> [--yes]  Turn it off: every image in the project is deleted`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/registry`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function printInfo(project: string, o: RegistryOverview) {
  console.log("Sign in (user name: anything; password: an API key with registry:write, or registry:read to pull):");
  console.log(`  mybase token create ${project}-registry --perm registry:write --project ${project}`);
  console.log(`  docker login ${o.host} -u mybase\n`);
  console.log("Push:");
  console.log(`  docker tag my-app ${o.prefix}/my-app:latest`);
  console.log(`  docker push ${o.prefix}/my-app:latest\n`);
  console.log(`This server runs ${o.platform}.`);
}

const printTag = (t: RegistryTag) =>
  console.log([(t.tag ?? "(untagged)").padEnd(24), t.digest.slice(7, 19), formatBytes(t.size).padStart(8), t.platforms.join(",")].join("  ").trimEnd());

/** Handles `mybase registry <sub> …`. False when `sub` isn't a registry command. */
export async function registry(sub: string, args: string[]): Promise<boolean> {
  const { positional } = parseArgs(args);
  const [project, repo, digest] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      await api(`/projects/${encodeURIComponent(p)}/services/registry`, { method: "PUT" });
      const o = await api<RegistryOverview>(base(p));
      print({ enabled: "registry", project: p, ...o }, () => {
        console.log(`Container registry enabled for "${p}".\n`);
        printInfo(p, o);
      });
      return true;
    }
    case "info": {
      const p = need(project, "project name");
      const o = await api<RegistryOverview>(base(p));
      print(o, () => printInfo(p, o));
      return true;
    }
    case "list": {
      const p = need(project, "project name");
      const o = await api<RegistryOverview>(base(p));
      print(o.repositories, () => {
        if (!o.repositories.length) return console.log(`No images yet. Push one to ${o.prefix}/<name> (mybase registry info ${p}).`);
        for (const r of o.repositories) console.log(`${r.name.padEnd(32)} ${String(r.tags).padStart(4)} tag${r.tags === 1 ? " " : "s"}${r.site ? `  (site ${r.site})` : ""}`);
      });
      return true;
    }
    case "tags": {
      const p = need(project, "project name");
      const r = need(repo, "repository name");
      const list = await api<RegistryTags>(`${base(p)}/tags?repo=${encodeURIComponent(r)}`);
      print(list, () => (list.tags.length ? list.tags.forEach(printTag) : console.log("No tags in this repository.")));
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const r = need(repo, "repository name");
      const d = need(digest, "image digest (sha256:…; see mybase registry tags)");
      if (!DIGEST.test(d)) throw usageError("the digest must be sha256:<64 hex characters> (see mybase registry tags)");
      confirm(args.includes("--yes"), `Deletes ${p}/${r}@${d.slice(0, 19)}… and every tag that points at it.`, r, "the repository name");
      await api(`${base(p)}/manifests?repo=${encodeURIComponent(r)}&digest=${encodeURIComponent(d)}`, { method: "DELETE" });
      print({ deleted: d, repository: r, project: p }, () => console.log(`Deleted ${r}@${d.slice(7, 19)}. Disk space comes back at the next garbage collection.`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(args.includes("--yes"), `Every image in "${p}"'s registry is deleted.`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/registry`, { method: "DELETE" });
      print({ disabled: "registry", project: p }, () => console.log(`Container registry disabled for "${p}"`));
      return true;
    }
  }
  return false;
}

// `mybase cache …`: a project's Redis-compatible key-value cache (Valkey).
import type { CacheCredentials, CacheOverview, EnableServiceResponse } from "@mybase/shared";
import { api } from "./api";
import { need, parseArgs } from "./cron";

export const cacheUsage = `  cache enable <project>         Turn on the cache and print its password and connection strings
  cache disable <project> [--yes]  Turn it off, deleting every key
  cache info <project>           Connection details, key count, and memory use
  cache password <project> --rotate  Replace the password (the old one stops working now)`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/cache`;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function printCredentials(project: string, c: CacheCredentials) {
  console.log(`  redis URL   ${c.url}`);
  console.log(`  HTTP URL    ${c.httpUrl}  (an API key with cache:write as Bearer token)`);
  console.log(`  key prefix  ${c.keyPrefix}  (every key must start with it)\n`);
  console.log("Over TCP (LAN/Tailscale), e.g. ioredis:");
  console.log(`  new Redis("${c.url}", { keyPrefix: "${c.keyPrefix}" })\n`);
  console.log("Over HTTP (@mybase/sdk), with an API key:");
  console.log(`  mybase token create ${project}-app --project ${project} --perm cache:write`);
  console.log(`  createCache({ apiUrl: "${c.httpUrl.replace(/\/cache\/[^/]+$/, "")}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! })\n`);
  console.log("Save the password now (TCP only). It isn't stored, so it can't be shown again.");
}

/** Handles `mybase cache <sub> …`. False when `sub` isn't a cache command. */
export async function cache(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const res = await api<EnableServiceResponse>(`/projects/${encodeURIComponent(p)}/services/cache`, { method: "PUT" });
      if (res.service !== "cache") throw new Error("unexpected answer from the API");
      console.log(`Cache enabled for "${p}"\n`);
      printCredentials(p, res.credentials);
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      if (!flags.has("yes")) {
        console.log(`This deletes every key in the cache of "${p}" and its password.`);
        if (prompt("Type the project name to confirm:") !== p) throw new Error("confirmation did not match, nothing changed");
      }
      await api(`/projects/${encodeURIComponent(p)}/services/cache`, { method: "DELETE" });
      console.log(`Cache disabled for "${p}"`);
      return true;
    }
    case "info": {
      const p = need(project, "project name");
      const { info, keys, memory } = await api<CacheOverview>(base(p));
      console.log(`  redis URL   ${info.url}  (password not shown)`);
      console.log(`  HTTP URL    ${info.httpUrl}`);
      console.log(`  key prefix  ${info.keyPrefix}`);
      console.log(`  keys        ${keys}`);
      console.log(`  memory      ${mb(memory.usedBytes)} of ${memory.maxBytes ? mb(memory.maxBytes) : "unlimited"} (whole server, ${memory.policy})`);
      return true;
    }
    case "password": {
      const p = need(project, "project name");
      if (!flags.has("rotate")) throw new Error("the password isn't stored, so it can't be shown. Use --rotate to replace it");
      const c = await api<CacheCredentials>(`${base(p)}/password/rotate`, { method: "POST" });
      console.log("Rotated. The old password stops working now.\n");
      printCredentials(p, c);
      return true;
    }
  }
  return false;
}

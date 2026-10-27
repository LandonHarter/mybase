// `mybase ratelimit …`: shared rate limits apps check with @mybase-dev/sdk/ratelimit.
import type {
  RateLimitRule,
  RateLimitSettings,
  RateLimitStats,
  SyncRateLimitRulesRequest,
  SyncRateLimitRulesResponse,
} from "@mybase/shared";
import { RATELIMIT_STATS_RANGES, type RateLimitStatsRange } from "@mybase/shared";
import { api } from "./api";
import { confirm, print } from "./output";
import { flagInt, flagString, need, parseArgs, printSync, readConfigFile } from "./cron";

export const ratelimitUsage = `  ratelimit enable <project>     Turn on rate limits
  ratelimit disable <project> [--yes]  Turn them off, deleting every rule and counter
  ratelimit rules <project>      List rules
  ratelimit create <project> <name> --limit <n> --window <10s|1m|1h|…>
         [--algorithm sliding|fixed|token] [--burst <n>]
  ratelimit delete <project> <name>  Delete a rule
  ratelimit stats <project> [--range 24h|7d]  Allowed and blocked requests per rule
  ratelimit sync [--config <file>] [--dry-run]  Make code-defined rules match mybase.config.ts`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/ratelimit`;

/** 60000 → `1m`, 90000 → `90s`. */
function formatWindow(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

function printUsage(project: string, settings: RateLimitSettings) {
  console.log(`  check URL  ${settings.limitUrl}\n`);
  console.log("In your app (@mybase-dev/sdk), with an API key that has ratelimit:write for this project:");
  console.log(`  mybase token create ${project}-app --project ${project} --perm ratelimit:write\n`);
  console.log(`  const limiter = createRateLimiter({ apiUrl: "${settings.apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! })`);
  console.log(`  const { success } = await limiter.limit("<rule>", userIdOrIp)`);
}

/** Handles `mybase ratelimit <sub> …`. False when `sub` isn't a ratelimit command. */
export async function ratelimit(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, name] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      await api(`/projects/${encodeURIComponent(p)}/services/ratelimit`, { method: "PUT" });
      const settings = await api<RateLimitSettings>(base(p));
      print({ enabled: "ratelimit", project: p, ...settings }, () => {
        console.log(`Rate limits enabled for "${p}"\n`);
        printUsage(p, settings);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This deletes every rate limit rule and counter of "${p}".`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/ratelimit`, { method: "DELETE" });
      print({ disabled: "ratelimit", project: p }, () => console.log(`Rate limits disabled for "${p}"`));
      return true;
    }
    case "rules": {
      const p = need(project, "project name");
      const rules = await api<RateLimitRule[]>(`${base(p)}/rules`);
      print(rules, () => {
        if (rules.length === 0) console.log("No rules yet. Inline limits still work.");
        for (const r of rules) {
          const burst = r.algorithm === "token" && r.burst ? ` burst ${r.burst}` : "";
          console.log([r.name, `${r.limit}/${formatWindow(r.windowMs)}${burst}`, r.algorithm, r.source].join("\t"));
        }
      });
      return true;
    }
    case "create": {
      const p = need(project, "project name");
      const body = {
        name: need(name, "rule name"),
        limit: flagInt(flags, "limit"),
        window: flagString(flags, "window"),
        algorithm: flagString(flags, "algorithm"),
        burst: flagInt(flags, "burst"),
      };
      const r = await api<RateLimitRule>(`${base(p)}/rules`, { method: "POST", body: JSON.stringify(body) });
      print(r, () => console.log(`Created rule "${r.name}": ${r.limit} per ${formatWindow(r.windowMs)} (${r.algorithm})`));
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const n = need(name, "rule name");
      await api(`${base(p)}/rules/${encodeURIComponent(n)}`, { method: "DELETE" });
      print({ deleted: n }, () => console.log(`Deleted rule "${n}"`));
      return true;
    }
    case "stats": {
      const p = need(project, "project name");
      const range = (flagString(flags, "range") ?? "24h") as RateLimitStatsRange;
      if (!RATELIMIT_STATS_RANGES.includes(range)) throw new Error(`--range must be one of ${RATELIMIT_STATS_RANGES.join(", ")}`);
      const stats = await api<RateLimitStats>(`${base(p)}/stats?range=${range}`);
      print(stats, () => {
        const { rules } = stats;
        console.log(`Last ${range}:`);
        if (rules.length === 0) console.log("  (no rules or checks)");
        const width = Math.max(...rules.map((r) => r.rule.length), 4);
        for (const r of rules) console.log(`  ${r.rule.padEnd(width)}  ${r.allowed} allowed, ${r.blocked} blocked`);
      });
      return true;
    }
    case "sync": {
      await sync(flagString(flags, "config") ?? "mybase.config.ts", flags.has("dry-run"));
      return true;
    }
  }
  return false;
}

async function sync(file: string, dryRun: boolean) {
  const config = await readConfigFile(file);
  const body: SyncRateLimitRulesRequest = {
    dryRun,
    rules: Object.entries(config.ratelimit?.rules ?? {}).map(([name, rule]) => ({
      name,
      algorithm: rule.algorithm as SyncRateLimitRulesRequest["rules"][number]["algorithm"],
      limit: rule.limit as number,
      window: rule.window as number | string,
      burst: rule.burst as number | undefined,
    })),
  };
  printSync(config.project, dryRun, await api<SyncRateLimitRulesResponse>(`${base(config.project)}/rules`, { method: "PUT", body: JSON.stringify(body) }));
}

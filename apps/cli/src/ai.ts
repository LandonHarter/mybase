// `mybase ai …`: the AI gateway. Provider keys go into the project's secrets env (`ai`); apps
// call `<api>/ai/<project>/v1` with a mybase API key, through any OpenAI-compatible SDK.
import type { AiAlias, AiLogDetail, AiLogsResponse, AiModel, AiPriceOverride, AiProviderStatus, AiSettings, AiUsageResponse, SyncAiResponse } from "@mybase-dev/sdk/ai";
import { api } from "./api";
import { readSecret } from "./auth";
import { flagInt, flagString, need, parseArgs, readConfigFile } from "./cron";
import { confirm, print, usageError } from "./output";
import { enableService, printLinked } from "./service-enable";

export const aiUsage = `  ai enable <project>            Turn on the AI gateway (needs secrets; provider keys live there)
  ai disable <project> [--yes]   Turn it off, deleting its logs, aliases, and price overrides
  ai settings <project> [--capture on|off] [--budget <usd>|off] [--hard on|off] [--soft <pct>] [--keys-env <env>] [--allow <glob,…>|any] [--retention <days>] [--ratelimit <rule>|off] [--ratelimit-by token|user]
  ai providers <project>         Providers, and which have their keys set
  ai key set <project> <provider> [--stdin]  Store a provider's key (prompted) in the keys env
  ai key unset <project> <provider>  Remove it
  ai provider add <project> <id> --url <base-url> [--name <n>] [--key-name <SECRET_NAME>]  Custom OpenAI-compatible provider (Ollama, vLLM, …)
  ai provider remove <project> <id>
  ai provider test <project> <id>  Check its key with a cheap call
  ai models <project> [--all] [--type chat|embedding|image] [--provider <id>]  Models with prices
  ai alias set <project> <name> <model> [<fallback>…]  An alias tried in order, e.g. fast groq/llama-3.3-70b openai/gpt-5-mini
  ai alias delete <project> <name>
  ai logs <project> [--model <m>] [--status ok|error|<code>] [--since 1h] [--tag <t>] [--limit 50]
  ai log <project> <id>          One call, with its prompt and response when capture is on
  ai usage <project> [--range 24h|7d|30d|90d] [--by model|provider|tag|key]
  ai prices <project>            Price overrides
  ai prices set <project> <model|glob> [--input <usd/1M>] [--output <usd/1M>] [--cache-read …] [--cache-write …] [--per-image …] [--per-request …]
  ai prices unset <project> <model|glob>
  ai prices refresh <project>    Fetch the latest catalog from models.dev now
  ai sync [--config <file>] [--dry-run]  Make code-defined aliases and prices match mybase.config.ts`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/ai`;

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n < 0.01 && n > 0 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`);
const onOff = (v: string | undefined, flag: string) => {
  if (v === undefined) return undefined;
  if (v !== "on" && v !== "off") throw usageError(`--${flag} takes on or off`);
  return v === "on";
};

function printSetup(project: string, s: AiSettings) {
  console.log("Apps call the gateway with a mybase API key (ai:write), never a provider key:");
  console.log(`  mybase token create ${project}-ai --project ${project} --perm ai:write\n`);
  console.log(`  new OpenAI({ baseURL: "${s.baseURL}", apiKey: process.env.MYBASE_API_KEY })`);
  console.log(`  new Anthropic({ baseURL: "${s.nativeBaseURL}/anthropic", apiKey: process.env.MYBASE_API_KEY })`);
  console.log(`\nAdd a provider key: mybase ai key set ${project} openai`);
}

async function providerOf(project: string, id: string): Promise<AiProviderStatus> {
  const list = await api<AiProviderStatus[]>(`${base(project)}/providers`);
  const p = list.find((x) => x.id === id);
  if (!p) throw usageError(`unknown provider "${id}". Known: ${list.map((x) => x.id).join(", ")}`);
  return p;
}

async function readKey(name: string, stdin: boolean): Promise<string> {
  const value = stdin ? (await Bun.stdin.text()).trim() : await readSecret(`${name}: `);
  if (!value) throw usageError(`${name} is empty`);
  return value;
}

export async function ai(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, a, b, ...more] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "ai", flags);
      const s = await api<AiSettings>(base(p));
      print({ enabled: "ai", project: p, linked, ...s }, () => {
        console.log(`AI gateway enabled for "${p}" (keys env: ${s.keysEnv})\n`);
        printSetup(p, s);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(flags.has("yes"), `This deletes the AI gateway's logs, usage, aliases, and price overrides for "${p}" (keys stay in secrets).`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/ai`, { method: "DELETE" });
      print({ disabled: "ai", project: p }, () => console.log(`AI gateway disabled for "${p}"`));
      return true;
    }
    case "settings": {
      const p = need(project, "project name");
      const body: Record<string, unknown> = {};
      const capture = onOff(flagString(flags, "capture"), "capture");
      if (capture !== undefined) body.captureContent = capture;
      const budget = flagString(flags, "budget");
      if (budget !== undefined) body.budgetUsd = budget === "off" ? null : Number(budget);
      const hard = onOff(flagString(flags, "hard"), "hard");
      if (hard !== undefined) body.budgetHard = hard;
      const soft = flagInt(flags, "soft");
      if (soft !== undefined) body.budgetSoftPct = soft;
      const env = flagString(flags, "keys-env");
      if (env) body.keysEnv = env;
      const allow = flagString(flags, "allow");
      if (allow !== undefined)
        body.allowedModels =
          allow === "any"
            ? null
            : allow
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
      const retention = flagInt(flags, "retention");
      if (retention !== undefined) body.logRetentionDays = retention;
      const rl = flagString(flags, "ratelimit");
      if (rl !== undefined) body.ratelimitRule = rl === "off" ? null : rl;
      const by = flagString(flags, "ratelimit-by");
      if (by) body.ratelimitBy = by;
      const s = Object.keys(body).length ? await api<AiSettings>(base(p), { method: "PUT", body: JSON.stringify(body) }) : await api<AiSettings>(base(p));
      print(s, () => {
        console.log(`base URL        ${s.baseURL}`);
        console.log(`native          ${s.nativeBaseURL}/<provider>`);
        console.log(`keys env        ${s.keysEnv}`);
        console.log(`capture         ${s.captureContent ? `on (${s.contentRetentionDays} days)` : "off"}`);
        console.log(`log retention   ${s.logRetentionDays} days`);
        console.log(`budget          ${s.budgetUsd === null ? "none" : `${usd(s.budgetUsd)}/month, alert at ${s.budgetSoftPct}%${s.budgetHard ? ", hard stop" : ""}`}`);
        console.log(`this month      ${usd(s.monthToDateUsd)}`);
        console.log(`allowed models  ${s.allowedModels?.join(", ") ?? "any"}`);
        console.log(`rate limit      ${s.ratelimitRule ? `${s.ratelimitRule} per ${s.ratelimitBy}` : "none"}`);
      });
      return true;
    }
    case "providers": {
      const p = need(project, "project name");
      const list = await api<AiProviderStatus[]>(`${base(p)}/providers`);
      print(list, () => {
        for (const x of list)
          console.log(
            `${x.configured ? "✓" : " "} ${x.id.padEnd(12)} ${x.name.padEnd(20)} ${x.configured ? "" : `needs ${x.missing.join(", ")}`}${x.custom ? `  ${x.baseUrl}` : ""}`,
          );
      });
      return true;
    }
    case "key": {
      const p = need(a, "project name");
      const id = need(b, "provider id");
      const provider = await providerOf(p, id);
      if (project === "set") {
        const set: Record<string, string> = {};
        // Every key the provider reads (Azure also needs its resource name; Bedrock a region).
        for (const name of provider.keys) set[name] = await readKey(name, flags.has("stdin") && provider.keys.length === 1);
        const res = await api<{ env: string; revision: number }>(`${base(p)}/keys`, { method: "PUT", body: JSON.stringify({ set }) });
        print(res, () => console.log(`Stored ${Object.keys(set).join(", ")} in secrets env "${res.env}" (revision ${res.revision})`));
        return true;
      }
      if (project === "unset") {
        const res = await api<{ env: string; revision: number }>(`${base(p)}/keys`, { method: "PUT", body: JSON.stringify({ unset: provider.keys }) });
        print(res, () => console.log(`Removed ${provider.keys.join(", ")} from secrets env "${res.env}"`));
        return true;
      }
      throw usageError("use: mybase ai key set|unset <project> <provider>");
    }
    case "provider": {
      const p = need(a, "project name");
      const id = need(b, "provider id");
      if (project === "add") {
        const body = { baseUrl: need(flagString(flags, "url"), "--url"), name: flagString(flags, "name"), keyName: flagString(flags, "key-name") ?? null };
        const res = await api<AiProviderStatus>(`${base(p)}/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
        print(res, () => console.log(`Provider "${id}" at ${res.baseUrl}. Call it as ${id}/<model>.`));
      } else if (project === "remove") {
        await api(`${base(p)}/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
        print({ removed: id }, () => console.log(`Removed provider "${id}"`));
      } else if (project === "test") {
        const res = await api<{ ok: boolean; status: number | null; ms: number; message: string }>(`${base(p)}/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
        print(res, () => console.log(`${res.ok ? "ok" : "failed"}: ${res.message}${res.status ? ` (${res.status}, ${res.ms} ms)` : ""}`));
        if (!res.ok) process.exitCode = 1;
      } else throw usageError("use: mybase ai provider add|remove|test <project> <id>");
      return true;
    }
    case "models": {
      const p = need(project, "project name");
      const params = new URLSearchParams();
      if (flags.has("all")) params.set("all", "1");
      for (const k of ["type", "provider"]) {
        const v = flagString(flags, k);
        if (v) params.set(k, v);
      }
      const models = await api<AiModel[]>(`${base(p)}/models?${params}`);
      print(models, () => {
        if (models.length === 0) console.log(`No models: set a provider key first (mybase ai key set ${p} openai), or pass --all.`);
        for (const m of models) {
          const price = m.price
            ? `in ${m.price.input ?? "–"} out ${m.price.output ?? "–"}${m.price.cacheRead !== undefined ? ` cached ${m.price.cacheRead}` : ""}${m.price.perImage !== undefined ? ` ${m.price.perImage}/img` : ""}`
            : "unpriced";
          const size = m.type === "embedding" ? `${m.dimensions ?? "?"}d` : m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "";
          console.log(`${m.id.padEnd(48)} ${m.type.padEnd(9)} ${size.padEnd(9)} ${price}${m.priceSource === "override" ? " (override)" : ""}`);
        }
      });
      return true;
    }
    case "alias": {
      const p = need(a, "project name");
      const name = need(b, "alias name");
      if (project === "set") {
        const targets = more;
        if (targets.length === 0) throw usageError("give at least one model, e.g. mybase ai alias set shop fast openai/gpt-5-mini");
        const res = await api<AiAlias>(`${base(p)}/aliases/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ targets }) });
        print(res, () => console.log(`${res.name} → ${res.targets.join(" → ")}`));
      } else if (project === "delete") {
        await api(`${base(p)}/aliases/${encodeURIComponent(name)}`, { method: "DELETE" });
        print({ deleted: name }, () => console.log(`Deleted alias "${name}"`));
      } else throw usageError("use: mybase ai alias set|delete <project> <name> …");
      return true;
    }
    case "logs": {
      const p = need(project, "project name");
      const params = new URLSearchParams({ limit: String(flagInt(flags, "limit") ?? 50) });
      for (const k of ["model", "status", "since", "tag", "provider", "user", "before"]) {
        const v = flagString(flags, k);
        if (v) params.set(k, v);
      }
      const res = await api<AiLogsResponse>(`${base(p)}/logs?${params}`);
      print(res, () => {
        if (res.logs.length === 0) console.log("No calls yet.");
        for (const l of res.logs) {
          const model = l.provider ? `${l.provider}/${l.model}` : (l.alias ?? "-");
          const tokens = `${l.inputTokens}→${l.outputTokens}`;
          console.log(
            `${l.at.slice(0, 19).replace("T", " ")}  ${String(l.status).padEnd(3)} ${l.endpoint.padEnd(10)} ${model.padEnd(40)} ${tokens.padEnd(12)} ${usd(l.costUsd).padEnd(10)} ${l.latencyMs}ms${l.cached ? " cached" : ""}${l.error ? `  ${l.error}` : ""}  ${l.id}`,
          );
        }
        if (res.next) console.log(`more: --before '${res.next}'`);
      });
      return true;
    }
    case "log": {
      const p = need(project, "project name");
      const res = await api<AiLogDetail>(`${base(p)}/logs/${encodeURIComponent(need(a, "log id"))}`);
      print(res, () => {
        const { content, ...meta } = res;
        console.log(JSON.stringify(meta, null, 2));
        if (content) {
          console.log(`\n--- request\n${content.request ?? "(none)"}\n--- response\n${content.response ?? "(none)"}`);
        } else console.log("\n(content capture was off for this call)");
      });
      return true;
    }
    case "usage": {
      const p = need(project, "project name");
      const params = new URLSearchParams({ range: flagString(flags, "range") ?? "7d", group: flagString(flags, "by") ?? "model" });
      const u = await api<AiUsageResponse>(`${base(p)}/usage?${params}`);
      print(u, () => {
        const t = u.totals;
        console.log(
          `${params.get("range")}: ${t.requests} calls, ${t.errors} errors, ${t.inputTokens} in / ${t.outputTokens} out tokens (${t.cachedTokens} cached), ${usd(t.costUsd)}${t.unpriced ? `, ${t.unpriced} unpriced` : ""}${t.avgLatencyMs !== null ? `, avg ${t.avgLatencyMs} ms` : ""}\n`,
        );
        for (const g of u.groups) console.log(`${g.key.padEnd(48)} ${String(g.requests).padStart(7)} calls  ${usd(g.costUsd)}`);
      });
      return true;
    }
    case "prices": {
      if (project === "set" || project === "unset" || project === "refresh") {
        const p = need(a, "project name");
        if (project === "refresh") {
          const res = await api<{ fetchedAt: string }>(`${base(p)}/prices/refresh`, { method: "POST" });
          print(res, () => console.log(`Price catalog refreshed (${res.fetchedAt})`));
          return true;
        }
        const model = need(b, "model id or glob");
        if (project === "unset") {
          await api(`${base(p)}/prices?model=${encodeURIComponent(model)}`, { method: "DELETE" });
          print({ deleted: model }, () => console.log(`Removed the override for ${model}`));
          return true;
        }
        const num = (k: string) => {
          const v = flagString(flags, k);
          return v === undefined ? undefined : Number(v);
        };
        const body = {
          model,
          input: num("input"),
          output: num("output"),
          cacheRead: num("cache-read"),
          cacheWrite: num("cache-write"),
          perImage: num("per-image"),
          perRequest: num("per-request"),
        };
        const res = await api<AiPriceOverride>(`${base(p)}/prices`, { method: "PUT", body: JSON.stringify(body) });
        print(res, () => console.log(`Override for ${res.model} saved`));
        return true;
      }
      const p = need(project, "project name");
      const res = await api<{ overrides: AiPriceOverride[]; catalogFetchedAt: string }>(`${base(p)}/prices`);
      print(res, () => {
        console.log(`catalog from models.dev, fetched ${res.catalogFetchedAt}`);
        if (res.overrides.length === 0) console.log("No overrides.");
        for (const o of res.overrides) console.log(`${o.model.padEnd(40)} ${JSON.stringify({ ...o, model: undefined })}`);
      });
      return true;
    }
    case "sync": {
      const config = await readConfigFile(flagString(flags, "config") ?? "mybase.config.ts");
      const body = { aliases: config.ai?.aliases ?? {}, prices: config.ai?.prices ?? {}, dryRun: flags.has("dry-run") };
      const res = await api<SyncAiResponse>(`${base(config.project)}/sync`, { method: "POST", body: JSON.stringify(body) });
      print({ project: config.project, dryRun: body.dryRun, ...res }, () => {
        const al = res.aliases;
        console.log(
          `${body.dryRun ? "Would sync" : "Synced"} ${config.project}: aliases ${al.created.length} created, ${al.updated.length} updated, ${al.deleted.length} deleted, ${al.unchanged.length} unchanged; prices ${res.prices.set.length} set, ${res.prices.deleted.length} removed`,
        );
        for (const n of al.created) console.log(`  + ${n}`);
        for (const n of al.updated) console.log(`  ~ ${n}`);
        for (const n of al.deleted) console.log(`  - ${n}`);
      });
      return true;
    }
  }
  return false;
}

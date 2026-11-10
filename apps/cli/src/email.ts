// `mybase email …`: the email service (Amazon SES). Domains, templates (and `sync`, which renders
// the repo's React Email templates on this machine), sends, logs, suppressions.
import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  EmailDomain,
  EmailMessage,
  EmailMessageList,
  EmailServerStatus,
  EmailSuppression,
  EmailTemplateSummary,
  SendEmailResponse,
  SyncEmailTemplate,
  SyncEmailTemplatesResponse,
} from "@mybase/shared";
import { api } from "./api";
import { flagString, need, parseArgs, printSync, readConfigFile } from "./cron";
import { CliError, confirm, jsonMode, print, usageError } from "./output";
import { enableService, printLinked } from "./service-enable";

export const emailUsage = `  email status                   This server's SES account: region, sandbox, quota, delivery events
  email enable <project>         Turn on email (the server needs SES keys: mybase server email)
  email domains <project>        Sending domains, their status and DNS records
  email domain add <project> <domain>   Verify a domain with SES (DNS records added in Cloudflare
                                 when the server has MYBASE_DNS_TOKEN; else printed to add yourself)
  email domain check <project> <domain>   Ask SES again whether it's verified
  email domain remove <project> <domain> [--yes]
  email templates <project>      Templates: id, subject, variables, source (dashboard or code)
  email sync [--config mybase.config.ts] [--dry-run] [--yes]
                                 Render the repo's React Email templates (email.templates in the config,
                                 default ./emails/*.tsx) here and replace the project's code templates
  email send <project> --template <id> --to <addr> [--var name=value …] [--from <addr>]
                                 Send a template (to try it); apps use @mybase-dev/sdk/email
  email logs <project> [--status <s>] [--to <addr>] [--template <id>] [--limit <n>] [--follow]
  email show <project> <id>      One email: recipients, status, delivery events
  email cancel <project> <id>    Cancel a queued or scheduled email
  email suppressions <project> [remove <address>]   Addresses that bounced or complained (never emailed)
  email disable <project> [--yes]  Turn it off: deletes templates, logs, and domains (SES identities too)`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/email`;

const STATUS_MARK: Record<string, string> = {
  queued: "…",
  sending: "…",
  sent: "→",
  delivered: "✓",
  delayed: "~",
  bounced: "✗",
  complained: "!",
  failed: "✗",
  canceled: "-",
};

function printDomain(d: EmailDomain) {
  console.log(`${d.domain}  ${d.status}${d.dns === "cloudflare" ? "  (DNS in Cloudflare)" : ""}`);
  if (d.error) console.log(`  ${d.error}`);
  if (d.status !== "verified") {
    console.log(d.dns === "manual" ? "  Add these records at your DNS provider:" : "  Records:");
    for (const r of d.records) {
      const state = r.state ? `  [${r.state}]` : "";
      console.log(`    ${r.type.padEnd(5)} ${r.name}  →  ${r.priority !== undefined ? `${r.priority} ` : ""}${r.value}${r.purpose === "dmarc" ? "  (if you have no DMARC record)" : ""}${state}`);
    }
  }
}

/** All `--var name=value` pairs (repeatable, unlike other flags). */
function vars(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--var") continue;
    const pair = args[i + 1];
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq < 1) throw usageError("--var needs name=value");
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Args without `--var x` pairs, for parseArgs (its flags are single-valued). */
const withoutVars = (args: string[]) => args.filter((a, i) => a !== "--var" && args[i - 1] !== "--var");

export async function email(sub: string, rawArgs: string[]): Promise<boolean> {
  const args = withoutVars(rawArgs);
  const { positional, flags } = parseArgs(args);
  const yes = args.includes("--yes");
  switch (sub) {
    case "status": {
      const s = await api<EmailServerStatus>("/email/status?refresh=1");
      print(s, () => {
        if (!s.configured) return console.log("Email isn't set up on this server. Run `mybase server email` on it.");
        console.log(`SES ${s.region}${s.sandbox ? "  (sandbox: verified recipients only)" : ""}${s.sendingEnabled === false ? "  SENDING PAUSED" : ""}`);
        if (s.quota) console.log(`  ${s.quota.sentLast24Hours}/${s.quota.max24Hour} sent in 24 h, ${s.quota.maxPerSecond}/s`);
        console.log(`  delivery events: ${s.eventsReady ? "on" : "not set up"}`);
        if (s.error) console.log(`  problem: ${s.error}`);
      });
      return true;
    }
    case "enable": {
      const p = need(positional[0], "project name");
      const { linked } = await enableService(p, "email", flags);
      print({ enabled: "email", project: p, linked }, () => {
        console.log(`Email enabled for "${p}". Next: mybase email domain add ${p} <your domain>`);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "domains": {
      const p = need(positional[0], "project name");
      const domains = await api<EmailDomain[]>(`${base(p)}/domains`);
      print(domains, () => {
        if (!domains.length) return console.log(`No domains yet: mybase email domain add ${p} <domain>`);
        domains.forEach(printDomain);
      });
      return true;
    }
    case "domain": {
      const [action, project, domain] = positional;
      const p = need(project, "project name");
      const d = need(domain, "domain");
      if (action === "add") {
        const res = await api<EmailDomain>(`${base(p)}/domains`, { method: "POST", body: JSON.stringify({ domain: d }) });
        print(res, () => {
          printDomain(res);
          if (res.status !== "verified") console.log(`\nSES checks the records on its own (minutes to hours). Re-check: mybase email domain check ${p} ${d}`);
        });
      } else if (action === "check") {
        const res = await api<EmailDomain>(`${base(p)}/domains/${encodeURIComponent(d)}/check`, { method: "POST" });
        print(res, () => printDomain(res));
      } else if (action === "remove") {
        confirm(
          yes,
          `Email from ${d} stops working, and mybase deletes the SES identity (if mybase created it; one that was already in SES is kept) and the DNS records it added.`,
          d,
          "the domain",
        );
        const res = await api<{ warning?: string } | null>(`${base(p)}/domains/${encodeURIComponent(d)}`, { method: "DELETE" });
        print({ removed: d, warning: res?.warning ?? null }, () => {
          console.log(`Removed ${d}`);
          if (res?.warning) console.log(res.warning);
        });
      } else throw usageError("usage: mybase email domain add|check|remove <project> <domain>");
      return true;
    }
    case "templates": {
      const p = need(positional[0], "project name");
      const list = await api<EmailTemplateSummary[]>(`${base(p)}/templates`);
      print(list, () => {
        if (!list.length) return console.log("No templates yet: make one in the dashboard, or add emails/*.tsx and run mybase email sync");
        for (const t of list) {
          console.log(`${t.id.padEnd(24)} ${t.source.padEnd(9)} ${t.subject}`);
          if (t.variables.length) console.log(`${" ".repeat(35)}vars: ${t.variables.map((v) => v.name).join(", ")}`);
        }
      });
      return true;
    }
    case "sync": {
      await sync(flagString(flags, "config") ?? "mybase.config.ts", flags.has("dry-run"), yes);
      return true;
    }
    case "send": {
      const p = need(positional[0], "project name");
      const template = need(flagString(flags, "template"), "--template");
      const to = need(flagString(flags, "to"), "--to");
      const res = await api<SendEmailResponse>(`/email/${encodeURIComponent(p)}/send`, {
        method: "POST",
        body: JSON.stringify({ template, to, variables: vars(rawArgs), from: flagString(flags, "from") }),
      });
      print(res, () => console.log(`Queued ${res.id}. Follow it: mybase email show ${p} ${res.id}`));
      return true;
    }
    case "logs": {
      const p = need(positional[0], "project name");
      const q = new URLSearchParams();
      for (const k of ["status", "to", "template"]) {
        const v = flagString(flags, k);
        if (v) q.set(k, v);
      }
      q.set("limit", flagString(flags, "limit") ?? "30");
      const line = (m: EmailMessageList["messages"][number]) =>
        `${m.createdAt.slice(0, 19).replace("T", " ")}  ${(STATUS_MARK[m.status] ?? " ")} ${m.status.padEnd(10)} ${m.to.join(", ").slice(0, 40).padEnd(40)}  ${m.template ?? "-"}  ${m.subject.slice(0, 60)}  ${m.id}`;
      const first = await api<EmailMessageList>(`${base(p)}/messages?${q}`);
      if (!flags.has("follow") || jsonMode) {
        print(first, () => (first.messages.length ? [...first.messages].reverse().forEach((m) => console.log(line(m))) : console.log("No emails yet")));
        return true;
      }
      [...first.messages].reverse().forEach((m) => console.log(line(m)));
      // Statuses change after sending (delivered, bounced): re-print a message when it does.
      const seen = new Map(first.messages.map((m) => [m.id, m.status]));
      for (;;) {
        await Bun.sleep(3000);
        const page = await api<EmailMessageList>(`${base(p)}/messages?${q}`);
        for (const m of [...page.messages].reverse()) {
          if (seen.get(m.id) === m.status) continue;
          seen.set(m.id, m.status);
          console.log(line(m));
        }
      }
    }
    case "show": {
      const p = need(positional[0], "project name");
      const id = need(positional[1], "message id");
      const m = await api<EmailMessage>(`${base(p)}/messages/${encodeURIComponent(id)}`);
      print(m, () => {
        console.log(`${m.subject}\n  from ${m.from}\n  to   ${m.to.join(", ")}`);
        if (m.cc.length) console.log(`  cc   ${m.cc.join(", ")}`);
        if (m.bcc.length) console.log(`  bcc  ${m.bcc.join(", ")}`);
        console.log(`  status ${m.status}${m.error ? `: ${m.error}` : ""}${m.template ? `  (template ${m.template})` : ""}`);
        if (m.attachments.length) console.log(`  attachments ${m.attachments.map((a) => a.filename).join(", ")}`);
        for (const e of m.events) console.log(`  ${e.at.slice(0, 19).replace("T", " ")}  ${e.type}${e.detail ? `  ${JSON.stringify(e.detail)}` : ""}`);
      });
      return true;
    }
    case "cancel": {
      const p = need(positional[0], "project name");
      const id = need(positional[1], "message id");
      await api(`${base(p)}/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
      print({ canceled: id }, () => console.log(`Canceled ${id}`));
      return true;
    }
    case "suppressions": {
      const p = need(positional[0], "project name");
      if (positional[1] === "remove") {
        const addr = need(positional[2], "address");
        await api(`${base(p)}/suppressions`, { method: "DELETE", body: JSON.stringify({ address: addr }) });
        print({ removed: addr }, () => console.log(`${addr} can be emailed again`));
        return true;
      }
      const list = await api<EmailSuppression[]>(`${base(p)}/suppressions`);
      print(list, () => (list.length ? list.forEach((s) => console.log(`${s.address}  ${s.reason}  ${s.createdAt.slice(0, 10)}`)) : console.log("Nothing suppressed")));
      return true;
    }
    case "disable": {
      const p = need(positional[0], "project name");
      confirm(yes, `This deletes "${p}"'s email templates, logs, suppressions, and domains (their SES identities and the DNS records mybase added).`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/email`, { method: "DELETE" });
      print({ disabled: "email", project: p }, () => console.log(`Email disabled for "${p}"`));
      return true;
    }
  }
  return false;
}

// ---- sync: render React Email templates here ------------------------------------

type Mod = Record<string, unknown>;

/** Imports a package the way the app would (from its directory), so its own versions are used. */
async function importFrom(dir: string, name: string): Promise<Mod> {
  let path: string;
  try {
    path = Bun.resolveSync(name, dir);
  } catch {
    throw new CliError(`${name} isn't installed in ${dir}. Install it: bun add react react-dom @react-email/components @react-email/render`);
  }
  return (await import(path)) as Mod;
}

/** Renders each `<dir>/*.tsx` with `{{name}}` placeholders for its PreviewProps. */
// html-to-text uppercases headings by default, which turns `{{name}}` into a `{{NAME}}` variable.
export const PLAIN_TEXT = {
  plainText: true as const,
  htmlToTextOptions: { selectors: ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })) },
};

export async function renderTemplates(dir: string): Promise<SyncEmailTemplate[]> {
  const files = (await readdir(dir).catch(() => {
    throw new CliError(`no templates folder at ${dir} (set email.templates in mybase.config.ts)`);
  }))
    .filter((f) => /\.(tsx|jsx)$/.test(f) && !f.startsWith("_"))
    .sort();
  const React = await importFrom(dir, "react");
  const { render } = (await importFrom(dir, "@react-email/render")) as { render: (el: unknown, opts?: Record<string, unknown>) => Promise<string> };
  const createElement = (React.createElement ?? (React.default as Mod | undefined)?.createElement) as (c: unknown, p: unknown) => unknown;

  const out: SyncEmailTemplate[] = [];
  for (const file of files) {
    const id = basename(file).replace(/\.(tsx|jsx)$/, "");
    const mod = (await import(resolve(dir, file))) as Mod;
    const Component = mod.default;
    if (typeof Component !== "function") throw new CliError(`${file}: default-export the email component`);
    const subject = (mod.subject ?? (Component as unknown as Mod).subject) as unknown;
    if (typeof subject !== "string") throw new CliError(`${file}: export const subject = "…" (may use {{name}})`);
    const preview = ((mod.PreviewProps ?? (Component as unknown as Mod).PreviewProps) ?? {}) as Record<string, unknown>;
    const variables = Object.entries(preview).map(([name, sample]) => {
      if (typeof sample === "object" && sample !== null) {
        throw new CliError(`${file}: PreviewProps.${name} is an object or array; stored templates take strings (render in your app and send html instead)`);
      }
      return { name, sample: String(sample) };
    });
    const props = Object.fromEntries(variables.map((v) => [v.name, `{{${v.name}}}`]));
    let html: string;
    let text: string;
    try {
      const el = createElement(Component, props);
      html = await render(el);
      text = await render(el, PLAIN_TEXT);
    } catch (err) {
      throw new CliError(`${file}: rendering with {{placeholders}} failed: ${(err as Error).message}. Stored templates can't branch or loop on variables`);
    }
    out.push({
      id,
      name: typeof mod.name === "string" ? mod.name : id,
      subject,
      from: typeof mod.from === "string" ? mod.from : null,
      html,
      text,
      variables,
    });
  }
  return out;
}

async function sync(file: string, dryRun: boolean, yes: boolean) {
  const config = await readConfigFile(file);
  const dir = resolve(dirname(resolve(file)), config.email?.templates ?? "./emails");
  const templates = await renderTemplates(dir);
  const path = `${base(config.project)}/templates`;
  const plan = await api<SyncEmailTemplatesResponse>(path, { method: "PUT", body: JSON.stringify({ templates, dryRun: true }) });
  if (dryRun) return printSync(config.project, true, plan);
  if (plan.deleted.length) {
    confirm(yes, `This deletes templates ${plan.deleted.map((n) => `"${n}"`).join(", ")}; apps sending them get errors.`, "yes");
  }
  printSync(config.project, false, await api<SyncEmailTemplatesResponse>(path, { method: "PUT", body: JSON.stringify({ templates }) }));
}


#!/usr/bin/env bun
import type { CreateProjectResponse, Project } from "@mybase/shared";
import { agent, agentUsage } from "./agent";
import { analytics, analyticsUsage } from "./analytics";
import { api } from "./api";
import { auth, authUsage } from "./auth";
import { cache, cacheUsage } from "./cache";
import { context, contextUsage } from "./context";
import { confirm, CliError, jsonMode, print, usageError } from "./output";
import { cron, cronUsage, need } from "./cron";
import { docs, docsUsage } from "./docs";
import { mcp, mcpUsage } from "./mcp";
import { queue, queueUsage } from "./queue";
import { ratelimit, ratelimitUsage } from "./ratelimit";
import { search, searchUsage } from "./search";
import { token, tokenUsage } from "./token";

export const projectUsage = `  project create <name>          Create a new project (database + storage bucket)
  project list                   List projects
  project delete <name> [--yes]  Delete a project, its database, and all its files`;

/** Usage per command, for `mybase help <command>` and docs/cli.md. */
export const USAGE: Record<string, string> = {
  auth: authUsage,
  token: tokenUsage,
  project: projectUsage,
  context: contextUsage,
  docs: docsUsage,
  mcp: mcpUsage,
  agent: agentUsage,
  cron: cronUsage,
  analytics: analyticsUsage,
  cache: cacheUsage,
  ratelimit: ratelimitUsage,
  queue: queueUsage,
  search: searchUsage,
};

export const GLOBAL_FLAGS = `  --json                         Print results as JSON (errors too, on stderr)
  --yes                          Skip confirmations (required without a terminal)
  MYBASE_API_URL, MYBASE_TOKEN   Override the saved server and token
  Exit codes: 0 ok, 1 failure, 2 usage, 3 not signed in / bad token, 4 not found`;

const usage = `Usage: mybase <command> [--json]

Commands:
${Object.values(USAGE).join("\n")}
  help [<command>]               Show this message, or one command's

Flags:
${GLOBAL_FLAGS}`;

async function main(args: string[]) {
  const [command, sub, ...rest] = args;

  if (command === "help" && sub) {
    const key = ["login", "logout", "whoami", "version"].includes(sub) ? "auth" : sub;
    if (USAGE[key]) return console.log(USAGE[key]);
  }
  if (command && (await auth(command, args.slice(1)))) return;
  if (command === "docs" && (await docs(args.slice(1)))) return;
  if (command === "context" && (await context(args.slice(1)))) return;
  if (command === "mcp" && (await mcp(args.slice(1)))) return;
  if (command === "agent" && sub && (await agent(sub, rest))) return;

  if (command === "project" && sub === "create") {
    const name = need(rest[0], "project name");
    const project = await api<CreateProjectResponse>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const { database, storage } = project.credentials;
    if (jsonMode) return print(project, () => {});
    console.log(`Created project "${project.name}"\n`);
    console.log(`Postgres:\n  ${database.url}\n`);
    console.log("Storage (S3):");
    console.log(`  endpoint           ${storage.endpoint}`);
    console.log(`  region             ${storage.region}`);
    console.log(`  bucket             ${storage.bucket}`);
    console.log(`  access key id      ${storage.accessKeyId}`);
    console.log(`  secret access key  ${storage.secretAccessKey}`);
    console.log(`  public URL         ${storage.publicUrl}<key>  (objects under public/ only)\n`);
    console.log("Save these now. The password and secret key aren't stored, so they can't be shown again.");
    return;
  }

  if (command === "project" && sub === "list") {
    const projects = await api<Project[]>("/projects");
    print(projects, () => {
      if (projects.length === 0) console.log("No projects yet.");
      for (const p of projects) console.log(`${p.name}\t${p.storage?.bucket ?? "(no storage)"}\t${p.createdAt}`);
    });
    return;
  }

  if (command === "project" && sub === "delete") {
    const name = need(rest.find((a) => !a.startsWith("-")), "project name");
    confirm(rest.includes("--yes"), `This permanently deletes project "${name}": its database, its storage bucket, and every file in it.`, name, "the project name");
    await api(`/projects/${name}`, { method: "DELETE" });
    print({ deleted: name }, () => console.log(`Deleted project "${name}"`));
    return;
  }

  if (command === "token" && sub) {
    if (await token(sub, rest)) return;
  }

  if (command === "cron" && sub) {
    if (await cron(sub, rest)) return;
  }

  if (command === "analytics" && sub) {
    if (await analytics(sub, rest)) return;
  }

  if (command === "cache" && sub) {
    if (await cache(sub, rest)) return;
  }

  if (command === "ratelimit" && sub) {
    if (await ratelimit(sub, rest)) return;
  }

  if (command === "queue" && sub) {
    if (await queue(sub, rest)) return;
  }

  if (command === "search" && sub) {
    if (await search(sub, rest)) return;
  }

  if (command && command !== "help") throw usageError(`unknown command: mybase ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")}\n\n${usage}`);
  console.log(usage);
}

if (import.meta.main) {
  main(Bun.argv.slice(2).filter((a) => a !== "--json")).catch((err: Error) => {
    const code = err instanceof CliError ? err.exitCode : 1;
    if (jsonMode) console.error(JSON.stringify({ error: err.message.split("\n\n")[0], status: err instanceof CliError ? (err.status ?? null) : null, exitCode: code }));
    else console.error(`error: ${err.message}`);
    process.exit(code);
  });
}

#!/usr/bin/env bun
import { DEFAULT_API_URL, type Project } from "@mybase/shared";

const API_URL = process.env.MYBASE_API_URL ?? DEFAULT_API_URL;

const usage = `Usage: mybase <command>

Commands:
  project create <name>   Create a new project
  project list            List projects
  help                    Show this message`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}

async function main(args: string[]) {
  const [command, sub, ...rest] = args;

  if (command === "project" && sub === "create") {
    const name = rest[0];
    if (!name) throw new Error("missing project name");
    const project = await api<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    console.log(`Created project "${project.name}"`);
    return;
  }

  if (command === "project" && sub === "list") {
    const projects = await api<Project[]>("/projects");
    if (projects.length === 0) console.log("No projects yet.");
    for (const p of projects) console.log(`${p.name}\t${p.createdAt}`);
    return;
  }

  console.log(usage);
  if (command && command !== "help") process.exitCode = 1;
}

main(Bun.argv.slice(2)).catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

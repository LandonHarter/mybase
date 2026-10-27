#!/usr/bin/env bun
import type { CreateProjectResponse, Project } from "@mybase/shared";
import { api } from "./api";
import { cron, cronUsage } from "./cron";

const usage = `Usage: mybase <command>

Commands:
  project create <name>          Create a new project (database + storage bucket)
  project list                   List projects
  project delete <name> [--yes]  Delete a project, its database, and all its files
${cronUsage}
  help                           Show this message`;

async function main(args: string[]) {
  const [command, sub, ...rest] = args;

  if (command === "project" && sub === "create") {
    const name = rest[0];
    if (!name) throw new Error("missing project name");
    const project = await api<CreateProjectResponse>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const { database, storage } = project.credentials;
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
    if (projects.length === 0) console.log("No projects yet.");
    for (const p of projects) console.log(`${p.name}\t${p.storage?.bucket ?? "(no storage)"}\t${p.createdAt}`);
    return;
  }

  if (command === "project" && sub === "delete") {
    const name = rest.find((a) => !a.startsWith("-"));
    if (!name) throw new Error("missing project name");
    if (!rest.includes("--yes")) {
      console.log(`This permanently deletes project "${name}": its database, its storage bucket, and every file in it.`);
      const answer = prompt(`Type the project name to confirm:`);
      if (answer !== name) throw new Error("confirmation did not match, nothing deleted");
    }
    await api(`/projects/${name}`, { method: "DELETE" });
    console.log(`Deleted project "${name}"`);
    return;
  }

  if (command === "cron" && sub) {
    if (await cron(sub, rest)) return;
  }

  console.log(usage);
  if (command && command !== "help") process.exitCode = 1;
}

main(Bun.argv.slice(2)).catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

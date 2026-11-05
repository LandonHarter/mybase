// A project is a Postgres database + role and a storage bucket + key. This module
// keeps the two in step: create both or neither, and delete both.
import { PROJECT_DESCRIPTION_MAX, PROJECT_DISPLAY_NAME_MAX, type CreateProjectResponse, type Project, type UpdateProjectRequest } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { ProjectNotFoundError } from "./errors";
import * as postgres from "./postgres";
import { closeProjectSql } from "./project-db";
import { disableService, teardownOrder } from "./services";
import { createBucket, deleteBucket, storageInfo } from "./storage";

const toProject = ({ hasStorage, ...rest }: postgres.ProjectRecord): Project => ({
  ...rest,
  storage: hasStorage ? storageInfo(rest.name) : null,
});

export async function listProjects(): Promise<Project[]> {
  return (await postgres.listProjects()).map(toProject);
}

/** `name` must already match PROJECT_NAME_PATTERN. */
export async function createProject(name: string, log: Logger): Promise<CreateProjectResponse> {
  const { project, credentials: database } = await postgres.createDatabase(name, log);
  try {
    const storage = await createBucket(name, log);
    return { ...toProject(project), credentials: { database, storage } };
  } catch (err) {
    await postgres.dropDatabase(name, log).catch((dropErr) => log.error("database cleanup failed", { database: name, err: dropErr }));
    throw err;
  }
}

export class InvalidProjectUpdateError extends Error {}

// Collapses whitespace runs (incl. newlines) and drops control characters. "" → cleared.
function cleanText(value: unknown, field: string, max: number, multiline: boolean): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") throw new InvalidProjectUpdateError(`${field} must be a string or null`);
  let text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  text = multiline ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : text.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new InvalidProjectUpdateError(`${field} must be at most ${max} characters`);
  return text || undefined;
}

/**
 * Edits a project's display name and description. The project name itself can't change:
 * it is the database, role, bucket, and the key every service stores rows under.
 */
export async function updateProject(name: string, input: UpdateProjectRequest): Promise<Project> {
  if (typeof input !== "object" || input === null) throw new InvalidProjectUpdateError("expected a JSON object");
  const patch: { displayName?: string | undefined; description?: string | undefined } = {};
  if ("displayName" in input) patch.displayName = cleanText(input.displayName, "displayName", PROJECT_DISPLAY_NAME_MAX, false);
  if ("description" in input) patch.description = cleanText(input.description, "description", PROJECT_DESCRIPTION_MAX, true);
  // Cleared fields are undefined, so JSON.stringify drops them from the comment.
  const found = await postgres.updateProjectMeta(name, (meta) => ({ ...meta, ...patch }));
  if (!found) throw new ProjectNotFoundError(`project "${name}" not found`);
  const project = (await listProjects()).find((p) => p.name === name);
  if (!project) throw new ProjectNotFoundError(`project "${name}" not found`);
  return project;
}

/**
 * Optional services and storage go first: if a later step fails, the project still
 * lists and the delete can be retried.
 */
export async function deleteProject(name: string, log: Logger) {
  const project = (await postgres.listProjects()).find((p) => p.name === name);
  if (!project) throw new ProjectNotFoundError(`project "${name}" not found`);
  for (const service of teardownOrder(project.services)) await disableService(name, service, log);
  await deleteBucket(name, log);
  await closeProjectSql(name);
  await postgres.dropDatabase(name, log);
}

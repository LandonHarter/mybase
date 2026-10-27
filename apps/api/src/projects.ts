// A project is a Postgres database + role and a storage bucket + key. This module
// keeps the two in step: create both or neither, and delete both.
import type { CreateProjectResponse, Project } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { ProjectNotFoundError } from "./errors";
import * as postgres from "./postgres";
import { closeProjectSql } from "./project-db";
import { disableService } from "./services";
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

/**
 * Optional services and storage go first: if a later step fails, the project still
 * lists and the delete can be retried.
 */
export async function deleteProject(name: string, log: Logger) {
  const project = (await postgres.listProjects()).find((p) => p.name === name);
  if (!project) throw new ProjectNotFoundError(`project "${name}" not found`);
  for (const service of project.services) await disableService(name, service, log);
  await deleteBucket(name, log);
  await closeProjectSql(name);
  await postgres.dropDatabase(name, log);
}

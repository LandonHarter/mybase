/** Thrown when a database, role, or bucket with the project's name already exists. */
export class ProjectExistsError extends Error {}

/** Thrown when acting on a project that doesn't exist. */
export class ProjectNotFoundError extends Error {}

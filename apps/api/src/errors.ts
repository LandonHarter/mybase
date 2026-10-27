/** Thrown when a database, role, or bucket with the project's name already exists. */
export class ProjectExistsError extends Error {}

/** Thrown when acting on a project that doesn't exist. */
export class ProjectNotFoundError extends Error {}

/** The request names something that doesn't exist (a table, row, or extension). The message is safe to show. */
export class NotFoundError extends Error {}

/** The request is well-formed but can't be done in the current state. The message is safe to show. */
export class ConflictError extends Error {}

/** The request itself is invalid. The message is safe to show. */
export class BadRequestError extends Error {}

/** Postgres rejected SQL the user wrote or a row they edited. Carries what the dashboard shows. */
export class QueryFailedError extends Error {
  constructor(
    message: string,
    readonly position?: number,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

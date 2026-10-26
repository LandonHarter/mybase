export const DEFAULT_API_URL = "http://localhost:4000";

/** Project names double as Postgres identifiers, so keep them to a safe subset. */
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const PROJECT_NAME_RULES = "Use 1–40 lowercase letters, digits, or underscores, starting with a letter.";

export interface Project {
  name: string;
  createdAt: string;
  database: { name: string; user: string };
}

export interface CreateProjectRequest {
  name: string;
}

/** Returned once, at creation. The password is not stored or shown again. */
export interface ProjectCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
}

export interface CreateProjectResponse extends Project {
  credentials: ProjectCredentials;
}

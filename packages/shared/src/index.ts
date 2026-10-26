export const DEFAULT_API_URL = "http://localhost:4000";

/**
 * Project names double as Postgres identifiers and (with `_` → `-`) S3 bucket
 * names, so keep them to a subset both accept. Buckets need at least 3 chars.
 */
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;
export const PROJECT_NAME_RULES = "Use 3–40 lowercase letters, digits, or underscores, starting with a letter.";

/** Objects under this prefix are readable by anyone at the project's public URL. */
export const PUBLIC_PREFIX = "public/";

/** S3 bucket names can't contain `_`, and project names can't contain `-`, so this never collides. */
export const bucketName = (project: string) => project.replaceAll("_", "-");

/** Where apps reach the project's database. */
export interface DatabaseInfo {
  host: string;
  port: number;
  name: string;
  user: string;
}

/** Where apps reach the project's bucket, with any S3 client. */
export interface StorageInfo {
  endpoint: string;
  region: string;
  bucket: string;
  /** Base URL for objects under `public/`; append the rest of the key. */
  publicUrl: string;
}

export interface Project {
  name: string;
  createdAt: string;
  database: DatabaseInfo;
  /** `null` for projects created before storage existed. */
  storage: StorageInfo | null;
}

export interface CreateProjectRequest {
  name: string;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
}

/** A key pair that can use only this project's bucket. */
export interface StorageCredentials extends StorageInfo {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Returned once, at creation. Secrets are not stored or shown again. */
export interface ProjectCredentials {
  database: DatabaseCredentials;
  storage: StorageCredentials;
}

export interface CreateProjectResponse extends Project {
  credentials: ProjectCredentials;
}

export interface StorageFile {
  key: string;
  size: number;
  lastModified: string | null;
}

/** One level of a bucket: `folders` are key prefixes ending in `/`. */
export interface ListFilesResponse {
  prefix: string;
  folders: string[];
  files: StorageFile[];
}

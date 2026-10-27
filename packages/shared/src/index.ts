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
  /**
   * Postgres over WebSocket, for apps that can't open TCP to this machine (serverless hosts,
   * the Cloudflare Tunnel). Use with `@neondatabase/serverless`.
   */
  wsUrl: string;
}

/** Where apps reach the project's bucket, with any S3 client. */
export interface StorageInfo {
  endpoint: string;
  region: string;
  bucket: string;
  /** Base URL for objects under `public/`; append the rest of the key. */
  publicUrl: string;
}

/**
 * Every service a project can have. Core services are on for every project;
 * the rest are enabled per project (listed in `Project.services`).
 */
export const SERVICES = [
  { id: "database", name: "Database", description: "Postgres: tables, SQL, extensions", core: true },
  { id: "storage", name: "Storage", description: "S3-compatible file storage", core: true },
  { id: "cron", name: "Cron", description: "Call your app's endpoints on a schedule", core: false },
  { id: "analytics", name: "Analytics", description: "Page views, routes, errors, and custom events", core: false },
] as const satisfies readonly { id: string; name: string; description: string; core: boolean }[];

export type ServiceId = (typeof SERVICES)[number]["id"];

export interface Project {
  name: string;
  createdAt: string;
  database: DatabaseInfo;
  /** `null` for projects created before storage existed. */
  storage: StorageInfo | null;
  /** Optional services enabled for this project. Core services are always on and not listed. */
  services: ServiceId[];
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

/** A project database's live numbers, plus the settings the dashboard can change. */
export interface DatabaseDetails {
  sizeBytes: number;
  tables: number;
  activeConnections: number;
  /** `null` means no limit. */
  connectionLimit: number | null;
}

export interface UpdateDatabaseRequest {
  connectionLimit: number | null;
}

export interface Extension {
  name: string;
  description: string;
  defaultVersion: string;
  /** `null` when not enabled in this project's database. */
  installedVersion: string | null;
}

export interface TableSummary {
  schema: string;
  name: string;
  kind: "table" | "view" | "materialized view" | "foreign table" | "partitioned table";
  /** Estimated from planner stats; `null` when Postgres hasn't analyzed the table yet. */
  estimatedRows: number | null;
}

export interface Column {
  name: string;
  /** Postgres type as `format_type` prints it, e.g. `character varying(20)`. */
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

/** Cell values are Postgres' text output; `null` is SQL NULL. */
export type RowValues = Record<string, string | null>;

export interface TableRows {
  columns: Column[];
  rows: RowValues[];
  /** Exact for small tables, estimated for big ones (see `totalExact`). */
  total: number;
  totalExact: boolean;
  /** Rows can be edited only when the table has a primary key. */
  editable: boolean;
}

export interface InsertRowRequest {
  values: RowValues;
}

export interface UpdateRowRequest {
  /** Primary key columns and their current values. */
  key: RowValues;
  values: RowValues;
}

export interface DeleteRowRequest {
  key: RowValues;
}

export interface QueryRequest {
  sql: string;
}

export interface QueryResult {
  /** Command tag, e.g. `SELECT`, `INSERT`, `CREATE TABLE`. */
  command: string;
  rowCount: number;
  columns: string[];
  rows: (string | null)[][];
  /** Set when more rows came back than the dashboard shows. */
  truncated: boolean;
}

export interface QueryResponse {
  results: QueryResult[];
}

export interface QueryError {
  error: string;
  /** 1-based character offset into the SQL, when Postgres reports one. */
  position?: number;
  detail?: string;
  hint?: string;
}

/** Cron job names: unique per project, safe in URLs and headers. */
export const CRON_JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const CRON_JOB_NAME_RULES = "Use 1–63 lowercase letters, digits, `_`, or `-`, starting with a letter or digit.";

/** Where a job is defined: the dashboard/CLI, or an app's mybase.config.ts (edited only by `mybase cron sync`). */
export type CronJobSource = "dashboard" | "code";

export interface CronRunSummary {
  status: "success" | "failed";
  httpStatus: number | null;
  finishedAt: string;
}

export interface CronJob {
  name: string;
  /** 5-field cron expression. */
  schedule: string;
  /** IANA time zone the schedule is read in. */
  timezone: string;
  url: string;
  payload: unknown;
  timeoutMs: number;
  /** Extra tries after a failed call. */
  retries: number;
  enabled: boolean;
  source: CronJobSource;
  /** `null` when paused. */
  nextRunAt: string | null;
  lastRun: CronRunSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronRunRecord {
  id: string;
  trigger: "schedule" | "manual";
  status: "success" | "failed";
  attempts: number;
  /** Last attempt's status; `null` when it never got a response (network error, timeout). */
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  /** Start of the last response body, truncated. */
  response: string | null;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
}

/** The fields a job is made of. Optional ones fall back to the defaults below. */
export interface CronJobSpec {
  schedule: string;
  url: string;
  timezone?: string;
  payload?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export const CRON_DEFAULTS = { timezone: "UTC", timeoutMs: 30_000, retries: 2 } as const;

export interface CreateCronJobRequest extends CronJobSpec {
  name: string;
  enabled?: boolean;
}

export type UpdateCronJobRequest = Partial<CreateCronJobRequest>;

/** Replaces the project's code-defined jobs with this set. */
export interface SyncCronJobsRequest {
  jobs: (CronJobSpec & { name: string })[];
  dryRun?: boolean;
}

export interface SyncCronJobsResponse {
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
}

export interface RunCronJobResponse {
  runId: string;
}

/** The project's signing secret. Unlike database and storage credentials, mybase keeps it: it signs every call. */
export interface CronSecret {
  secret: string;
  rotatedAt: string;
}

export interface CronOverview {
  jobs: number;
  enabled: number;
  nextRunAt: string | null;
  /** One-off tasks waiting to run. */
  pendingTasks: number;
}

// One-off tasks: the SDK owns the wire types (apps import them from @mybase/sdk/cron).
export type { CreateCronTaskRequest, CronTask, CronTaskStatus } from "@mybase/sdk/cron";
export const CRON_TASK_STATUSES = ["pending", "running", "success", "failed", "cancelled"] as const;

// Analytics: the SDK owns the ingest wire types (apps import them from @mybase/sdk/analytics).
export type { AnalyticsEvent, AnalyticsEventType, AnalyticsIngestRequest, AnalyticsProps } from "@mybase/sdk/analytics";

/** Time ranges the analytics dashboard and API report on. `24h` is bucketed by hour, the rest by day. */
export const ANALYTICS_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export interface AnalyticsTotals {
  pageviews: number;
  /** Distinct visitors. Visitor ids rotate daily, so over several days this counts daily visitors. */
  visitors: number;
  events: number;
  errors: number;
}

/** One row of a top-N list, e.g. a route and its page views. */
export interface AnalyticsCount {
  value: string;
  count: number;
  visitors: number;
}

/** Errors with the same message and top stack frame. */
export interface AnalyticsErrorGroup {
  fingerprint: string;
  message: string;
  count: number;
  visitors: number;
  lastSeen: string;
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  bucket: "hour" | "day";
  /** Start of the range (ISO). */
  since: string;
  totals: AnalyticsTotals;
  /** The same totals for the period just before, for comparison. */
  previous: AnalyticsTotals;
  /** One point per bucket, oldest first. `t` is local to the requested time zone, without an offset (`2026-10-26T14:00`). */
  series: { t: string; pageviews: number; visitors: number }[];
  routes: AnalyticsCount[];
  referrers: AnalyticsCount[];
  /** ISO 3166 alpha-2 codes. */
  countries: AnalyticsCount[];
  browsers: AnalyticsCount[];
  os: AnalyticsCount[];
  devices: AnalyticsCount[];
  /** Custom events by name. */
  events: AnalyticsCount[];
  errors: AnalyticsErrorGroup[];
}

/** One stored event, as the dashboard and API list them. */
export interface AnalyticsEventRecord {
  id: string;
  type: "pageview" | "event" | "error";
  name: string | null;
  path: string | null;
  referrer: string | null;
  country: string | null;
  browser: string | null;
  os: string | null;
  device: "desktop" | "mobile" | "tablet" | null;
  props: Record<string, string | number | boolean | null> | null;
  stack: string | null;
  fingerprint: string | null;
  /** Anonymous daily visitor id. */
  visitor: string;
  ts: string;
}

export interface AnalyticsSettings {
  /** Public: goes in browser code. It can only add events. */
  writeKey: string;
  /** When not empty, browser requests must come from one of these origins. */
  allowedOrigins: string[];
  /** Events older than this are deleted. */
  retentionDays: number;
  /** Where apps send events. */
  ingestUrl: string;
  /** The script-tag build of the client. */
  scriptUrl: string;
  /** The API's public URL, for `createAnalytics({ apiUrl })`. */
  apiUrl: string;
  enabledAt: string;
}

export interface UpdateAnalyticsSettingsRequest {
  allowedOrigins?: string[];
  retentionDays?: number;
}

/** What the dashboard needs before showing anything: first-run setup, the login form, or the app. */
export interface AuthStatus {
  /** No admin account exists yet. */
  setupNeeded: boolean;
  authenticated: boolean;
  username: string | null;
}

/** Admin passwords: long enough to survive guessing over the internet. */
export const ADMIN_PASSWORD_MIN = 10;

export interface SetupRequest {
  username: string;
  password: string;
}

/**
 * Without `tokenName`, logs in a browser (session cookie). With it, creates an API token
 * under that name and returns it instead (`mybase login`).
 */
export interface LoginRequest {
  username: string;
  password: string;
  tokenName?: string;
}

export interface LoginResponse {
  username: string;
  /** Only when `tokenName` was sent. Shown once, never stored in plain text. */
  token?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** A token for the CLI and scripts: `Authorization: Bearer <token>`. */
export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  /** Updated at most hourly. */
  lastUsedAt: string | null;
}

export interface CreateApiTokenRequest {
  name: string;
}

export interface CreateApiTokenResponse extends ApiToken {
  /** Shown once. */
  token: string;
}

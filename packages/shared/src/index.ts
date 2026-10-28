import type { CreateQueueRequest, Queue } from "@mybase-dev/sdk/queue";
import type { VectorIndex, VectorIndexInput } from "@mybase-dev/sdk/vector";
import type { RateLimitAlgorithm } from "@mybase-dev/sdk/ratelimit";

export const DEFAULT_API_URL = "http://localhost:4000";

/** The platform's version (API, dashboard, CLI). apps/cli/package.json carries the same one. */
export const MYBASE_VERSION = "1.0.7";

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
  /** TLS is on and required from the internet (public access with a Let's Encrypt cert). */
  ssl: boolean;
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
  { id: "cache", name: "Cache", description: "Redis-compatible key-value cache", core: false },
  { id: "ratelimit", name: "Rate limits", description: "Shared rate limits for your app's routes", core: false },
  { id: "queue", name: "Queues", description: "SQS-style message queues: standard and FIFO", core: false },
  { id: "search", name: "Web search", description: "Search the web and read pages as markdown, for agents", core: false },
  { id: "secrets", name: "Secrets", description: "Encrypted env vars per environment, injected with mybase run", core: false },
  { id: "vector", name: "Vector search", description: "Vector, full-text, and hybrid search over your documents", core: false },
  { id: "users", name: "Users", description: "Sign-in for your app's users, with Better Auth", core: false },
  { id: "captcha", name: "Captcha", description: "Self-hosted bot checks for your forms, no puzzles", core: false },
  { id: "realtime", name: "Realtime", description: "WebSocket channels: live updates, chat, and presence for serverless apps", core: false },
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
  ssl: boolean;
  url: string;
}

/** `GET /database/public`: public Postgres (port forward + Let's Encrypt + DDNS), see docs/database.md. */
export interface DbPublicStatus {
  /** MYBASE_DB_PUBLIC is on. */
  enabled: boolean;
  /** Why it can't run (missing host or token), when enabled. */
  problem: string | null;
  host: string;
  port: number;
  tls: {
    /** Connection strings ask for TLS (a valid certificate is installed). */
    active: boolean;
    notAfter: string | null;
    issuedAt: string | null;
    staging: boolean;
    error: string | null;
    nextAttemptAt: string | null;
  };
  dns: {
    ip: string | null;
    checkedAt: string | null;
    error: string | null;
  };
}

/** A project's connection string. `sslmode=require` once the database has a public TLS cert. */
export const databaseUrl = (db: { host: string; port: number; user: string; ssl: boolean } & ({ name: string } | { database: string }), password = "<password>") =>
  `postgres://${db.user}:${password}@${db.host}:${db.port}/${"name" in db ? db.name : db.database}${db.ssl ? "?sslmode=require" : ""}`;

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

/** A table or view with its columns (`GET /projects/:name/database/schema`). */
export interface SchemaTable {
  schema: string;
  name: string;
  kind: TableSummary["kind"];
  columns: Column[];
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

// One-off tasks: the SDK owns the wire types (apps import them from @mybase-dev/sdk/cron).
export type { CreateCronTaskRequest, CronTask, CronTaskStatus } from "@mybase-dev/sdk/cron";
export const CRON_TASK_STATUSES = ["pending", "running", "success", "failed", "cancelled"] as const;

// Analytics: the SDK owns the ingest wire types (apps import them from @mybase-dev/sdk/analytics).
export type { AnalyticsEvent, AnalyticsEventType, AnalyticsIngestRequest, AnalyticsProps } from "@mybase-dev/sdk/analytics";

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
// ---- cache ------------------------------------------------------------------

/** Where apps reach the project's cache. Every key must start with `keyPrefix`. */
export interface CacheInfo {
  host: string;
  port: number;
  /** The project's Valkey user (same as the project name). */
  user: string;
  keyPrefix: string;
  /** `redis://<user>@host:port`, without the password. */
  url: string;
  /** HTTP endpoint (Upstash REST format): POST a command as a JSON array, an API key (`cache:write`) as Bearer token. */
  httpUrl: string;
  enabledAt: string;
  rotatedAt: string;
}

/** Returned once, when the cache is enabled or its password rotated. The password isn't stored. */
export interface CacheCredentials extends CacheInfo {
  password: string;
  /** `redis://<user>:<password>@host:port`. */
  url: string;
}

export interface CacheOverview {
  info: CacheInfo;
  keys: number;
  /** The whole Valkey server, shared by every project. */
  memory: { usedBytes: number; maxBytes: number; policy: string };
}

export const CACHE_KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream"] as const;
export type CacheKeyType = (typeof CACHE_KEY_TYPES)[number] | "other";

export interface CacheKeySummary {
  /** Full key, prefix included. */
  key: string;
  type: CacheKeyType;
  /** Milliseconds left, or null with no expiry. */
  ttlMs: number | null;
}

export interface CacheKeyList {
  keys: CacheKeySummary[];
  /** Pass back for the next page; null at the end. */
  cursor: string | null;
}

export type CacheValue =
  | { type: "string"; value: string }
  | { type: "hash"; value: Record<string, string> }
  | { type: "list"; value: string[] }
  | { type: "set"; value: string[] }
  | { type: "zset"; value: { member: string; score: number }[] }
  | { type: "stream"; value: { id: string; fields: Record<string, string> }[] }
  | { type: "other"; value: null };

export type CacheKeyDetail = CacheKeySummary &
  CacheValue & {
    /** Elements (or bytes, for strings) in the key. */
    size: number;
    /** True when `value` shows only the first part. */
    truncated: boolean;
  };

/** Writes a string or hash key. `ttlMs` null clears the expiry; absent keeps it. */
export interface PutCacheKeyRequest {
  type: "string" | "hash";
  value: string | Record<string, string>;
  ttlMs?: number | null;
}

// ---- rate limits ------------------------------------------------------------

// The SDK owns the wire types apps use (`@mybase-dev/sdk/ratelimit`). Types only: the dashboard's
// browser build can't resolve the SDK's runtime code, so values come from the SDK directly.
export type { InlineLimit, RateLimitAlgorithm, RateLimitRequest, RateLimitResult } from "@mybase-dev/sdk/ratelimit";

/** Rule names: unique per project, safe in URLs and Valkey keys. */
export const RATELIMIT_RULE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const RATELIMIT_RULE_NAME_RULES = "Use 1–63 lowercase letters, digits, `_`, or `-`, starting with a letter or digit.";

export type RateLimitRuleSource = "dashboard" | "code";

export interface RateLimitRuleSpec {
  algorithm: RateLimitAlgorithm;
  limit: number;
  windowMs: number;
  /** Token bucket capacity; null = `limit`. Ignored by the other algorithms. */
  burst: number | null;
}

export interface RateLimitRule extends RateLimitRuleSpec {
  name: string;
  source: RateLimitRuleSource;
  createdAt: string;
  updatedAt: string;
}

/** Create or edit a rule. `window` may be ms or `"10s"`/`"1m"`/…; `windowMs` also works. */
export interface CreateRateLimitRuleRequest {
  name: string;
  algorithm?: RateLimitAlgorithm;
  limit: number;
  window?: number | string;
  windowMs?: number;
  burst?: number | null;
}

export type UpdateRateLimitRuleRequest = Partial<CreateRateLimitRuleRequest>;

export interface SyncRateLimitRulesRequest {
  rules: Omit<CreateRateLimitRuleRequest, "windowMs">[];
  dryRun?: boolean;
}

export interface SyncRateLimitRulesResponse {
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
}

export interface RateLimitSettings {
  /** Apps POST here (`createRateLimiter` in the SDK). */
  apiUrl: string;
  limitUrl: string;
  enabledAt: string;
}

export const RATELIMIT_STATS_RANGES = ["24h", "7d"] as const;
export type RateLimitStatsRange = (typeof RATELIMIT_STATS_RANGES)[number];

export interface RateLimitStatsPoint {
  /** Start of the hour (ISO). */
  t: string;
  allowed: number;
  blocked: number;
}

export interface RateLimitRuleStats {
  /** Rule name, or `_inline` for every inline limit together. */
  rule: string;
  allowed: number;
  blocked: number;
  series: RateLimitStatsPoint[];
}

export interface RateLimitStats {
  range: RateLimitStatsRange;
  rules: RateLimitRuleStats[];
}

// ---- queues -----------------------------------------------------------------

// The SDK owns the wire types apps use (`@mybase-dev/sdk/queue`). Types only, as with rate limits.
export type {
  BatchFailure,
  BatchResult,
  ChangeVisibilityRequest,
  CreateQueueRequest,
  DeadLetterSettings,
  DeleteMessagesRequest,
  Queue,
  QueueAttributes,
  QueueCounts,
  QueueMessage,
  QueueSettings,
  QueueSettingsInput,
  QueueSource,
  ReceiveMessagesRequest,
  ReceiveMessagesResponse,
  RedriveRequest,
  RedriveResponse,
  SendMessageEntry,
  SendMessagesRequest,
  SendMessagesResponse,
  SentMessage,
} from "@mybase-dev/sdk/queue";

export interface QueueServiceSettings {
  /** The API's public URL, for `createQueueClient({ apiUrl })`. */
  apiUrl: string;
  /** Apps call `<baseUrl>/<queue>/…`. */
  baseUrl: string;
  enabledAt: string;
}

/** A message as the dashboard lists it, without receiving it. No receipt: peeking doesn't change anything. */
export interface QueueMessageRecord {
  messageId: string;
  body: string;
  /** Bodies are cut at 4 KB in listings. */
  truncated: boolean;
  bytes: number;
  attributes: Record<string, string | number | boolean>;
  groupId: string | null;
  dedupId: string | null;
  sequence: string | null;
  state: "visible" | "inFlight" | "delayed";
  receiveCount: number;
  sentAt: string;
  /** When it can next be received (in the future for in-flight and delayed messages). */
  visibleAt: string;
  expiresAt: string;
  /** Set on messages moved to a dead-letter queue: where they came from. */
  deadLetteredFrom: string | null;
}

export interface SyncQueuesRequest {
  queues: CreateQueueRequest[];
  dryRun?: boolean;
}

export interface SyncQueuesResponse {
  created: string[];
  updated: string[];
  /** Deleting a queue deletes its messages. */
  deleted: string[];
  unchanged: string[];
}

export const QUEUE_STATS_RANGES = ["24h", "7d"] as const;
export type QueueStatsRange = (typeof QUEUE_STATS_RANGES)[number];

export interface QueueStatsPoint {
  /** Start of the hour (ISO). */
  t: string;
  sent: number;
  received: number;
  deleted: number;
  /** Moved to the dead-letter queue. */
  dead: number;
}

export interface QueueStatsSeries {
  queue: string;
  sent: number;
  received: number;
  deleted: number;
  dead: number;
  series: QueueStatsPoint[];
}

export interface QueueStats {
  range: QueueStatsRange;
  queues: QueueStatsSeries[];
}

// ---- vector search ----------------------------------------------------------

// The SDK owns the wire types apps use (`@mybase-dev/sdk/vector`).
export type {
  DeleteDocumentsRequest,
  DeleteDocumentsResponse,
  EmbeddingSettings,
  ListDocumentsResponse,
  StoredDocument,
  UpsertDocumentsRequest,
  UpsertDocumentsResponse,
  VectorDocument,
  VectorIndex,
  VectorIndexInput,
  VectorIndexSettings,
  VectorIndexSource,
  VectorLanguage,
  VectorMatch,
  VectorMetadata,
  VectorMetric,
  VectorQueryMode,
  VectorQueryRequest,
  VectorQueryResponse,
  VectorServiceSettings,
} from "@mybase-dev/sdk/vector";

export type CreateVectorIndexRequest = VectorIndexInput & { name: string };

/** `PUT /projects/:name/vector`. `apiKey`: omit to keep the stored one, null to remove it. */
export interface UpdateVectorSettingsRequest {
  embedding: { url: string; model: string; dimensions: number; apiKey?: string | null } | null;
}

export interface SyncVectorIndexesRequest {
  indexes: CreateVectorIndexRequest[];
  dryRun?: boolean;
}

export interface SyncVectorIndexesResponse {
  created: string[];
  updated: string[];
  /** Deleting an index deletes its documents. */
  deleted: string[];
  unchanged: string[];
}

/** What enabling an optional service returns: credentials shown once, when it has any. */
export type EnableServiceResponse = { service: "cache"; credentials: CacheCredentials };

/** Optional body of `PUT /projects/:name/services/:id`. */
export interface EnableServiceRequest {
  /** Add the service's keys to the project's linked secrets envs (`mybase secrets link`). */
  link?: boolean;
}

export interface AuthStatus {
  /** No admin account exists yet. */
  setupNeeded: boolean;
  authenticated: boolean;
  username: string | null;
  /** What the request's key may do. Sessions: `["admin"]`. */
  permissions: KeyPermission[] | null;
  /** Projects the key is limited to; null = all. */
  projects: string[] | null;
  /** Secrets environments the key is limited to; null = all. */
  environments: string[] | null;
  /** The admin's 2FA, when signed in. */
  mfa?: MfaStatus;
}

export interface MfaStatus {
  /** Sign-ins need a code from an authenticator app. */
  totp: boolean;
  recoveryCodesLeft: number;
}

/** `POST /auth/mfa/totp`: what to add to the authenticator app. Confirm with a code to turn 2FA on. */
export interface TotpSetupResponse {
  /** Base32, for typing in by hand. */
  secret: string;
  /** `otpauth://` URI, for the QR code. */
  uri: string;
}

/** Shown once. Each works once in place of a code. */
export interface RecoveryCodesResponse {
  codes: string[];
}

/** `POST /auth/login/mfa`: the challenge from `/auth/login` and a TOTP or recovery code. */
export interface MfaLoginRequest {
  challenge: string;
  code: string;
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
  /** 2FA is on: nothing was issued yet. Send `challenge` and a code to `/auth/login/mfa`. */
  mfaRequired?: true;
  challenge?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** What API keys can be granted, per resource. `write` includes `read`. */
export const KEY_RESOURCES = [
  { id: "projects", name: "Projects", description: "List projects; create, delete, and turn services on or off" },
  { id: "database", name: "Database", description: "Database details, tables, and rows (the SQL editor needs admin)" },
  { id: "storage", name: "Storage", description: "Files in the project's bucket" },
  { id: "cron", name: "Cron", description: "Jobs, runs, and one-off tasks" },
  { id: "analytics", name: "Analytics", description: "Reports, events, and settings" },
  { id: "cache", name: "Cache", description: "Keys, and HTTP commands (write)" },
  { id: "ratelimit", name: "Rate limits", description: "Rules and stats, and limit checks (write)" },
  { id: "queue", name: "Queues", description: "Queues and messages (receiving is a write)" },
  { id: "search", name: "Web search", description: "Web searches and page reads (read)" },
  { id: "secrets", name: "Secrets", description: "Secret values per environment (read), and changing them (write)" },
  { id: "vector", name: "Vector search", description: "Indexes, documents, and queries (read), and changing them (write)" },
  { id: "users", name: "Users", description: "Your app's users and sessions (read), revoking and deleting them, and sending sign-in events (write)" },
  { id: "captcha", name: "Captcha", description: "Captcha settings (read), and verifying tokens (write)" },
  { id: "realtime", name: "Realtime", description: "Channels, members, and settings (read), and publishing messages (write)" },
  { id: "audit", name: "Audit log", description: "Who did what: sign-ins, key and project changes, secret reads (read only)" },
] as const satisfies readonly { id: string; name: string; description: string }[];

export type KeyResource = (typeof KEY_RESOURCES)[number]["id"];
export type KeyLevel = "read" | "write";
/** `admin` = everything, including keys, sessions, and the admin password. */
export type KeyPermission = "admin" | `${KeyResource}:${KeyLevel}`;

/** An API key for apps, the CLI, and scripts: `Authorization: Bearer <token>`. */
export interface ApiToken {
  id: string;
  name: string;
  permissions: KeyPermission[];
  /** Projects the key is limited to; null = all. */
  projects: string[] | null;
  /** Secrets environments (by name, in any of its projects) the key is limited to; null = all. */
  environments: string[] | null;
  createdAt: string;
  /** Updated at most hourly. */
  lastUsedAt: string | null;
}

export interface CreateApiTokenRequest {
  name: string;
  /** Default `["admin"]`. */
  permissions?: KeyPermission[];
  /** Default null (all projects). Not allowed with `admin`. */
  projects?: string[] | null;
  /** Default null (all secrets environments). Needs a `secrets:` permission; not allowed with `admin`. */
  environments?: string[] | null;
}

export type UpdateApiTokenRequest = Partial<CreateApiTokenRequest>;

export interface CreateApiTokenResponse extends ApiToken {
  /** Shown once. */
  token: string;
}

// ---- web search -------------------------------------------------------------

// The SDK owns the wire types apps use (`@mybase-dev/sdk/search`). Types only, as with rate limits.
export type {
  FetchResponse,
  SearchCategory,
  SearchResponse,
  SearchResult,
  SearchTimeRange,
} from "@mybase-dev/sdk/search";

// ---- secrets ----------------------------------------------------------------

// The SDK owns the wire types (`@mybase-dev/sdk/secrets`); the API checks names and sizes.

/**
 * Parses a `.env` file: `KEY=value`, `export KEY=value`, `#` comments, single/double quotes,
 * `\n` escapes and multi-line values in double quotes. No `${VAR}` expansion.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*('[^']*'|"(?:\\.|[^"\\])*"|[^\n]*?)[ \t]*$/gm;
  for (const m of text.replace(/\r\n?/g, "\n").matchAll(re)) {
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith("'")) value = value.slice(1, -1);
    else if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
    else value = value.replace(/\s+#.*$/, "").trim();
    out[key] = value;
  }
  return out;
}

export type {
  CreateSecretsEnvRequest,
  LinkCredentialsRequest,
  LinkCredentialsResponse,
  SecretChange,
  SecretChangeAction,
  SecretEntry,
  SecretsEnv,
  SecretsEnvDetail,
  SecretsOverview,
  SecretsResponse,
  SecretsRevision,
  UpdateSecretsRequest,
  UpdateSecretsResponse,
} from "@mybase-dev/sdk/secrets";

// ---- docs + agents ----------------------------------------------------------

/** A docs page as listed by `GET /docs` (the markdown itself is at `url`). */
export interface DocPage {
  /** `quickstart`, `sdk/queues`, … */
  slug: string;
  title: string;
  summary: string;
  section: string;
  url: string;
}

/** One `##` section that matched `GET /docs/search?q=`. */
export interface DocSearchHit {
  slug: string;
  title: string;
  heading: string;
  url: string;
  snippet: string;
  score: number;
}

/**
 * Everything an agent needs to work on one project, without secrets
 * (`GET /projects/:name/context`). A section is missing when the caller's key can't read it.
 */
export interface ProjectContext {
  project: string;
  createdAt: string;
  apiUrl: string;
  docsUrl: string;
  /** Optional services that are on. Database and storage are always on. */
  services: ServiceId[];
  database?: DatabaseInfo & { tables: SchemaTable[] };
  storage?: StorageInfo | null;
  cron?: { jobs: Pick<CronJob, "name" | "schedule" | "timezone" | "url" | "enabled" | "source" | "nextRunAt" | "lastRun">[] };
  queue?: { queues: Pick<Queue, "name" | "fifo" | "counts" | "deadLetter" | "source">[] };
  ratelimit?: { rules: Pick<RateLimitRule, "name" | "algorithm" | "limit" | "windowMs" | "burst" | "source">[] };
  cache?: { url: string; httpUrl: string; keyPrefix: string };
  analytics?: { writeKey: string; scriptUrl: string; ingestUrl: string };
  search?: { searchUrl: string; fetchUrl: string };
  vector?: { embedding: { model: string; dimensions: number } | null; indexes: Pick<VectorIndex, "name" | "dimensions" | "metric" | "language" | "embed" | "documents" | "source">[] };
  /** Env and key names only, never values. */
  secrets?: { envs: { name: string; parent: string | null; keys: string[]; linked: boolean }[] };
  /** Counts only: no user data. `ready` = Better Auth's migrations ran. */
  users?: { ready: boolean; users: number; schema: string };
  captcha?: { challengeUrl: string; scriptUrl: string; siteVerifyUrl: string };
  realtime?: { socketUrl: string; publishUrl: string };
  /** Env vars an app on this project usually sets (values are never included). */
  env: { name: string; description: string }[];
  /** Docs pages worth reading for this project, most relevant first. */
  docs: { slug: string; title: string; url: string }[];
}

// ---- security advisor -------------------------------------------------------

export const ADVISOR_SEVERITIES = ["critical", "warn", "info"] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

/** One problem the security advisor found (`GET /advisor`, `GET /projects/:name/advisor`). */
export interface AdvisorFinding {
  /** Stable check id, e.g. `admin-no-2fa`. */
  id: string;
  severity: AdvisorSeverity;
  /** null for instance-wide findings. */
  project: string | null;
  title: string;
  detail: string;
  /** What to do about it. */
  fix: string;
  /** Docs slug with more, e.g. `security`. */
  docs?: string;
}

export interface AdvisorReport {
  checkedAt: string;
  findings: AdvisorFinding[];
  /** Ids of every check that ran, found something or not. */
  checks: string[];
}

// ---- audit log --------------------------------------------------------------

export const AUDIT_OUTCOMES = ["ok", "denied", "failed"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Who did it: the admin's browser session, an API key, someone not signed in, or mybase itself. */
export type AuditActorKind = "session" | "token" | "anonymous" | "system";

/** One audit log entry (`GET /audit`). Never holds secret values, SQL text, or request bodies. */
export interface AuditEventRecord {
  id: string;
  at: string;
  actor: { kind: AuditActorKind; id: string | null; name: string | null };
  ip: string | null;
  /** `auth.login`, `token.created`, `secrets.read`, `<service>.changed`, … */
  action: string;
  outcome: AuditOutcome;
  project: string | null;
  /** What was acted on: a key id, an env name, a table, a file key, `METHOD /path`. */
  target: string | null;
  meta: Record<string, string | number | boolean | null> | null;
  requestId: string | null;
}

export interface AuditEventList {
  events: AuditEventRecord[];
  /** Pass as `before` for the next (older) page; null at the end. */
  next: string | null;
}

export interface AuditSettings {
  /** Days kept, 7–365. */
  retentionDays: number;
}

/** Action groups for filters: the part before the dot. */
export const AUDIT_ACTION_GROUPS = [
  { id: "auth", name: "Sign-ins" },
  { id: "mfa", name: "Two-factor" },
  { id: "token", name: "API keys" },
  { id: "key", name: "Rejected keys" },
  { id: "project", name: "Projects" },
  { id: "service", name: "Services" },
  { id: "secrets", name: "Secrets" },
  { id: "database", name: "Database" },
  { id: "storage", name: "Storage" },
  { id: "dbproxy", name: "Database proxy" },
  { id: "alert", name: "Alerts" },
  { id: "users", name: "App users" },
  { id: "settings", name: "Settings" },
] as const;

// ---- security alerts --------------------------------------------------------

/** Built-in alert rules over the audit log. Each can be turned off; all are on by default. */
export const ALERT_RULES = [
  { id: "login.failed_burst", name: "Failed sign-ins", description: "10 or more failed admin sign-ins within 10 minutes" },
  { id: "login.new_ip", name: "Sign-in from a new address", description: "The admin signed in from an IP not seen in the last 30 days" },
  { id: "mfa.disabled", name: "2FA turned off", description: "Two-factor authentication was turned off" },
  { id: "mfa.recovery_used", name: "Recovery code used", description: "A 2FA recovery code was used to sign in" },
  { id: "auth.password_changed", name: "Password changed", description: "The admin password was changed" },
  { id: "token.admin_created", name: "Admin API key created", description: "A new API key with full admin access was created" },
  { id: "secrets.new_reader", name: "New secrets reader", description: "An API key read a secrets environment it hadn't read in the last 30 days" },
  { id: "key.rejected_burst", name: "Wrong API keys", description: "Wrong API keys from 10 or more address-minutes within 10 minutes" },
  { id: "dbproxy.rejected_burst", name: "Rejected database connections", description: "Rejected database connections from 10 or more address-minutes within 10 minutes" },
  { id: "advisor.critical", name: "Critical security finding", description: "The daily security advisor run found a new critical problem" },
] as const satisfies readonly { id: string; name: string; description: string }[];

export type AlertRuleId = (typeof ALERT_RULES)[number]["id"];

export const ALERT_CHANNEL_KINDS = ["webhook", "ntfy"] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

/** Where alerts go. Webhooks are signed like cron calls (`verifyCronSignature` with `secret`). */
export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  url: string;
  enabled: boolean;
  /** Webhooks only: signs `X-Mybase-Signature`. */
  secret: string | null;
  /** ntfy only: whether an access token is set (it's never shown). */
  hasToken: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface CreateAlertChannelRequest {
  name?: string;
  kind: AlertChannelKind;
  url: string;
  /** ntfy access token, for protected topics. */
  token?: string | null;
}

export interface UpdateAlertChannelRequest {
  name?: string;
  url?: string;
  enabled?: boolean;
  /** null clears it. */
  token?: string | null;
}

export interface AlertRule {
  id: AlertRuleId;
  name: string;
  description: string;
  enabled: boolean;
}

export interface AlertsOverview {
  channels: AlertChannel[];
  rules: AlertRule[];
}

/** What a webhook receives (JSON body). */
export interface AlertPayload {
  rule: AlertRuleId | "test";
  title: string;
  detail: string;
  at: string;
  /** This instance's public URL. */
  instance: string;
}

// ---- users (Better Auth) ----------------------------------------------------

/** One of the app's users, read from Better Auth's `user` table. */
export interface AppUser {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean | null;
  image: string | null;
  createdAt: string | null;
  /** Only with Better Auth's admin plugin. */
  banned: boolean | null;
  role: string | null;
}

export interface AppSession {
  id: string;
  createdAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AppUserDetail extends AppUser {
  sessions: AppSession[];
  /** Sign-in methods: `credential` (email + password), `github`, `google`, … */
  providers: string[];
}

export interface UsersOverview {
  /** Better Auth's tables exist (its migrations ran). */
  ready: boolean;
  users: number;
  activeSessions: number;
  /** Sessions are stored in the database (`session.storeSessionInDatabase`), so they can be listed. */
  sessionsInDatabase: boolean;
  schema: string;
  /** What an app needs: the database URL options and env var names. */
  setup: { databaseOptions: string; apiUrl: string };
}

export interface AppUserList {
  users: AppUser[];
  total: number;
}

// ---- captcha ----------------------------------------------------------------

export type { CaptchaChallenge, CaptchaVerifyResponse } from "@mybase-dev/sdk/captcha";

export interface CaptchaSettings {
  /** For server-side checks (Better Auth's `secretKey`, Turnstile-style siteverify). */
  secretKey: string;
  /** The work per challenge: numbers the browser may try. */
  maxNumber: number;
  challengeUrl: string;
  siteVerifyUrl: string;
  scriptUrl: string;
}

export interface UpdateCaptchaSettingsRequest {
  maxNumber?: number;
}

// ---- realtime ---------------------------------------------------------------

export type { ChannelInfo, PublishMessage, RealtimeMember, RealtimeWebhookEvent } from "@mybase-dev/sdk/realtime";

export const REALTIME_WEBHOOK_EVENTS = ["message", "presence", "channel"] as const;
export type RealtimeWebhookEventType = (typeof REALTIME_WEBHOOK_EVENTS)[number];

/** Per-project settings (`GET/PATCH /projects/:name/realtime`). */
export interface RealtimeSettings {
  /** Signs browser tokens (`createRealtimeToken`) and webhook calls. */
  secret: string;
  maxConnections: number;
  maxChannels: number;
  maxMessageBytes: number;
  /** Frames per second per socket. */
  maxRate: number;
  /** Sockets without a token may subscribe to `public:…` channels. */
  publicChannels: boolean;
  /** Origins allowed to open sockets (`https://shop.example.com`); empty = any. */
  allowedOrigins: string[];
  webhookUrl: string | null;
  webhookEvents: RealtimeWebhookEventType[];
  /** wss:// URL browsers connect to. */
  socketUrl: string;
  publishUrl: string;
}

export type UpdateRealtimeSettingsRequest = Partial<Omit<RealtimeSettings, "secret" | "socketUrl" | "publishUrl">>;

/** Counted in memory since the API started (last 24 hours, per hour). */
export interface RealtimeStats {
  connections: number;
  peakConnections: number;
  channels: number;
  hours: { hour: string; messagesIn: number; messagesOut: number; connects: number; webhookOk: number; webhookFailed: number }[];
  webhook: { queued: number; dropped: number; lastError: string | null; lastErrorAt: string | null };
}

import type {
  AnalyticsEventRecord,
  AnalyticsOverview,
  AnalyticsRange,
  AnalyticsSettings,
  UpdateAnalyticsSettingsRequest,
  ApiToken,
  AuthStatus,
  ChangePasswordRequest,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  LoginRequest,
  LoginResponse,
  SetupRequest,
  CreateCronJobRequest,
  CreateProjectRequest,
  CronJob,
  CronOverview,
  CronRunRecord,
  CronSecret,
  CronTask,
  CronTaskStatus,
  CacheCredentials,
  CacheKeyDetail,
  CacheKeyList,
  CacheOverview,
  CreateRateLimitRuleRequest,
  EnableServiceResponse,
  PutCacheKeyRequest,
  RateLimitKey,
  RateLimitResult,
  RateLimitRule,
  RateLimitSettings,
  RateLimitStats,
  RateLimitStatsRange,
  UpdateRateLimitRuleRequest,
  RunCronJobResponse,
  ServiceId,
  UpdateCronJobRequest,
  CreateProjectResponse,
  DatabaseDetails,
  DeleteRowRequest,
  Extension,
  InsertRowRequest,
  ListFilesResponse,
  Project,
  QueryResponse,
  TableRows,
  TableSummary,
  UpdateDatabaseRequest,
  UpdateRowRequest,
} from "@mybase/shared";

// Same origin: the API serves the dashboard in Docker, and the dev server proxies to it.
const API_URL = "";

/** Thrown when the API answered with an error; `message` is safe to show, `body` has any extra fields. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

const signedOutListeners = new Set<() => void>();

/** Called whenever the API says the session is gone (lib/auth.ts shows the sign-in page). */
export function onSignedOut(listener: () => void) {
  signedOutListeners.add(listener);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  // A wrong password on the sign-in form is a 401 too; that one isn't a lost session.
  if (res.status === 401 && !path.startsWith("/auth/")) for (const l of signedOutListeners) l();
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, body);
  return body as T;
}

/** Encodes each segment of an object key, keeping the `/` separators. */
const keyPath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** Where the browser downloads a file from, through the API. */
export const fileUrl = (project: string, key: string) => `${API_URL}/projects/${project}/files/${keyPath(key)}`;

const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const cron = (project: string) => `/projects/${project}/cron`;
const cronJob = (project: string, job: string) => `${cron(project)}/jobs/${encodeURIComponent(job)}`;

const analytics = (project: string) => `/projects/${project}/analytics`;
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Filters for the recent-events list. */
export interface AnalyticsEventQuery {
  type?: AnalyticsEventRecord["type"];
  name?: string;
  fingerprint?: string;
  limit?: number;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
};

const cache = (project: string) => `/projects/${project}/cache`;
const cacheKey = (project: string, key: string) => `${cache(project)}/key?key=${encodeURIComponent(key)}`;
const ratelimit = (project: string) => `/projects/${project}/ratelimit`;

const db = (project: string) => `/projects/${project}/database`;
const rowsPath = (project: string, schema: string, table: string) =>
  `${db(project)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`;

export const api = {
  authStatus: () => request<AuthStatus>("/auth/me"),
  setup: (input: SetupRequest) => request<LoginResponse>("/auth/setup", sendJson("POST", input)),
  login: (input: LoginRequest) => request<LoginResponse>("/auth/login", sendJson("POST", input)),
  logout: () => request<null>("/auth/logout", { method: "POST" }),
  logoutEverywhere: () => request<null>("/auth/sessions", { method: "DELETE" }),
  changePassword: (input: ChangePasswordRequest) => request<null>("/auth/password", sendJson("PUT", input)),
  listTokens: () => request<ApiToken[]>("/auth/tokens"),
  createToken: (input: CreateApiTokenRequest) => request<CreateApiTokenResponse>("/auth/tokens", sendJson("POST", input)),
  deleteToken: (id: string) => request<null>(`/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listProjects: () => request<Project[]>("/projects"),
  createProject: (input: CreateProjectRequest) =>
    request<CreateProjectResponse>("/projects", sendJson("POST", input)),
  deleteProject: (name: string) => request<null>(`/projects/${name}`, { method: "DELETE" }),
  listFiles: (project: string, prefix: string) =>
    request<ListFilesResponse>(`/projects/${project}/files?prefix=${encodeURIComponent(prefix)}`),
  uploadFile: (project: string, key: string, file: File) =>
    request<{ key: string; size: number }>(fileUrl(project, key), {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  deleteFile: (project: string, key: string) => request<null>(fileUrl(project, key), { method: "DELETE" }),

  database: (project: string) => request<DatabaseDetails>(db(project)),
  updateDatabase: (project: string, input: UpdateDatabaseRequest) => request<DatabaseDetails>(db(project), sendJson("PATCH", input)),
  listExtensions: (project: string) => request<Extension[]>(`${db(project)}/extensions`),
  enableExtension: (project: string, name: string) =>
    request<null>(`${db(project)}/extensions/${encodeURIComponent(name)}`, { method: "PUT" }),
  disableExtension: (project: string, name: string) =>
    request<null>(`${db(project)}/extensions/${encodeURIComponent(name)}`, { method: "DELETE" }),
  listTables: (project: string) => request<TableSummary[]>(`${db(project)}/tables`),
  tableRows: (project: string, schema: string, table: string, limit: number, offset: number) =>
    request<TableRows>(`${rowsPath(project, schema, table)}?limit=${limit}&offset=${offset}`),
  insertRow: (project: string, schema: string, table: string, input: InsertRowRequest) =>
    request<null>(`${rowsPath(project, schema, table)}/rows`, sendJson("POST", input)),
  updateRow: (project: string, schema: string, table: string, input: UpdateRowRequest) =>
    request<null>(`${rowsPath(project, schema, table)}/rows`, sendJson("PATCH", input)),
  deleteRow: (project: string, schema: string, table: string, input: DeleteRowRequest) =>
    request<null>(`${rowsPath(project, schema, table)}/rows`, sendJson("DELETE", input)),
  runQuery: (project: string, sql: string) => request<QueryResponse>(`${db(project)}/query`, sendJson("POST", { sql })),

  /** Resolves to the service's credentials (shown once) for services that have any. */
  enableService: (project: string, id: ServiceId) => request<EnableServiceResponse | null>(`/projects/${project}/services/${id}`, { method: "PUT" }),
  disableService: (project: string, id: ServiceId) => request<null>(`/projects/${project}/services/${id}`, { method: "DELETE" }),

  cronOverview: (project: string) => request<CronOverview>(cron(project)),
  listCronJobs: (project: string) => request<CronJob[]>(`${cron(project)}/jobs`),
  cronJob: (project: string, job: string) => request<CronJob>(cronJob(project, job)),
  createCronJob: (project: string, input: CreateCronJobRequest) => request<CronJob>(`${cron(project)}/jobs`, sendJson("POST", input)),
  updateCronJob: (project: string, job: string, input: UpdateCronJobRequest) => request<CronJob>(cronJob(project, job), sendJson("PATCH", input)),
  deleteCronJob: (project: string, job: string) => request<null>(cronJob(project, job), { method: "DELETE" }),
  runCronJob: (project: string, job: string) => request<RunCronJobResponse>(`${cronJob(project, job)}/run`, { method: "POST" }),
  cronRuns: (project: string, job: string) => request<CronRunRecord[]>(`${cronJob(project, job)}/runs?limit=50`),
  cronSecret: (project: string) => request<CronSecret>(`${cron(project)}/secret`),
  rotateCronSecret: (project: string) => request<CronSecret>(`${cron(project)}/secret/rotate`, { method: "POST" }),
  analyticsOverview: (project: string, range: AnalyticsRange) =>
    request<AnalyticsOverview>(`${analytics(project)}${query({ range, tz: viewerTimeZone() })}`),
  analyticsEvents: (project: string, q: AnalyticsEventQuery = {}) =>
    request<AnalyticsEventRecord[]>(`${analytics(project)}/events${query({ ...q })}`),
  clearAnalytics: (project: string) => request<null>(`${analytics(project)}/events`, { method: "DELETE" }),
  analyticsSettings: (project: string) => request<AnalyticsSettings>(`${analytics(project)}/settings`),
  updateAnalyticsSettings: (project: string, input: UpdateAnalyticsSettingsRequest) =>
    request<AnalyticsSettings>(`${analytics(project)}/settings`, sendJson("PATCH", input)),
  rotateAnalyticsKey: (project: string) => request<AnalyticsSettings>(`${analytics(project)}/key/rotate`, { method: "POST" }),
  cacheOverview: (project: string) => request<CacheOverview>(cache(project)),
  rotateCachePassword: (project: string) => request<CacheCredentials>(`${cache(project)}/password/rotate`, { method: "POST" }),
  cacheKeys: (project: string, q: { cursor?: string; match?: string; count?: number } = {}) => request<CacheKeyList>(`${cache(project)}/keys${query(q)}`),
  cacheKey: (project: string, key: string) => request<CacheKeyDetail>(cacheKey(project, key)),
  putCacheKey: (project: string, key: string, input: PutCacheKeyRequest) => request<CacheKeyDetail>(cacheKey(project, key), sendJson("PUT", input)),
  setCacheKeyTtl: (project: string, key: string, ttlMs: number | null) => request<CacheKeyDetail>(cacheKey(project, key), sendJson("PATCH", { ttlMs })),
  deleteCacheKey: (project: string, key: string) => request<null>(cacheKey(project, key), { method: "DELETE" }),

  rateLimitSettings: (project: string) => request<RateLimitSettings>(ratelimit(project)),
  rotateRateLimitKey: (project: string) => request<RateLimitKey>(`${ratelimit(project)}/key/rotate`, { method: "POST" }),
  rateLimitRules: (project: string) => request<RateLimitRule[]>(`${ratelimit(project)}/rules`),
  createRateLimitRule: (project: string, input: CreateRateLimitRuleRequest) => request<RateLimitRule>(`${ratelimit(project)}/rules`, sendJson("POST", input)),
  updateRateLimitRule: (project: string, rule: string, input: UpdateRateLimitRuleRequest) =>
    request<RateLimitRule>(`${ratelimit(project)}/rules/${encodeURIComponent(rule)}`, sendJson("PATCH", input)),
  deleteRateLimitRule: (project: string, rule: string) => request<null>(`${ratelimit(project)}/rules/${encodeURIComponent(rule)}`, { method: "DELETE" }),
  rateLimitStats: (project: string, range: RateLimitStatsRange) => request<RateLimitStats>(`${ratelimit(project)}/stats?range=${range}`),
  testRateLimit: (project: string, input: Record<string, unknown>) => request<RateLimitResult>(`${ratelimit(project)}/test`, sendJson("POST", input)),
  listCronTasks: (project: string, status?: CronTaskStatus) => request<CronTask[]>(`${cron(project)}/tasks${status ? `?status=${status}` : ""}`),
  cancelCronTask: (project: string, id: string) => request<CronTask>(`${cron(project)}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

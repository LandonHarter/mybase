import type {
  CreateCronJobRequest,
  CreateProjectRequest,
  CronJob,
  CronOverview,
  CronRunRecord,
  CronSecret,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
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

const db = (project: string) => `/projects/${project}/database`;
const rowsPath = (project: string, schema: string, table: string) =>
  `${db(project)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`;

export const api = {
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

  enableService: (project: string, id: ServiceId) => request<null>(`/projects/${project}/services/${id}`, { method: "PUT" }),
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
};

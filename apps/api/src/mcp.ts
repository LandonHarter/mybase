// A remote MCP server at `/mcp` (Streamable HTTP, stateless: every POST is answered with plain
// JSON, no sessions, no server-sent events). Agents connect with an API key as Bearer token.
// Tools are thin wrappers over the REST routes, called over loopback with the caller's own
// credentials, so permissions, project limits, validation, and logging stay in one place.
// Destructive actions (deleting projects, turning services off, purging queues, keys) are
// left out on purpose: those stay with the dashboard and CLI.
import type { KeyResource } from "@mybase/shared";
import { MYBASE_VERSION, SERVICES } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { getPage, listPages, llmsTxt, renderPage, searchDocs } from "./docs";
import { allows, type Grant, type Requirement } from "./permissions";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Tool results longer than this are cut, so one big table can't flood the agent's context. */
const MAX_TEXT = 60_000;

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const INSTRUCTIONS = `mybase is a self-hosted backend: one Postgres database + S3 bucket per project, plus optional cron, queues, cache, rate limits, analytics, web search, secrets, vector search, users (Better Auth), and captcha. security_advisor and audit_events cover security.
- Start with get_project_context (or list_projects): it shows services, tables, jobs, queues, env var names, and the docs to read.
- Look things up with search_docs / read_doc before guessing APIs. Full index: ${publicApiUrl}/llms.txt
- Apps use @mybase-dev/sdk with an API key (MYBASE_API_KEY, server-side only). Secrets are shown once at creation; tell the user to store them in env, never in code, and don't repeat them needlessly.
- Secrets: you see environment and key names, never values. set_secrets writes values; apps get them with \`mybase run -- <cmd>\` or @mybase-dev/sdk/secrets.
- Deleting projects, turning services off, purging queues, and API keys are not available here; ask the user to use the dashboard or the mybase CLI.`;

type Json = Record<string, unknown>;

/** Calls a REST route as the agent. */
type Call = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

interface Tool {
  name: string;
  title: string;
  description: string;
  /** Properties of the input object; `required` lists the mandatory ones. */
  properties: Json;
  required?: string[];
  /** What the key needs for the tool to be listed. Omit for tools anyone may use. */
  need?: Requirement;
  /** The tool acts outside any one project (so a project-limited key can't use it). */
  global?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: Json, call: Call) => Promise<unknown>;
}

/** An API answer that wasn't 2xx, passed back to the agent as a tool error. */
class ToolError extends Error {}

/** A JSON-RPC error. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Json = {}) => ({ type: "integer", description, ...extra });
const project = str("Project name");
const read = (resource: KeyResource): Requirement => ({ resource, level: "read" });
const write = (resource: KeyResource): Requirement => ({ resource, level: "write" });
const p = (args: Json, key = "project") => encodeURIComponent(String(args[key]));
/** Only the listed keys of `args` that were given. */
const pick = (args: Json, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

const TOOLS: Tool[] = [
  // ---- docs (local, no API call) ----
  {
    name: "search_docs",
    title: "Search the docs",
    description: "Search mybase docs (platform, CLI, SDK). Returns the best sections with URLs; read a whole page with read_doc.",
    properties: { query: str("Words to look for, e.g. 'queue dead letter' or 'cron signature'"), limit: int("Max results (default 5)", { minimum: 1, maximum: 20 }) },
    required: ["query"],
    readOnly: true,
    run: async (args) => searchDocs(String(args.query), publicApiUrl, Number(args.limit ?? 5)),
  },
  {
    name: "read_doc",
    title: "Read a docs page",
    description: "Read one docs page as markdown. Slugs: 'quickstart', 'cli', 'queues', 'sdk/queues', … (call with slug 'index' to list them all).",
    properties: { slug: str("Page slug, e.g. 'quickstart' or 'sdk/cron-handler'") },
    required: ["slug"],
    readOnly: true,
    run: async (args) => {
      const slug = String(args.slug).replace(/\.md$/, "");
      if (slug === "index" || slug === "llms.txt") return llmsTxt(publicApiUrl);
      const page = getPage(slug);
      if (!page) throw new ToolError(`no page "${slug}". Pages: ${listPages(publicApiUrl).map((d) => d.slug).join(", ")}`);
      return renderPage(page, publicApiUrl);
    },
  },

  // ---- projects ----
  {
    name: "whoami",
    title: "Who am I",
    description: "Show what this API key may do (permissions, projects).",
    properties: {},
    readOnly: true,
    run: (_args, call) => call("GET", "/auth/me"),
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "List projects this key can see, with their database/storage details and enabled services.",
    properties: {},
    need: read("projects"),
    readOnly: true,
    run: (_args, call) => call("GET", "/projects"),
  },
  {
    name: "get_project_context",
    title: "Project context",
    description:
      "Everything about one project in one call, without secrets: enabled services, connection details, tables and columns, cron jobs, queues, rate limit rules, the env vars its apps use, and the docs to read. Call this first.",
    properties: { project },
    required: ["project"],
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/context`),
  },
  {
    name: "security_advisor",
    title: "Security advisor",
    description:
      "Run read-only security checks. With a project: its database grants, row-level security, SECURITY DEFINER functions, public files, analytics origins. Without one (admin key): the instance too (2FA, weak passwords, unused admin keys, proxy and HTTPS settings). Each finding has a fix.",
    properties: { project: str("Project name; omit for the whole instance (admin key only)") },
    readOnly: true,
    run: (args, call) => call("GET", args.project ? `/projects/${p(args)}/advisor` : "/advisor"),
  },
  {
    name: "database_public_status",
    title: "Public Postgres status",
    description:
      "Whether project databases are reachable from the internet with a normal postgres:// URL (router port forward + Let's Encrypt TLS + DDNS): host, port, certificate expiry, the address the DNS record points at, and any errors.",
    properties: {},
    need: "admin",
    global: true,
    readOnly: true,
    run: (_args, call) => call("GET", "/database/public"),
  },
  {
    name: "audit_events",
    title: "Audit log",
    description:
      "Recent audit log entries, newest first: sign-ins, API key and project changes, service toggles, secret reads (names only), SQL editor runs (no SQL text). Filter by project, action group ('auth', 'secrets', …) or action ('auth.login'), outcome, and since (ISO date).",
    properties: {
      project: str("Only this project's entries"),
      action: str("Action group (auth, mfa, token, project, service, secrets, database, storage, …) or exact action (auth.login)"),
      outcome: str("ok, denied, or failed", { enum: ["ok", "denied", "failed"] }),
      since: str("ISO date; only entries after it"),
      limit: int("Max entries (default 50)", { minimum: 1, maximum: 200 }),
    },
    need: read("audit"),
    readOnly: true,
    run: (args, call) => {
      const q = new URLSearchParams(Object.entries(pick(args, ["project", "action", "outcome", "since", "limit"])).map(([k, v]) => [k, String(v)]));
      return call("GET", `/audit?${q}`);
    },
  },
  {
    name: "create_project",
    title: "Create a project",
    description:
      "Create a project: a Postgres database + role and an S3 bucket + key. The result holds the database password and S3 secret key, shown ONCE and never stored: hand them to the user / their .env right away.",
    properties: { name: str("3–40 lowercase letters, digits, or underscores, starting with a letter") },
    required: ["name"],
    need: write("projects"),
    global: true,
    run: (args, call) => call("POST", "/projects", { name: args.name }),
  },
  {
    name: "enable_service",
    title: "Turn on a service",
    description: `Turn on an optional service for a project. Services: ${SERVICES.filter((s) => !s.core)
      .map((s) => s.id)
      .join(", ")}. The cache returns its password once.`,
    properties: { project, service: str("Service id", { enum: SERVICES.filter((s) => !s.core).map((s) => s.id) }) },
    required: ["project", "service"],
    need: write("projects"),
    run: async (args, call) => (await call("PUT", `/projects/${p(args)}/services/${p(args, "service")}`)) ?? { enabled: args.service },
  },

  // ---- database ----
  {
    name: "describe_schema",
    title: "Describe the database",
    description: "Every table and view in the project's database with its columns (type, nullable, default, primary key).",
    properties: { project },
    required: ["project"],
    need: read("database"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/database/schema`),
  },
  {
    name: "query_rows",
    title: "Read table rows",
    description: "Read rows from one table or view (as the project's role). Values come back as Postgres text.",
    properties: {
      project,
      table: str("Table name"),
      schema: str("Schema (default public)"),
      limit: int("Rows (1–500, default 50)", { minimum: 1, maximum: 500 }),
      offset: int("Rows to skip", { minimum: 0 }),
    },
    required: ["project", "table"],
    need: read("database"),
    readOnly: true,
    run: (args, call) => {
      const q = new URLSearchParams(pick(args, ["limit", "offset"]) as Record<string, string>);
      return call("GET", `/projects/${p(args)}/database/tables/${encodeURIComponent(String(args.schema ?? "public"))}/${p(args, "table")}?${q}`);
    },
  },
  {
    name: "run_sql",
    title: "Run SQL",
    description:
      "Run SQL in the project's database as the project's role, in one transaction with a 15 s timeout (DDL like CREATE TABLE works). Needs an admin key. Prefer migrations in the app's repo for schema the app depends on.",
    properties: { project, sql: str("One or more SQL statements") },
    required: ["project", "sql"],
    need: "admin",
    destructive: true,
    run: (args, call) => call("POST", `/projects/${p(args)}/database/query`, { sql: args.sql }),
  },

  // ---- storage ----
  {
    name: "list_files",
    title: "List files",
    description: "List files and folders in the project's bucket under a prefix. Objects under public/ are readable by anyone.",
    properties: { project, prefix: str("Folder prefix, e.g. 'public/images/' (default: bucket root)") },
    required: ["project"],
    need: read("storage"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/files?prefix=${encodeURIComponent(String(args.prefix ?? ""))}`),
  },

  // ---- cron ----
  {
    name: "list_cron_jobs",
    title: "List cron jobs",
    description: "Cron jobs of a project with schedule, target URL, next run, and last result.",
    properties: { project },
    required: ["project"],
    need: read("cron"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/cron/jobs`),
  },
  {
    name: "create_cron_job",
    title: "Create a cron job",
    description:
      "Create a job that POSTs a signed request to `url` on a 5-field cron schedule. Apps verify it with @mybase-dev/sdk/cron (MYBASE_CRON_SECRET). For jobs that live in the app's repo, prefer mybase.config.ts + `mybase cron sync`.",
    properties: {
      project,
      name: str("Job name"),
      schedule: str("5-field cron expression, e.g. '*/15 * * * *'"),
      url: str("Endpoint mybase calls"),
      timezone: str("IANA time zone (default UTC)"),
      payload: { description: "JSON sent as the job's payload" },
      retries: int("Retries on failure (0–3)", { minimum: 0, maximum: 3 }),
      timeoutMs: int("Per-call timeout in ms"),
      enabled: { type: "boolean", description: "false creates it paused" },
    },
    required: ["project", "name", "schedule", "url"],
    need: write("cron"),
    run: (args, call) => call("POST", `/projects/${p(args)}/cron/jobs`, pick(args, ["name", "schedule", "url", "timezone", "payload", "retries", "timeoutMs", "enabled"])),
  },
  {
    name: "run_cron_job",
    title: "Run a cron job now",
    description: "Trigger a cron job immediately. Returns the run id; see the result with list_cron_runs.",
    properties: { project, job: str("Job name") },
    required: ["project", "job"],
    need: write("cron"),
    run: (args, call) => call("POST", `/projects/${p(args)}/cron/jobs/${p(args, "job")}/run`),
  },
  {
    name: "list_cron_runs",
    title: "Cron job runs",
    description: "Recent runs of a cron job: status, HTTP status, attempts, duration, error.",
    properties: { project, job: str("Job name"), limit: int("Runs (default 20)", { minimum: 1, maximum: 100 }) },
    required: ["project", "job"],
    need: read("cron"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/cron/jobs/${p(args, "job")}/runs?limit=${Number(args.limit ?? 20)}`),
  },

  // ---- queues ----
  {
    name: "list_queues",
    title: "List queues",
    description: "Queues of a project with visible / in-flight / delayed counts and dead-letter settings.",
    properties: { project },
    required: ["project"],
    need: read("queue"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/queue/queues`),
  },
  {
    name: "create_queue",
    title: "Create a queue",
    description:
      "Create a standard or FIFO queue. Durations are strings like '30s', '5m', '4d'. Creating one that already exists with the same settings is a no-op. For queues that live in the app's repo, prefer mybase.config.ts + `mybase queue sync`.",
    properties: {
      project,
      name: str("Queue name"),
      fifo: { type: "boolean", description: "FIFO queue (ordered per group, exactly-once within 5 min dedup)" },
      visibilityTimeout: str("How long a received message stays hidden (default 30s)"),
      delay: str("Delay before new messages are visible"),
      retention: str("How long messages are kept (default 4d)"),
      receiveWait: str("Default long-poll wait, up to 20s"),
      deadLetter: {
        type: "object",
        description: "Move messages here after maxReceives receives",
        properties: { queue: str("Dead-letter queue name"), maxReceives: int("Receives before moving") },
        required: ["queue", "maxReceives"],
      },
    },
    required: ["project", "name"],
    need: write("queue"),
    run: (args, call) =>
      // The app route: the queue is recorded as created by an app (`source: "api"`), and creating
      // one that already exists with the same settings is a no-op instead of a conflict.
      call("POST", `/queue/${p(args)}/queues`, pick(args, ["name", "fifo", "visibilityTimeout", "delay", "retention", "receiveWait", "deadLetter"])),
  },
  {
    name: "send_message",
    title: "Send a queue message",
    description: "Send one message to a queue (e.g. to test a worker). FIFO queues need groupId.",
    properties: {
      project,
      queue: str("Queue name"),
      body: str("Message body (JSON as a string is fine)"),
      groupId: str("FIFO message group"),
      dedupId: str("FIFO deduplication id"),
      delayMs: int("Delay in ms"),
    },
    required: ["project", "queue", "body"],
    need: write("queue"),
    run: (args, call) =>
      call("POST", `/projects/${p(args)}/queue/queues/${p(args, "queue")}/messages`, { messages: [pick(args, ["body", "groupId", "dedupId", "delayMs"])] }),
  },
  {
    name: "peek_messages",
    title: "Peek at queue messages",
    description: "Show messages in a queue without receiving them (state, receive count, body preview).",
    properties: { project, queue: str("Queue name"), limit: int("Messages (default 20)", { minimum: 1, maximum: 100 }) },
    required: ["project", "queue"],
    need: read("queue"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/queue/queues/${p(args, "queue")}/messages?limit=${Number(args.limit ?? 20)}`),
  },

  // ---- vector search ----
  {
    name: "list_vector_indexes",
    title: "List vector indexes",
    description: "Vector/full-text indexes of a project: dimensions, metric, text search language, whether mybase embeds text, document counts. Also shows the embedding model, if one is set.",
    properties: { project },
    required: ["project"],
    need: read("vector"),
    readOnly: true,
    run: async (args, call) => ({
      settings: await call("GET", `/projects/${p(args)}/vector`),
      indexes: await call("GET", `/projects/${p(args)}/vector/indexes`),
    }),
  },
  {
    name: "create_vector_index",
    title: "Create a vector index",
    description:
      "Create an index of documents for vector, full-text, or hybrid search. Omit dimensions for a text-only index; with embed: true mybase embeds text using the project's embedding model (dimensions then default to the model's). Dimensions, metric, and language can't change later. Creating one that already exists with the same settings is a no-op. For indexes that live in the app's repo, prefer mybase.config.ts + `mybase vector sync`.",
    properties: {
      project,
      name: str("Index name: lowercase letters, digits, _"),
      dimensions: int("Vector length, 1–2000 (e.g. 1536 for text-embedding-3-small, 768 for nomic-embed-text)"),
      metric: str("Vector distance (default cosine)", { enum: ["cosine", "l2", "ip"] }),
      language: str("Text search language: english (default), simple (no stemming), french, german, …"),
      embed: { type: "boolean", description: "mybase embeds text that comes without a vector (needs an embedding model in the project's vector settings)" },
    },
    required: ["project", "name"],
    need: write("vector"),
    run: (args, call) => call("POST", `/vector/${p(args)}/indexes`, pick(args, ["name", "dimensions", "metric", "language", "embed"])),
  },
  {
    name: "upsert_vector_documents",
    title: "Upsert vector documents",
    description: "Insert or replace up to 100 documents by id (e.g. to seed or test an index). Each: { id, title?, text?, metadata?, vector? }.",
    properties: {
      project,
      index: str("Index name"),
      documents: {
        type: "array",
        description: "Documents",
        items: {
          type: "object",
          properties: { id: str("Document id"), title: str("Title"), text: str("Body text"), metadata: { type: "object" }, vector: { type: "array", items: { type: "number" } } },
          required: ["id"],
        },
      },
    },
    required: ["project", "index", "documents"],
    need: write("vector"),
    run: (args, call) => call("POST", `/projects/${p(args)}/vector/indexes/${p(args, "index")}/documents`, pick(args, ["documents"])),
  },
  {
    name: "query_vector_index",
    title: "Query a vector index",
    description: "Search an index by text (full-text, plus vector when the index embeds), by vector, or both (hybrid). Returns ids, scores, titles, metadata, and text.",
    properties: {
      project,
      index: str("Index name"),
      text: str("Query text"),
      vector: { type: "array", items: { type: "number" }, description: "Query vector" },
      mode: str("Default: hybrid when possible", { enum: ["text", "vector", "hybrid"] }),
      topK: int("Matches (default 10)", { minimum: 1, maximum: 100 }),
      filter: { type: "object", description: "Only documents whose metadata contains this object" },
    },
    required: ["project", "index"],
    need: read("vector"),
    readOnly: true,
    run: (args, call) =>
      call("POST", `/projects/${p(args)}/vector/indexes/${p(args, "index")}/query`, { ...pick(args, ["text", "vector", "mode", "topK", "filter"]), highlight: true }),
  },

  // ---- secrets (names only: no tool returns a value) ----
  {
    name: "list_secret_envs",
    title: "List secrets environments",
    description: "Environments of a project (dev, staging, prod, branch envs like dev_alice) with key counts and revisions. Values are never shown.",
    properties: { project },
    required: ["project"],
    need: read("secrets"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/secrets`),
  },
  {
    name: "list_secret_keys",
    title: "List secret names",
    description: "Key names in one environment (inherited ones marked; `managed` = project credentials from `mybase secrets link`). Values are never shown.",
    properties: { project, env: str("Environment, e.g. dev") },
    required: ["project", "env"],
    need: read("secrets"),
    readOnly: true,
    run: async (args, call) => {
      const detail = await call<{ env: unknown; secrets: { key: string; managed: boolean; inherited: boolean; updatedAt: string }[] }>(
        "GET",
        `/projects/${p(args)}/secrets/envs/${p(args, "env")}`,
      );
      return { env: detail.env, secrets: detail.secrets.map(({ key, managed, inherited, updatedAt }) => ({ key, managed, inherited, updatedAt })) };
    },
  },
  {
    name: "set_secrets",
    title: "Set secrets",
    description:
      "Set and/or remove keys in one environment, as one revision (restorable from the dashboard or `mybase secrets restore`). Only for values the user gave you or config that isn't secret.",
    properties: {
      project,
      env: str("Environment, e.g. dev"),
      set: { type: "object", description: "KEY → value", additionalProperties: { type: "string" } },
      unset: { type: "array", description: "Keys to remove", items: { type: "string" } },
      message: str("What changed, for the history"),
    },
    required: ["project", "env"],
    need: write("secrets"),
    run: (args, call) => call("PATCH", `/projects/${p(args)}/secrets/envs/${p(args, "env")}/secrets`, pick(args, ["set", "unset", "message"])),
  },
  {
    name: "create_secret_env",
    title: "Create a secrets environment",
    description: "Create an environment. With parent (a root env such as dev), it's a branch env: it inherits the parent's keys and overrides some.",
    properties: { project, name: str("Environment name, e.g. preview or dev_alice"), parent: str("Root env to branch from") },
    required: ["project", "name"],
    need: write("secrets"),
    run: (args, call) => call("POST", `/projects/${p(args)}/secrets/envs`, pick(args, ["name", "parent"])),
  },

  // ---- cache ----
  {
    name: "cache_command",
    title: "Run a cache command",
    description:
      "Run one Redis command against the project's cache, e.g. [\"GET\", \"shop:user:1\"]. Every key must start with '<project>:'. Blocking, subscribe, and cross-project commands are refused.",
    properties: { project, command: { type: "array", items: { type: ["string", "number"] }, description: "Command and arguments", minItems: 1 } },
    required: ["project", "command"],
    need: write("cache"),
    run: (args, call) => call("POST", `/cache/${p(args)}`, args.command),
  },

  // ---- rate limits ----
  {
    name: "list_ratelimit_rules",
    title: "List rate limit rules",
    description: "Named rate limit rules of a project (algorithm, limit, window).",
    properties: { project },
    required: ["project"],
    need: read("ratelimit"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/ratelimit/rules`),
  },
  {
    name: "create_ratelimit_rule",
    title: "Create a rate limit rule",
    description: "Create a named rule apps check with limiter.limit('<name>', id). For rules in the app's repo, prefer mybase.config.ts + `mybase ratelimit sync`.",
    properties: {
      project,
      name: str("Rule name"),
      limit: int("Requests allowed per window", { minimum: 1 }),
      window: str("Window, e.g. '10s', '1m', '1h'"),
      algorithm: str("sliding (default), fixed, or token", { enum: ["sliding", "fixed", "token"] }),
      burst: int("Token bucket capacity (token only)"),
    },
    required: ["project", "name", "limit", "window"],
    need: write("ratelimit"),
    run: (args, call) => call("POST", `/projects/${p(args)}/ratelimit/rules`, pick(args, ["name", "limit", "window", "algorithm", "burst"])),
  },

  // ---- analytics ----
  {
    name: "analytics_stats",
    title: "Analytics report",
    description: "Page views, visitors, top routes, referrers, countries, custom events, and errors for a project.",
    properties: { project, range: str("24h, 7d (default), 30d, or 90d", { enum: ["24h", "7d", "30d", "90d"] }) },
    required: ["project"],
    need: read("analytics"),
    readOnly: true,
    run: (args, call) => call("GET", `/projects/${p(args)}/analytics?range=${encodeURIComponent(String(args.range ?? "7d"))}&tz=UTC`),
  },
];

/** Whether the key may use `tool`, judged from its permissions (the route checks again). */
function canUse(tool: Tool, grant: Grant): boolean {
  if (!tool.need) return true;
  // A key limited to projects is judged against one of them; `global` tools need all projects.
  const project = tool.global ? null : (grant.projects?.[0] ?? null);
  if (grant.projects?.length === 0) return false;
  return allows(grant, tool.need, project);
}

const describeTool = (t: Tool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: { type: "object", properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
  annotations: { title: t.title, readOnlyHint: t.readOnly ?? false, destructiveHint: t.destructive ?? false, openWorldHint: false },
});

// ---- prompts ----------------------------------------------------------------

interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  docs: string[];
  steps: (args: Record<string, string>) => string;
}

const PROMPTS: Prompt[] = [
  {
    name: "setup_project",
    title: "Set up an app on a mybase project",
    description: "Wire this repo's app to a mybase project: env vars, database, storage, SDK.",
    arguments: [{ name: "project", description: "Project name (created if missing)", required: true }],
    docs: ["quickstart", "database", "storage"],
    steps: ({ project }) => `Set up this app to use the mybase project "${project}".
1. Call get_project_context for "${project}". If it doesn't exist, ask the user before calling create_project, then give them the credentials to put in .env (never commit them).
2. Add the env vars listed in the context to .env.example (names only) and tell the user which values they need.
3. Connect to Postgres with DATABASE_URL (or the WebSocket URL from the context for serverless hosts) and to S3 with the S3_* vars.
4. Turn on only the optional services the app needs (enable_service), then follow their docs.`,
  },
  {
    name: "add_queue_worker",
    title: "Add a queue + worker",
    description: "Create a queue and a worker in this repo that consumes it with @mybase-dev/sdk/queue.",
    arguments: [
      { name: "project", description: "Project name", required: true },
      { name: "queue", description: "Queue name", required: true },
    ],
    docs: ["queues", "sdk/queues"],
    steps: ({ project, queue }) => `Add a queue "${queue}" to project "${project}" and a worker for it.
1. get_project_context for "${project}"; if queues are off, enable_service queue.
2. Declare the queue in mybase.config.ts (defineConfig from @mybase-dev/sdk/config) with a dead-letter queue, and run \`mybase queue sync\` (or create_queue for a one-off).
3. Write the producer and the worker with createQueueClient from @mybase-dev/sdk/queue, MYBASE_API_KEY with queue:write.
4. Test with send_message and peek_messages.`,
  },
  {
    name: "add_cron_job",
    title: "Add a cron job",
    description: "Add a scheduled job: an endpoint in this repo that verifies mybase's signed call, plus the schedule.",
    arguments: [
      { name: "project", description: "Project name", required: true },
      { name: "job", description: "Job name", required: true },
    ],
    docs: ["cron", "sdk/cron-handler", "sdk/jobs-in-code"],
    steps: ({ project, job }) => `Add a cron job "${job}" to project "${project}".
1. get_project_context for "${project}"; if cron is off, enable_service cron. The app needs MYBASE_CRON_SECRET (\`mybase cron secret ${project}\`).
2. Add an endpoint that verifies and handles the call with @mybase-dev/sdk/cron.
3. Declare the job in mybase.config.ts and run \`mybase cron sync\`.
4. Trigger it with run_cron_job and check list_cron_runs.`,
  },
  {
    name: "add_analytics",
    title: "Add analytics",
    description: "Add page views, custom events, and error tracking to this app.",
    arguments: [{ name: "project", description: "Project name", required: true }],
    docs: ["analytics", "sdk/analytics"],
    steps: ({ project }) => `Add analytics for project "${project}".
1. get_project_context for "${project}"; if analytics is off, enable_service analytics. The context has the public write key.
2. Add the script tag or createAnalytics from @mybase-dev/sdk/analytics; track key actions with track() and server errors with captureError().
3. Check data with analytics_stats.`,
  },
  {
    name: "use_secrets",
    title: "Move env vars to mybase secrets",
    description: "Keep this app's env vars in mybase secrets and start it with `mybase run`.",
    arguments: [{ name: "project", description: "Project name", required: true }],
    docs: ["secrets", "sdk/secrets"],
    steps: ({ project }) => `Move this app's configuration for project "${project}" into mybase secrets.
1. get_project_context for "${project}"; if secrets are off, enable_service secrets. list_secret_envs shows dev, staging, prod.
2. List the env vars the app reads (names only) and compare with list_secret_keys. Ask the user to run \`mybase secrets upload .env -p ${project} -e dev\` for real values; don't copy secrets through this chat.
3. Tell the user to run \`mybase secrets setup -p ${project} -e dev\` once in this repo, then change the dev script to \`mybase run -- <command>\`.
4. For production, suggest an API key limited to the project and the prod env (secrets:read), and \`mybase run\` (or createSecretsClient) in the deploy.`,
  },
];

function getPrompt(name: string, args: Record<string, string>) {
  const prompt = PROMPTS.find((pr) => pr.name === name);
  if (!prompt) throw new RpcError(-32602, `unknown prompt "${name}"`);
  for (const a of prompt.arguments) if (a.required && !args[a.name]) throw new RpcError(-32602, `missing argument "${a.name}"`);
  const docs = prompt.docs.flatMap((slug) => {
    const page = getPage(slug);
    return page ? [`<doc url="${publicApiUrl}/docs/${slug}.md">\n${renderPage(page, publicApiUrl)}\n</doc>`] : [];
  });
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: `${prompt.steps(args)}\n\nReference docs:\n\n${docs.join("\n\n")}` } }],
  };
}

// ---- JSON-RPC ---------------------------------------------------------------

export interface McpContext {
  grant: Grant;
  /** Headers that carry the caller's credentials, forwarded on every REST call. */
  credentials: Headers;
  /** Where this API listens, for loopback calls. */
  port: number;
  log: Logger;
}

function caller(ctx: McpContext): Call {
  return async (method, path, body) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const name of ["authorization", "cookie"]) {
      const value = ctx.credentials.get(name);
      if (value) headers.set(name, value);
    }
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return undefined as never;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ToolError(`${res.status}: ${(data as { error?: string } | null)?.error ?? res.statusText}`);
    return data as never;
  };
}

function checkArgs(tool: Tool, args: Json) {
  for (const name of tool.required ?? []) {
    if (args[name] === undefined || args[name] === null || args[name] === "") throw new RpcError(-32602, `${tool.name}: missing "${name}"`);
  }
  const unknown = Object.keys(args).filter((k) => !(k in tool.properties));
  if (unknown.length) throw new RpcError(-32602, `${tool.name}: unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
}

async function callTool(params: Json, ctx: McpContext) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool || !canUse(tool, ctx.grant)) throw new RpcError(-32602, `unknown tool "${String(params.name)}"`);
  const args = (params.arguments ?? {}) as Json;
  checkArgs(tool, args);
  const fields = { tool: tool.name, project: typeof args.project === "string" ? args.project : undefined };
  try {
    const result = await tool.run(args, caller(ctx));
    ctx.log.info("tool call", { ...fields, ok: true });
    let text = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true }, null, 2);
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters; ask for less, e.g. a smaller limit)`;
    return { content: [{ type: "text", text }], isError: false };
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    ctx.log.warn("tool call failed", { ...fields, ok: false });
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
}

async function dispatch(method: string, params: Json, ctx: McpContext): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "mybase", title: "mybase", version: MYBASE_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.filter((t) => canUse(t, ctx.grant)).map(describeTool) };
    case "tools/call":
      return callTool(params, ctx);
    case "resources/list":
      return {
        resources: listPages(publicApiUrl).map((d) => ({ uri: `mybase://docs/${d.slug}`, name: d.slug, title: d.title, description: d.summary, mimeType: "text/markdown" })),
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      const uri = String(params.uri ?? "");
      const page = uri.startsWith("mybase://docs/") ? getPage(uri.slice("mybase://docs/".length)) : null;
      if (!page) throw new RpcError(-32002, `resource not found: ${uri}`);
      return { contents: [{ uri, mimeType: "text/markdown", text: renderPage(page, publicApiUrl) }] };
    }
    case "prompts/list":
      return { prompts: PROMPTS.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a })) };
    case "prompts/get":
      return getPrompt(String(params.name), (params.arguments ?? {}) as Record<string, string>);
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

/** One message's answer, or null for a notification (or a client's response). */
async function answer(msg: RpcMessage, ctx: McpContext): Promise<Json | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isRequest ? { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request" } } : null;
  }
  if (!isRequest) return null;
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await dispatch(msg.method, msg.params ?? {}, ctx) };
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: "2.0", id: msg.id, error: { code: err.code, message: err.message } };
    ctx.log.error("mcp request failed", { method: msg.method, err });
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "internal error" } };
  }
}

/** POST /mcp: one JSON-RPC message (or a batch). Notifications get 202 with no body. */
export async function handleMcp(req: Request, ctx: McpContext): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcMessage[];
  const answers = (await Promise.all(messages.map((m) => answer(m, ctx)))).filter((a) => a !== null);
  if (answers.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? answers : answers[0]);
}

export const toolNames = () => TOOLS.map((t) => t.name);
/** For tests: the tools a grant would see. */
export const visibleTools = (grant: Grant) => TOOLS.filter((t) => canUse(t, grant)).map((t) => t.name);

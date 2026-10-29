// One project at a glance for agents and `mybase context`: services, connection details, tables,
// jobs, queues, rules, env var names, and the docs worth reading. Never secrets. Each section
// is there only when the caller's key may read that service.
import type { KeyResource, ProjectContext, ServiceId } from "@mybase/shared";
import * as analytics from "./analytics";
import { cacheInfo } from "./cache";
import * as cron from "./cron";
import { allPages } from "./docs";
import { NotFoundError } from "./errors";
import { allows, type Grant } from "./permissions";
import { listProjects } from "./projects";
import * as queue from "./queue";
import * as ratelimit from "./ratelimit";
import { secretsContext } from "./secrets";
import { schemaOverview } from "./tables";
import { usersContext } from "./users";
import { vectorContext } from "./vector";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Docs to read first, per service (slugs in docs/ and packages/sdk/docs/). */
const SERVICE_DOCS: Record<"database" | "storage" | ServiceId, string[]> = {
  database: ["database"],
  storage: ["storage"],
  cron: ["cron", "sdk/cron-handler", "sdk/jobs-in-code"],
  analytics: ["analytics", "sdk/analytics"],
  cache: ["cache", "sdk/cache"],
  ratelimit: ["rate-limits", "sdk/rate-limits"],
  queue: ["queues", "sdk/queues"],
  search: ["web-search", "sdk/search"],
  secrets: ["secrets", "sdk/secrets"],
  vector: ["vector", "sdk/vector"],
  users: ["users", "sdk/better-auth"],
  captcha: ["captcha", "sdk/captcha"],
  realtime: ["realtime", "sdk/realtime"],
  sandbox: ["sandboxes", "sdk/sandboxes"],
};

export async function projectContext(name: string, grant: Grant): Promise<ProjectContext> {
  const project = (await listProjects()).find((p) => p.name === name);
  if (!project) throw new NotFoundError(`project "${name}" not found`);
  const on = new Set<string>(project.services);
  const can = (resource: KeyResource) => allows(grant, { resource, level: "read" }, name);

  const [tables, jobs, queues, rules, cache, analyticsSettings, secrets, vector, appUsers] = await Promise.all([
    can("database") ? schemaOverview(name) : null,
    on.has("cron") && can("cron") ? cron.listJobs(name) : null,
    on.has("queue") && can("queue") ? queue.listQueues(name) : null,
    on.has("ratelimit") && can("ratelimit") ? ratelimit.listRules(name) : null,
    on.has("cache") && can("cache") ? cacheInfo(name) : null,
    on.has("analytics") && can("analytics") ? analytics.getSettings(name) : null,
    on.has("secrets") && can("secrets") ? secretsContext(name, grant) : null,
    on.has("vector") && can("vector") ? vectorContext(name) : null,
    on.has("users") && can("users") ? usersContext(name) : null,
  ]);

  const env: ProjectContext["env"] = [
    { name: "DATABASE_URL", description: on.has("secrets") ? "Postgres connection string (shown once at creation, or kept in a secrets env by mybase secrets link)" : "Postgres connection string (password shown once at project creation)" },
  ];
  if (project.storage) {
    env.push(
      { name: "S3_ENDPOINT", description: project.storage.endpoint },
      { name: "S3_REGION", description: project.storage.region },
      { name: "S3_BUCKET", description: project.storage.bucket },
      { name: "S3_ACCESS_KEY_ID", description: "shown once at project creation" },
      { name: "S3_SECRET_ACCESS_KEY", description: "shown once at project creation" },
    );
  }
  if (["cron", "queue", "cache", "ratelimit", "search", "vector", "users", "captcha", "realtime", "sandbox"].some((s) => on.has(s))) {
    env.push({ name: "MYBASE_API_KEY", description: `API key limited to "${name}" (mybase token create … --project ${name}); server-side only` });
  }
  if (on.has("cron")) env.push({ name: "MYBASE_CRON_SECRET", description: "verifies cron calls (mybase cron secret <project>)" });
  if (on.has("cache")) {
    const local = ["localhost", "127.0.0.1", "::1"].includes(process.env.MYBASE_CACHE_PUBLIC_HOST ?? "localhost");
    env.push({
      name: "REDIS_URL",
      description: local
        ? "TCP cache URL with password; points at localhost, so it only works on the server itself. Elsewhere use HTTP (MYBASE_URL + MYBASE_API_KEY)"
        : "TCP cache URL with password (LAN/Tailscale only; from the internet use HTTP: MYBASE_URL + MYBASE_API_KEY)",
    });
  }
  if (on.has("users")) env.push({ name: "BETTER_AUTH_SECRET", description: "Better Auth's signing secret: 32+ random bytes (mybase users init can store one in secrets)" });
  if (on.has("captcha")) env.push({ name: "MYBASE_CAPTCHA_SECRET", description: "checks captcha tokens server-side (mybase captcha key <project>)" });
  if (on.has("realtime")) env.push({ name: "MYBASE_REALTIME_SECRET", description: "signs browser tokens and verifies realtime webhooks (mybase realtime key <project>); server-side only" });
  if (on.has("secrets")) {
    env.push({ name: "MYBASE_ENV", description: `secrets environment for mybase run (or: mybase secrets setup -p ${name} -e <env>)` });
  }

  const slugs = ["quickstart", ...SERVICE_DOCS.database, ...SERVICE_DOCS.storage, ...project.services.flatMap((s) => SERVICE_DOCS[s] ?? [])];
  const docs = slugs.flatMap((slug) => {
    const page = allPages().find((p) => p.slug === slug);
    return page ? [{ slug, title: page.title, url: `${publicApiUrl}/docs/${slug}.md` }] : [];
  });

  return {
    project: name,
    createdAt: project.createdAt,
    apiUrl: publicApiUrl,
    docsUrl: `${publicApiUrl}/llms.txt`,
    services: project.services,
    ...(tables ? { database: { ...project.database, tables } } : {}),
    ...(can("storage") ? { storage: project.storage } : {}),
    ...(jobs
      ? {
          cron: {
            jobs: jobs.map(({ name, schedule, timezone, url, enabled, source, nextRunAt, lastRun }) => ({ name, schedule, timezone, url, enabled, source, nextRunAt, lastRun })),
          },
        }
      : {}),
    ...(queues ? { queue: { queues: queues.map(({ name, fifo, counts, deadLetter, source }) => ({ name, fifo, counts, deadLetter, source })) } } : {}),
    ...(rules ? { ratelimit: { rules: rules.map(({ name, algorithm, limit, windowMs, burst, source }) => ({ name, algorithm, limit, windowMs, burst, source })) } } : {}),
    ...(cache ? { cache: { url: cache.url, httpUrl: cache.httpUrl, keyPrefix: cache.keyPrefix } } : {}),
    ...(on.has("search") && can("search")
      ? { search: { searchUrl: `${publicApiUrl}/search/${name}`, fetchUrl: `${publicApiUrl}/search/${name}/fetch` } }
      : {}),
    ...(secrets ? { secrets } : {}),
    ...(vector ? { vector } : {}),
    ...(appUsers ? { users: appUsers } : {}),
    ...(on.has("captcha") && can("captcha")
      ? { captcha: { challengeUrl: `${publicApiUrl}/captcha/${name}/challenge`, scriptUrl: `${publicApiUrl}/captcha.js`, siteVerifyUrl: `${publicApiUrl}/captcha/${name}/siteverify` } }
      : {}),
    ...(on.has("realtime") && can("realtime")
      ? { realtime: { socketUrl: `${publicApiUrl.replace(/^http/, "ws")}/realtime/${name}`, publishUrl: `${publicApiUrl}/realtime/${name}/publish` } }
      : {}),
    ...(on.has("sandbox") && can("sandbox")
      ? { sandbox: { apiUrl: `${publicApiUrl}/sandbox/${name}`, profile: "browser" as const } }
      : {}),
    ...(analyticsSettings ? { analytics: { writeKey: analyticsSettings.writeKey, scriptUrl: analyticsSettings.scriptUrl, ingestUrl: analyticsSettings.ingestUrl } } : {}),
    env,
    docs,
  };
}

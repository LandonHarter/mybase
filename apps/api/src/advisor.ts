// The security advisor: read-only checks for common mistakes, instance-wide and per project.
// Facts are gathered first (env, catalog queries), then pure functions turn them into findings,
// so every rule is testable without a database (advisor.test.ts). Nothing here writes anything.
// Never put secret values in a finding: checks only say *that* something is weak.
import type { AdvisorFinding, AdvisorReport, ApiToken, ServiceId } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { listTokens } from "./auth";
import { isPrivateIp, proxySeen } from "./auth-http";
import { mfaEnabled } from "./auth-mfa";
import { listProjects, sql } from "./postgres";
import { projectSql } from "./project-db";
import { secretsMaster } from "./secrets";
import { listFiles } from "./storage";
import { PUBLIC_PREFIX } from "@mybase/shared";

const DAY = 86_400_000;
const STALE_DAYS = 90;
/** Placeholders from .env.example and the docs; real deployments must replace them. */
const PLACEHOLDERS = new Set(["change-me", "changeme", "password", "postgres", "mybase", "secret", "admin"]);
/** Each check gets this long before it's reported as failed. */
const CHECK_TIMEOUT_MS = 5000;

/** Every check id, for the report's `checks` list and the docs. */
export const INSTANCE_CHECKS = [
  "admin-no-2fa",
  "secrets-key-unset",
  "secrets-key-old-set",
  "admin-password-in-env",
  "weak-service-secret",
  "tunnel-no-trust-proxy",
  "public-url-http",
  "admin-token-stale",
  "token-unused",
  "control-schema-public",
] as const;

export const PROJECT_CHECKS = [
  "database-public-connect",
  "role-privileged",
  "public-schema-create",
  "grants-to-public",
  "rls-not-forced",
  "tables-no-rls",
  "definer-no-search-path",
  "public-files",
  "analytics-any-origin",
  "users-not-migrated",
] as const;

// ---- instance --------------------------------------------------------------

export interface InstanceFacts {
  env: Record<string, string | undefined>;
  mfaEnabled: boolean;
  secretsKeySet: boolean;
  /** Projects with the secrets service on. */
  secretsProjects: number;
  tokens: ApiToken[];
  untrustedCloudflare: boolean;
  /** PUBLIC (any role, so any project) has USAGE on the `mybase` schema. */
  controlSchemaPublic: boolean;
  now: number;
}

const finding = (f: Omit<AdvisorFinding, "project"> & { project?: string | null }): AdvisorFinding => ({ project: null, ...f });

const ageDays = (iso: string | null, now: number) => (iso ? (now - Date.parse(iso)) / DAY : Infinity);

/** Whether a secret from the environment is too weak to keep. Only its shape is looked at. */
export function weakSecret(value: string | undefined): boolean {
  if (!value) return false;
  return value.length < 16 || PLACEHOLDERS.has(value.toLowerCase());
}

/** A public URL served over plain http to the internet (not localhost, a LAN, or Tailscale). */
export function insecurePublicUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !isPrivateIp(host);
  return !(host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".ts.net") || !host.includes("."));
}

export function instanceFindings(f: InstanceFacts): AdvisorFinding[] {
  const out: AdvisorFinding[] = [];
  const { env, now } = f;

  if (!f.mfaEnabled) {
    out.push(
      finding({
        id: "admin-no-2fa",
        severity: "warn",
        title: "Two-factor authentication is off",
        detail: "The admin account signs in with a password alone. Anyone who learns it controls every project.",
        fix: "Turn on two-factor authentication in Settings → Account.",
        docs: "security",
      }),
    );
  }
  if (!f.secretsKeySet) {
    out.push(
      finding({
        id: "secrets-key-unset",
        severity: f.secretsProjects > 0 ? "critical" : "info",
        title: "MYBASE_SECRETS_KEY isn't set",
        detail:
          f.secretsProjects > 0
            ? `${f.secretsProjects} project(s) use the secrets service, which can't read or write values without it.`
            : "Without it the secrets service is off, and the 2FA secret and embedding API keys are stored unencrypted.",
        fix: "Set MYBASE_SECRETS_KEY to 32 random bytes (openssl rand -base64 32) in .env, back it up somewhere other than your database backups, and restart.",
        docs: "secrets",
      }),
    );
  }
  if (env.MYBASE_SECRETS_KEY_OLD) {
    out.push(
      finding({
        id: "secrets-key-old-set",
        severity: "info",
        title: "MYBASE_SECRETS_KEY_OLD is still set",
        detail: "The old master key is only needed for one restart, to re-wrap data keys. Keeping it around keeps it exposed.",
        fix: "Remove MYBASE_SECRETS_KEY_OLD from .env and restart.",
        docs: "secrets",
      }),
    );
  }
  if (env.MYBASE_ADMIN_PASSWORD) {
    out.push(
      finding({
        id: "admin-password-in-env",
        severity: "info",
        title: "MYBASE_ADMIN_PASSWORD is still in the environment",
        detail: "It's only used to create the admin on first boot. Left in .env, it's a copy of a password that may no longer be current, readable by anyone with the file.",
        fix: "Remove MYBASE_ADMIN_PASSWORD from .env and restart.",
        docs: "self-hosting",
      }),
    );
  }
  const weak = ["POSTGRES_PASSWORD", "VALKEY_PASSWORD", "GARAGE_ADMIN_TOKEN"].filter((name) => weakSecret(env[name]));
  if (weak.length) {
    out.push(
      finding({
        id: "weak-service-secret",
        severity: "critical",
        title: "Weak service passwords",
        detail: `${weak.join(", ")} ${weak.length === 1 ? "is" : "are"} shorter than 16 characters or a placeholder value.`,
        fix: "Generate new values (openssl rand -hex 32), update .env and the services that use them, and restart.",
        docs: "self-hosting",
      }),
    );
  }
  if (f.untrustedCloudflare) {
    out.push(
      finding({
        id: "tunnel-no-trust-proxy",
        severity: "warn",
        title: "Requests arrive through Cloudflare, but the API doesn't trust it",
        detail: "Every request looks like it comes from the tunnel, so sign-in throttling and rate limits treat all visitors as one IP, and cookies may miss the Secure flag.",
        fix: "Set MYBASE_TRUST_PROXY=cloudflare in .env and restart. Only do this when the API is reachable through the tunnel alone.",
        docs: "self-hosting",
      }),
    );
  }
  if (insecurePublicUrl(env.MYBASE_PUBLIC_URL)) {
    out.push(
      finding({
        id: "public-url-http",
        severity: "warn",
        title: "The public URL uses plain HTTP",
        detail: "Passwords, session cookies, and API keys sent to it cross the internet unencrypted.",
        fix: "Serve mybase over HTTPS (the Cloudflare Tunnel does this) and set MYBASE_PUBLIC_URL to the https:// address.",
        docs: "self-hosting",
      }),
    );
  }
  const staleAdmin = f.tokens.filter((t) => t.permissions.includes("admin") && ageDays(t.createdAt, now) > STALE_DAYS && ageDays(t.lastUsedAt, now) > STALE_DAYS);
  if (staleAdmin.length) {
    out.push(
      finding({
        id: "admin-token-stale",
        severity: "warn",
        title: "Unused admin API keys",
        detail: `${staleAdmin.map((t) => `"${t.name}"`).join(", ")}: full admin access, unused for ${STALE_DAYS}+ days.`,
        fix: "Delete keys you no longer use in Settings → API keys, or replace them with keys limited to the permissions they need.",
        docs: "security",
      }),
    );
  }
  const unused = f.tokens.filter((t) => !t.permissions.includes("admin") && ageDays(t.createdAt, now) > STALE_DAYS && ageDays(t.lastUsedAt, now) > STALE_DAYS);
  if (unused.length) {
    out.push(
      finding({
        id: "token-unused",
        severity: "info",
        title: "Unused API keys",
        detail: `${unused.map((t) => `"${t.name}"`).join(", ")}: unused for ${STALE_DAYS}+ days.`,
        fix: "Delete keys you no longer use in Settings → API keys.",
        docs: "security",
      }),
    );
  }
  if (f.controlSchemaPublic) {
    out.push(
      finding({
        id: "control-schema-public",
        severity: "critical",
        title: "Project roles can read mybase's own tables",
        detail: "PUBLIC has USAGE on the mybase schema in the postgres database, so any project's database user may read API key hashes, cron secrets, and sessions.",
        fix: "Run in the postgres database as superuser: revoke all on schema mybase from public;",
        docs: "security",
      }),
    );
  }
  return out;
}

// ---- projects --------------------------------------------------------------

export interface ProjectFacts {
  project: string;
  services: ServiceId[];
  /** PUBLIC may connect to the project's database (any project's role could). */
  publicConnect: boolean;
  /** The project role has superuser, createrole, createdb, replication, or bypassrls. */
  privilegedRole: string[];
  publicSchemaCreate: boolean;
  /** `schema.table` with a privilege granted to PUBLIC. */
  publicGrants: string[];
  /** `schema.table` with RLS enabled but not forced (the owner, which apps connect as, skips it). */
  rlsNotForced: string[];
  /** `schema.table` without RLS. */
  noRls: string[];
  /** `schema.function` with SECURITY DEFINER and no fixed search_path. */
  definerNoSearchPath: string[];
  /** Something is stored under `public/`. */
  publicFiles: boolean;
  /** Analytics is on and accepts events from any origin. */
  analyticsAnyOrigin: boolean;
  /** Users is on but Better Auth's `user` table isn't there yet. */
  usersNotMigrated?: boolean;
}

const list = (items: string[], max = 5) => items.slice(0, max).join(", ") + (items.length > max ? `, and ${items.length - max} more` : "");

export function projectFindings(f: ProjectFacts): AdvisorFinding[] {
  const out: AdvisorFinding[] = [];
  const project = f.project;
  if (f.publicConnect) {
    out.push(
      finding({
        project,
        id: "database-public-connect",
        severity: "critical",
        title: "Other projects can connect to this database",
        detail: "PUBLIC has CONNECT on the database, so every project's database user can open it.",
        fix: `Run as superuser: revoke all on database "${project}" from public;`,
        docs: "security",
      }),
    );
  }
  if (f.privilegedRole.length) {
    out.push(
      finding({
        project,
        id: "role-privileged",
        severity: "critical",
        title: "The project's database user has extra privileges",
        detail: `The role "${project}" has ${f.privilegedRole.join(", ")}. With them, an app (or anyone with its connection string) can reach other projects.`,
        fix: `Run as superuser: alter role "${project}" ${f.privilegedRole.map((p) => `no${p}`).join(" ")};`,
        docs: "security",
      }),
    );
  }
  if (f.publicSchemaCreate) {
    out.push(
      finding({
        project,
        id: "public-schema-create",
        severity: "warn",
        title: "Anyone who can connect may create objects in the public schema",
        detail: "A role with CREATE on public can plant functions or tables that shadow yours (a classic search_path attack).",
        fix: "Run in the project's database: revoke create on schema public from public;",
        docs: "security",
      }),
    );
  }
  if (f.publicGrants.length) {
    out.push(
      finding({
        project,
        id: "grants-to-public",
        severity: "warn",
        title: "Tables are granted to PUBLIC",
        detail: `${list(f.publicGrants)} grant privileges to every role, not just this project's.`,
        fix: "Revoke them, e.g. revoke all on <table> from public; and grant to specific roles instead.",
        docs: "security",
      }),
    );
  }
  if (f.rlsNotForced.length) {
    out.push(
      finding({
        project,
        id: "rls-not-forced",
        severity: "warn",
        title: "Row-level security is on but skipped by your app",
        detail: `${list(f.rlsNotForced)} have RLS enabled but not forced. Apps connect as the table owner, and owners skip RLS unless it's forced, so the policies never apply.`,
        fix: "Run alter table <table> force row level security; for each one.",
        docs: "database",
      }),
    );
  }
  if (f.noRls.length && f.services.includes("users")) {
    out.push(
      finding({
        project,
        id: "tables-no-rls",
        severity: "info",
        title: "Tables without row-level security",
        detail: `${list(f.noRls)} have no RLS. With app sign-in on, any bug in a query can show one user another user's rows.`,
        fix: "Enable and force RLS with a policy on mybase_auth.uid(), or make sure every query filters by user.",
        docs: "users",
      }),
    );
  }
  if (f.definerNoSearchPath.length) {
    out.push(
      finding({
        project,
        id: "definer-no-search-path",
        severity: "warn",
        title: "SECURITY DEFINER functions without a fixed search_path",
        detail: `${list(f.definerNoSearchPath)} run with their owner's rights but resolve names through the caller's search_path, which the caller can change.`,
        fix: "Add set search_path = pg_catalog, <schema> to each function (alter function … set search_path = …).",
        docs: "database",
      }),
    );
  }
  if (f.publicFiles) {
    out.push(
      finding({
        project,
        id: "public-files",
        severity: "info",
        title: "Files under public/ are readable by anyone",
        detail: "Anything stored under public/ can be downloaded without credentials. Make sure that's only what you meant to share.",
        fix: "Move private files out of public/ (Storage page), and don't let users upload straight into it.",
        docs: "storage",
      }),
    );
  }
  if (f.usersNotMigrated) {
    out.push(
      finding({
        project,
        id: "users-not-migrated",
        severity: "info",
        title: "Better Auth's tables aren't there yet",
        detail: "The users service is on, but the auth schema has no user table, so nobody can sign in to the app yet.",
        fix: "Run Better Auth's migrations from your app with the auth database URL (npx @better-auth/cli migrate).",
        docs: "users",
      }),
    );
  }
  if (f.analyticsAnyOrigin) {
    out.push(
      finding({
        project,
        id: "analytics-any-origin",
        severity: "info",
        title: "Analytics accepts events from any site",
        detail: "The write key is public, so any site can send events and skew your numbers.",
        fix: "Add your site's origins under Analytics → Setup → Allowed origins.",
        docs: "analytics",
      }),
    );
  }
  return out;
}

// ---- gathering facts -------------------------------------------------------

async function instanceFacts(): Promise<InstanceFacts> {
  const [mfa, tokens, projects, schema] = await Promise.all([
    mfaEnabled(),
    listTokens(),
    listProjects(),
    sql`select has_schema_privilege('public', 'mybase', 'USAGE') as usage`,
  ]);
  return {
    env: process.env,
    mfaEnabled: mfa,
    secretsKeySet: secretsMaster() !== null,
    secretsProjects: projects.filter((p) => p.services.includes("secrets")).length,
    tokens,
    untrustedCloudflare: proxySeen.untrustedCloudflare,
    controlSchemaPublic: Boolean((schema as { usage: boolean }[])[0]?.usage),
    now: Date.now(),
  };
}

// System schemas and the ones mybase services own (vector indexes, Better Auth's tables).
// A constant, so it's spliced into the SQL as a literal list.
const SKIP_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast', 'mybase_vector', 'mybase_auth', 'auth')";

async function projectFacts(project: string, services: ServiceId[]): Promise<ProjectFacts> {
  const db = projectSql(project);
  const [[database], [role], [schema], grants, rls, definers, files, analytics, authTable] = await Promise.all([
    sql`select has_database_privilege('public', ${project}, 'CONNECT') as connect` as Promise<{ connect: boolean }[]>,
    sql`select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = ${project}` as Promise<Record<string, boolean>[]>,
    db`select has_schema_privilege('public', 'public', 'CREATE') as create` as Promise<{ create: boolean }[]>,
    db`
      select distinct n.nspname || '.' || c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
      where c.relkind in ('r', 'v', 'm', 'p') and a.grantee = 0
        and n.nspname not in ${db.unsafe(SKIP_SCHEMAS)} and n.nspname not like 'pg_temp%'
      order by 1` as Promise<{ name: string }[]>,
    db`
      select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname not in ${db.unsafe(SKIP_SCHEMAS)} and n.nspname not like 'pg_temp%'
        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      order by 1` as Promise<{ name: string; enabled: boolean; forced: boolean }[]>,
    db`
      select n.nspname || '.' || p.proname as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ${db.unsafe(SKIP_SCHEMAS)}
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and not coalesce(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false)
      order by 1` as Promise<{ name: string }[]>,
    listFiles(project, PUBLIC_PREFIX).catch(() => null),
    services.includes("analytics")
      ? (sql`select cardinality(allowed_origins) = 0 as open from mybase.analytics_projects where project = ${project}` as Promise<{ open: boolean }[]>)
      : Promise.resolve([]),
    services.includes("users") ? (db`select to_regclass('auth.user') is not null as present` as Promise<{ present: boolean }[]>) : Promise.resolve(null),
  ]);
  const flags: [string, string][] = [
    ["rolsuper", "superuser"],
    ["rolcreaterole", "createrole"],
    ["rolcreatedb", "createdb"],
    ["rolreplication", "replication"],
    ["rolbypassrls", "bypassrls"],
  ];
  return {
    project,
    services,
    publicConnect: Boolean(database?.connect),
    privilegedRole: role ? flags.filter(([column]) => role[column]).map(([, name]) => name) : [],
    publicSchemaCreate: Boolean(schema?.create),
    publicGrants: grants.map((g) => g.name),
    rlsNotForced: rls.filter((t) => t.enabled && !t.forced).map((t) => t.name),
    noRls: rls.filter((t) => !t.enabled).map((t) => t.name),
    definerNoSearchPath: definers.map((d) => d.name),
    publicFiles: Boolean(files && (files.files.length > 0 || files.folders.length > 0)),
    analyticsAnyOrigin: Boolean(analytics[0]?.open),
    usersNotMigrated: authTable ? !authTable[0]?.present : false,
  };
}

/** Runs `fn` with a timeout; a failure becomes an info finding instead of failing the report. */
async function guarded(label: string, project: string | null, fn: () => Promise<AdvisorFinding[]>, log: Logger): Promise<AdvisorFinding[]> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log.warn("advisor check failed", { checks: label, project, err });
    return [
      finding({
        project,
        id: "check-failed",
        severity: "info",
        title: `Some checks couldn't run (${label})`,
        detail: (err as Error).message,
        fix: "Check that Postgres and storage are up, then run the advisor again. The API log has details.",
      }),
    ];
  } finally {
    clearTimeout(timer);
  }
}

const SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 } as const;
const sorted = (findings: AdvisorFinding[]) =>
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.project ?? "").localeCompare(b.project ?? "") || a.id.localeCompare(b.id));

/** One project's findings. `project` must exist. */
export async function projectReport(project: string, log: Logger): Promise<AdvisorReport> {
  const record = (await listProjects()).find((p) => p.name === project);
  const findings = await guarded("project", project, async () => projectFindings(await projectFacts(project, record?.services ?? [])), log);
  return { checkedAt: new Date().toISOString(), findings: sorted(findings), checks: [...PROJECT_CHECKS] };
}

/** Instance findings plus every visible project's. `canSee` filters projects for limited keys. */
export async function fullReport(log: Logger, canSee: (project: string) => boolean = () => true): Promise<AdvisorReport> {
  const projects = (await listProjects()).filter((p) => canSee(p.name));
  const parts = await Promise.all([
    guarded("instance", null, async () => instanceFindings(await instanceFacts()), log),
    ...projects.map((p) => guarded("project", p.name, async () => projectFindings(await projectFacts(p.name, p.services)), log)),
  ]);
  return { checkedAt: new Date().toISOString(), findings: sorted(parts.flat()), checks: [...INSTANCE_CHECKS, ...PROJECT_CHECKS] };
}

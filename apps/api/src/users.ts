// The users service: sign-in for a project's own app users, done by Better Auth inside the app.
// mybase doesn't run auth itself. It gives Better Auth a schema (`auth`) in the project's
// database, the cache for sessions (@mybase-dev/sdk/better-auth), an RLS helper
// (`mybase_auth.uid()`), sign-in events in the audit log, and a dashboard view of the users.
//
// Better Auth owns the tables and their migrations, and plugins add columns, so every read
// here looks the columns up first (camelCase by default, snake_case if the app mapped them).
// Reads and edits run on the superuser pool (`projectSql`); identifiers come from the catalog.
import type { AppSession, AppUser, AppUserDetail, AppUserList, UsersOverview } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { AUTH_SCHEMA } from "@mybase-dev/sdk/better-auth";
import { audit } from "./audit";
import { BadRequestError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import { projectSql, quoteIdent } from "./project-db";
import type { ServiceModule } from "./services";
import { send, unlinkMatching } from "./valkey";

const HELPER_SCHEMA = "mybase_auth";
const MAX_EVENTS = 20;
const publicApiUrl = () => (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Where the SDK's secondary storage keeps a session (`<project>:auth:<token>`). */
const sessionKey = (project: string, token: string) => `${project}:auth:${token}`;

export const usersService: ServiceModule = {
  id: "users",
  async enable(project, log) {
    const role = quoteIdent(project);
    // The app's role owns `auth`, so Better Auth's migrations (run by the app) can create tables there.
    await projectSql(project).unsafe(`
      create schema if not exists ${AUTH_SCHEMA} authorization ${role};
      create schema if not exists ${HELPER_SCHEMA};
      create or replace function ${HELPER_SCHEMA}.uid() returns text language sql stable
        as $$ select nullif(current_setting('mybase.user_id', true), '') $$;
      grant usage on schema ${HELPER_SCHEMA} to ${role};
      grant execute on function ${HELPER_SCHEMA}.uid() to ${role};`);
    await sql`insert into mybase.users_projects (project) values (${project}) on conflict do nothing`;
    enabled.add(project);
    log.info("users enabled");
  },
  async disable(project, log) {
    // Accounts first: if this fails, the service stays on and disabling can be retried.
    await projectSql(project).unsafe(`drop schema if exists ${AUTH_SCHEMA} cascade; drop schema if exists ${HELPER_SCHEMA} cascade`);
    await sql`delete from mybase.users_projects where project = ${project}`;
    enabled.delete(project);
    const cleared = await unlinkMatching(`${project}:auth:*`).catch(() => 0);
    log.info("users disabled", { cleared });
  },
};

const enabled = new Set<string>();

export async function requireEnabled(project: string) {
  if (enabled.has(project)) return;
  const rows = await sql`select 1 from mybase.users_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("users is not enabled for this project");
  enabled.add(project);
}

// ---- Better Auth's tables -----------------------------------------------------

type Table = "user" | "session" | "account";

/** Logical field → the column names Better Auth may have used for it. */
const FIELDS: Record<Table, Record<string, string[]>> = {
  user: {
    id: ["id"],
    name: ["name"],
    email: ["email"],
    emailVerified: ["emailVerified", "email_verified"],
    image: ["image"],
    createdAt: ["createdAt", "created_at"],
    banned: ["banned"],
    banReason: ["banReason", "ban_reason"],
    role: ["role"],
  },
  session: {
    id: ["id"],
    userId: ["userId", "user_id"],
    token: ["token"],
    createdAt: ["createdAt", "created_at"],
    expiresAt: ["expiresAt", "expires_at"],
    ipAddress: ["ipAddress", "ip_address"],
    userAgent: ["userAgent", "user_agent"],
  },
  account: {
    userId: ["userId", "user_id"],
    providerId: ["providerId", "provider_id"],
  },
};

type Columns = Record<Table, Record<string, string> | null>;

/** Which of Better Auth's tables exist, with each field's quoted column. */
async function columns(project: string): Promise<Columns> {
  const rows: { table: Table; column: string }[] = await projectSql(project)`
    select table_name as table, column_name as column from information_schema.columns
    where table_schema = ${AUTH_SCHEMA} and table_name in ('user', 'session', 'account')`;
  const out: Columns = { user: null, session: null, account: null };
  for (const table of ["user", "session", "account"] as const) {
    const present = new Set(rows.filter((r) => r.table === table).map((r) => r.column));
    if (present.size === 0) continue;
    const map: Record<string, string> = {};
    for (const [field, names] of Object.entries(FIELDS[table])) {
      const found = names.find((n) => present.has(n));
      if (found) map[field] = quoteIdent(found);
    }
    out[table] = map;
  }
  return out;
}

const tableRef = (table: Table) => `${AUTH_SCHEMA}.${quoteIdent(table)}`;

/** `expr as "field"` for each field present (null for the rest), for a select list. */
const selectList = (map: Record<string, string>, fields: string[]) => fields.map((f) => `${map[f] ?? "null"} as ${quoteIdent(f)}`).join(", ");

function requireUsers(cols: Columns): Record<string, string> {
  if (!cols.user?.id) throw new NotFoundError("Better Auth's tables aren't there yet: run its migrations (npx @better-auth/cli migrate) in your app");
  return cols.user;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

function toUser(r: Record<string, unknown>): AppUser {
  return {
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    emailVerified: (r.emailVerified as boolean | null) ?? null,
    image: (r.image as string | null) ?? null,
    createdAt: iso(r.createdAt),
    banned: (r.banned as boolean | null) ?? null,
    role: (r.role as string | null) ?? null,
  };
}

const USER_FIELDS = ["id", "name", "email", "emailVerified", "image", "createdAt", "banned", "role"];
const SESSION_FIELDS = ["id", "createdAt", "expiresAt", "ipAddress", "userAgent"];

export async function usersOverview(project: string): Promise<UsersOverview> {
  await requireEnabled(project);
  const cols = await columns(project);
  const db = projectSql(project);
  let users = 0;
  let activeSessions = 0;
  if (cols.user) [{ users }] = await db.unsafe(`select count(*)::int as users from ${tableRef("user")}`);
  if (cols.session?.expiresAt) [{ activeSessions }] = await db.unsafe(`select count(*)::int as "activeSessions" from ${tableRef("session")} where ${cols.session.expiresAt} > now()`);
  return {
    ready: Boolean(cols.user?.id),
    users,
    activeSessions,
    sessionsInDatabase: Boolean(cols.session) && activeSessions > 0,
    schema: AUTH_SCHEMA,
    setup: { databaseOptions: `-c search_path=${AUTH_SCHEMA}`, apiUrl: publicApiUrl() },
  };
}

export async function listUsers(project: string, q: { search?: string | null; limit?: number; offset?: number }): Promise<AppUserList> {
  await requireEnabled(project);
  const user = requireUsers(await columns(project));
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
  const search = (q.search ?? "").trim().slice(0, 200);
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const searchable = [user.email, user.name].filter(Boolean).map((c) => `${c} ilike $1`);
  const where = search ? `where ${[...searchable, `${user.id}::text = $2`].join(" or ")}` : "";
  const params = search ? [like, search] : [];
  const order = user.createdAt ? `${user.createdAt} desc nulls last` : user.id;
  const db = projectSql(project);
  const rows = await db.unsafe(`select ${selectList(user, USER_FIELDS)} from ${tableRef("user")} ${where} order by ${order} limit ${limit} offset ${offset}`, params);
  const [{ total }] = await db.unsafe(`select count(*)::int as total from ${tableRef("user")} ${where}`, params);
  return { users: rows.map(toUser), total };
}

async function findUser(project: string, cols: Columns, id: string): Promise<Record<string, unknown>> {
  const user = requireUsers(cols);
  if (!id || id.length > 200) throw new NotFoundError("user not found");
  const [row] = await projectSql(project).unsafe(`select ${selectList(user, USER_FIELDS)} from ${tableRef("user")} where ${user.id}::text = $1`, [id]);
  if (!row) throw new NotFoundError("user not found");
  return row;
}

export async function getUser(project: string, id: string): Promise<AppUserDetail> {
  await requireEnabled(project);
  const cols = await columns(project);
  const row = await findUser(project, cols, id);
  const db = projectSql(project);
  let sessions: AppSession[] = [];
  const s = cols.session;
  if (s?.userId) {
    const live = s.expiresAt ? `and ${s.expiresAt} > now()` : "";
    const order = s.createdAt ? `order by ${s.createdAt} desc` : "";
    const rows = await db.unsafe(`select ${selectList(s, SESSION_FIELDS)} from ${tableRef("session")} where ${s.userId}::text = $1 ${live} ${order} limit 100`, [id]);
    sessions = rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt),
      ipAddress: (r.ipAddress as string | null) ?? null,
      userAgent: (r.userAgent as string | null) ?? null,
    }));
  }
  let providers: string[] = [];
  const a = cols.account;
  if (a?.userId && a.providerId) {
    const rows: { provider: string }[] = await db.unsafe(`select distinct ${a.providerId} as provider from ${tableRef("account")} where ${a.userId}::text = $1 order by 1`, [id]);
    providers = rows.map((r) => r.provider);
  }
  return { ...toUser(row), sessions, providers };
}

/** Deletes sessions (all of a user's, or one) and their copies in the cache. Returns how many. */
async function deleteSessions(project: string, cols: Columns, userId: string, sessionId: string | null): Promise<number> {
  const s = cols.session;
  if (!s?.userId) return 0;
  const oneSession = sessionId ? `and ${s.id}::text = $2` : "";
  const rows: { token: string | null }[] = await projectSql(project).unsafe(
    `delete from ${tableRef("session")} where ${s.userId}::text = $1 ${oneSession} returning ${s.token ?? "null"} as token`,
    sessionId ? [userId, sessionId] : [userId],
  );
  const keys = rows.flatMap((r) => (r.token ? [sessionKey(project, r.token)] : []));
  // The SDK's secondary storage keeps sessions in Valkey too; without this they'd keep working.
  if (keys.length) await send("DEL", keys).catch(() => undefined);
  await send("DEL", [sessionKey(project, `active-sessions-${userId}`)]).catch(() => undefined);
  return rows.length;
}

export async function revokeSession(project: string, userId: string, sessionId: string, log: Logger) {
  await requireEnabled(project);
  const cols = await columns(project);
  await findUser(project, cols, userId);
  if ((await deleteSessions(project, cols, userId, sessionId)) === 0) throw new NotFoundError("session not found");
  audit({ action: "users.session_revoked", project, target: userId });
  log.info("app session revoked");
}

export async function revokeAllSessions(project: string, userId: string, log: Logger): Promise<{ revoked: number }> {
  await requireEnabled(project);
  const cols = await columns(project);
  await findUser(project, cols, userId);
  const revoked = await deleteSessions(project, cols, userId, null);
  audit({ action: "users.sessions_revoked", project, target: userId, meta: { count: revoked } });
  log.info("app sessions revoked", { count: revoked });
  return { revoked };
}

export async function deleteUser(project: string, userId: string, log: Logger) {
  await requireEnabled(project);
  const cols = await columns(project);
  const user = requireUsers(cols);
  await findUser(project, cols, userId);
  await deleteSessions(project, cols, userId, null);
  const db = projectSql(project);
  if (cols.account?.userId) await db.unsafe(`delete from ${tableRef("account")} where ${cols.account.userId}::text = $1`, [userId]);
  await db.unsafe(`delete from ${tableRef("user")} where ${user.id}::text = $1`, [userId]);
  audit({ action: "users.deleted", project, target: userId });
  log.info("app user deleted");
}

/** Bans or unbans (Better Auth's admin plugin columns). Banning also signs the user out. */
export async function setBanned(project: string, userId: string, body: Record<string, unknown>, log: Logger): Promise<AppUserDetail> {
  await requireEnabled(project);
  const cols = await columns(project);
  const user = requireUsers(cols);
  if (typeof body.banned !== "boolean") throw new BadRequestError("banned must be true or false");
  if (!user.banned) throw new BadRequestError("banning needs Better Auth's admin plugin (its banned column isn't there)");
  await findUser(project, cols, userId);
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const sets = [`${user.banned} = $2`, ...(user.banReason ? [`${user.banReason} = $3`] : [])];
  await projectSql(project).unsafe(`update ${tableRef("user")} set ${sets.join(", ")} where ${user.id}::text = $1`, user.banReason ? [userId, body.banned, body.banned ? reason : null] : [userId, body.banned]);
  if (body.banned) await deleteSessions(project, cols, userId, null);
  audit({ action: body.banned ? "users.banned" : "users.unbanned", project, target: userId });
  log.info(body.banned ? "app user banned" : "app user unbanned");
  return getUser(project, userId);
}

// ---- events from the app (SDK plugin) -----------------------------------------

const EVENT_ACTIONS: Record<string, string> = {
  "user.created": "users.signup",
  "user.deleted": "users.deleted",
  "session.created": "users.signin",
  "session.revoked": "users.signout",
};

/** `POST /users/:project/events` from `mybaseAuth()`: into the audit log. Returns how many were kept. */
export function recordEvents(project: string, body: unknown): number {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) throw new BadRequestError(`events must be a list of 1–${MAX_EVENTS}`);
  let kept = 0;
  for (const e of events as Record<string, unknown>[]) {
    const action = typeof e?.type === "string" ? EVENT_ACTIONS[e.type] : undefined;
    if (!action || typeof e.userId !== "string" || !e.userId || e.userId.length > 200) continue;
    const ip = typeof e.ip === "string" && e.ip.length <= 64 ? e.ip : undefined;
    const ua = typeof e.userAgent === "string" ? e.userAgent.slice(0, 200) : null;
    audit({ action, project, target: e.userId, ...(ip ? { ip } : {}), meta: ua ? { ua } : undefined });
    kept++;
  }
  return kept;
}

/** For project context: counts only, no user data. */
export async function usersContext(project: string): Promise<{ ready: boolean; users: number; schema: string }> {
  const o = await usersOverview(project);
  return { ready: o.ready, users: o.users, schema: o.schema };
}

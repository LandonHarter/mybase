// Admin auth for the control plane: one admin account, browser sessions, and API tokens
// for the CLI and scripts. Everything lives in the `mybase` schema (control.ts); tokens are
// stored as SHA-256 hashes, the password as argon2id.
import { ADMIN_PASSWORD_MIN, type ApiToken, type CreateApiTokenResponse } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { hashToken, newToken, SESSION_DAYS } from "./auth-http";
import { BadRequestError, ConflictError, UnauthorizedError } from "./errors";
import { sql } from "./postgres";

/** What a request authenticated with. Only hashes and ids, never the token itself. */
export type Auth = { kind: "session"; sessionHash: string } | { kind: "token"; tokenId: string };

const TOKEN_PREFIX = "mb_";
const SESSION_PREFIX = "mbs_";
// Last-seen times are refreshed at most this often, so most requests don't write (SD cards).
const TOUCH_MS = 3_600_000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.@-]{1,64}$/;

// Light enough for a Pi (OWASP's minimum argon2id settings); logins are rare.
const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
// Verified against when the username is wrong, so both cases take the same time.
const dummyHash = hashPassword(crypto.randomUUID());

interface AdminRow {
  username: string;
  password_hash: string;
}

// Cached: checked on every /auth/me, and it only ever goes from false to true.
let adminKnown = false;

async function getAdmin(): Promise<AdminRow | null> {
  const [row]: AdminRow[] = await sql`select username, password_hash from mybase.admin where id = 1`;
  if (row) adminKnown = true;
  return row ?? null;
}

export async function adminExists(): Promise<boolean> {
  return adminKnown || (await getAdmin()) !== null;
}

function checkUsername(username: unknown): asserts username is string {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) throw new BadRequestError("username must be 1–64 letters, digits, or . _ @ -");
}

function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < ADMIN_PASSWORD_MIN || password.length > 1024) {
    throw new BadRequestError(`password must be at least ${ADMIN_PASSWORD_MIN} characters`);
  }
}

/** Creates the admin account. Fails once one exists: there is exactly one. */
export async function createAdmin(username: unknown, password: unknown, log: Logger) {
  checkUsername(username);
  checkPassword(password);
  const hash = await hashPassword(password);
  const rows = await sql`insert into mybase.admin (username, password_hash) values (${username}, ${hash}) on conflict (id) do nothing returning id`;
  if (rows.length === 0) throw new ConflictError("the admin account already exists");
  adminKnown = true;
  log.info("admin created", { username });
}

/** `MYBASE_ADMIN_PASSWORD` (+ optional `MYBASE_ADMIN_USERNAME`) creates the admin on first boot. */
export async function bootstrapAdmin(log: Logger) {
  const password = process.env.MYBASE_ADMIN_PASSWORD;
  if (await adminExists()) return;
  if (!password) {
    log.warn("no admin account yet: open the dashboard from this machine or your LAN to create one, or set MYBASE_ADMIN_PASSWORD");
    return;
  }
  await createAdmin(process.env.MYBASE_ADMIN_USERNAME ?? "admin", password, log);
}

/** Checks a username + password. Throws UnauthorizedError with one message for both kinds of mistake. */
export async function verifyAdmin(username: unknown, password: unknown): Promise<string> {
  const admin = await getAdmin();
  const ok =
    typeof username === "string" &&
    typeof password === "string" &&
    (await Bun.password.verify(password, admin?.password_hash ?? (await dummyHash))) &&
    admin?.username === username;
  if (!ok || !admin) throw new UnauthorizedError("wrong username or password");
  return admin.username;
}

export async function adminUsername(): Promise<string | null> {
  return (await getAdmin())?.username ?? null;
}

export async function createSession(): Promise<string> {
  const token = newToken(SESSION_PREFIX);
  await sql`insert into mybase.sessions (token_hash, expires_at) values (${hashToken(token)}, now() + make_interval(days => ${SESSION_DAYS}))`;
  return token;
}

export async function deleteSession(sessionHash: string) {
  await sql`delete from mybase.sessions where token_hash = ${sessionHash}`;
}

/** Looks up a session cookie or bearer token. Expired sessions are deleted on sight. */
export async function authenticate(session: string | null, bearer: string | null): Promise<Auth | null> {
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const [row]: { id: string; last_used_at: Date | null }[] = await sql`
      select id, last_used_at from mybase.api_tokens where token_hash = ${hashToken(bearer)}`;
    if (!row) return null;
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > TOUCH_MS) {
      await sql`update mybase.api_tokens set last_used_at = now() where id = ${row.id}`;
    }
    return { kind: "token", tokenId: row.id };
  }
  if (session?.startsWith(SESSION_PREFIX)) {
    const sessionHash = hashToken(session);
    const [row]: { expired: boolean; last_seen_at: Date }[] = await sql`
      select expires_at < now() as expired, last_seen_at from mybase.sessions where token_hash = ${sessionHash}`;
    if (!row) return null;
    if (row.expired) {
      await deleteSession(sessionHash);
      return null;
    }
    // Sliding expiry: an admin who keeps using the dashboard stays signed in.
    if (Date.now() - row.last_seen_at.getTime() > TOUCH_MS) {
      await sql`
        update mybase.sessions set last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS})
        where token_hash = ${sessionHash}`;
    }
    return { kind: "session", sessionHash };
  }
  return null;
}

/** Changes the password and signs out every other session. API tokens keep working. */
export async function changePassword(current: unknown, next: unknown, keepSession: string | null, log: Logger) {
  const username = await adminUsername();
  await verifyAdmin(username, current).catch((err) => {
    throw err instanceof UnauthorizedError ? new UnauthorizedError("current password is wrong") : err;
  });
  checkPassword(next);
  const hash = await hashPassword(next);
  await sql.begin(async (tx) => {
    await tx`update mybase.admin set password_hash = ${hash}, password_changed_at = now() where id = 1`;
    await tx`delete from mybase.sessions where token_hash <> ${keepSession ?? ""}`;
  });
  log.info("admin password changed", { username });
}

/** Signs out every browser, including this one. */
export async function deleteAllSessions() {
  await sql`delete from mybase.sessions`;
}

interface TokenRow {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});

export async function listTokens(): Promise<ApiToken[]> {
  const rows: TokenRow[] = await sql`select id, name, created_at, last_used_at from mybase.api_tokens order by created_at desc`;
  return rows.map(toToken);
}

export async function createToken(name: unknown, log: Logger): Promise<CreateApiTokenResponse> {
  if (typeof name !== "string" || !name.trim() || name.length > 100) throw new BadRequestError("name must be 1–100 characters");
  const token = newToken(TOKEN_PREFIX);
  const [row]: TokenRow[] = await sql`
    insert into mybase.api_tokens (name, token_hash) values (${name.trim()}, ${hashToken(token)})
    returning id, name, created_at, last_used_at`;
  log.info("api token created", { tokenId: row!.id, name: row!.name });
  return { ...toToken(row!), token };
}

/** False when no token has this id. */
export async function deleteToken(id: string, log: Logger): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return false;
  const rows = await sql`delete from mybase.api_tokens where id = ${id} returning id`;
  if (rows.length) log.info("api token revoked", { tokenId: id });
  return rows.length > 0;
}

// `mybase users …`: sign-in for a project's app users, with Better Auth in the app.
import type { AppUserDetail, AppUserList, UsersOverview } from "@mybase/shared";
import { api } from "./api";
import { flagString, need, parseArgs } from "./cron";
import { confirm, print } from "./output";
import { enableService, printLinked } from "./service-enable";

export const usersUsage = `  users enable <project>         Turn on users: an auth schema for Better Auth, plus setup steps
  users init <project> [--env <secrets env>]  Print an auth.ts for Better Auth; --env stores a new BETTER_AUTH_SECRET there
  users list <project> [--search <text>]  The app's users, newest first
  users show <project> <user-id>  One user: sign-in methods and active sessions
  users revoke <project> <user-id> [<session-id>]  Sign a user out (one session, or everywhere)
  users delete <project> <user-id> [--yes]  Delete a user and their sessions
  users disable <project> [--yes]  Turn it off, deleting every user account`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/users`;

export function authSnippet(project: string, apiUrl: string): string {
  return `// auth.ts: npm i better-auth pg @mybase-dev/sdk
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { createCache } from "@mybase-dev/sdk/cache";
import { authDatabaseUrl, mybaseAuth, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";

const mybase = { apiUrl: "${apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! };

export const auth = betterAuth({
  // Better Auth's tables go in the "auth" schema of the project's database.
  database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }),
  // Sessions and rate limits in the mybase cache (turn on the cache service first).
  secondaryStorage: mybaseSecondaryStorage(createCache(mybase)),
  // Keep a copy in Postgres too, so the dashboard can list and revoke sessions.
  session: { storeSessionInDatabase: true },
  emailAndPassword: { enabled: true },
  // Sign-ups and sign-ins in the mybase audit log.
  plugins: [mybaseAuth(mybase)],
});

// Then create the tables: npx @better-auth/cli migrate`;
}

/** Handles `mybase users <sub> …`. False when `sub` isn't a users command. */
export async function users(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, userId, sessionId] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "users", flags);
      const o = await api<UsersOverview>(base(p));
      print({ enabled: "users", project: p, linked, ...o }, () => {
        console.log(`Users enabled for "${p}". Better Auth's tables go in the "${o.schema}" schema.\n`);
        console.log("Next:");
        console.log(`  1. An API key for the app: mybase token create ${p}-auth --project ${p} --perm users:write,cache:write`);
        console.log(`  2. The cache, for sessions: mybase cache enable ${p}`);
        console.log(`  3. An auth.ts to start from: mybase users init ${p}`);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "init": {
      const p = need(project, "project name");
      const o = await api<UsersOverview>(base(p));
      const env = flagString(flags, "env");
      let stored: string | null = null;
      if (env) {
        const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
        await api(`/projects/${encodeURIComponent(p)}/secrets/envs/${encodeURIComponent(env)}/secrets`, {
          method: "PATCH",
          body: JSON.stringify({ set: { BETTER_AUTH_SECRET: secret }, message: "mybase users init" }),
        });
        stored = env;
      }
      const snippet = authSnippet(p, o.setup.apiUrl);
      print({ project: p, snippet, storedSecretIn: stored }, () => {
        console.log(snippet);
        console.log(
          stored
            ? `\nStored a new BETTER_AUTH_SECRET in secrets env "${stored}". Run your app with: mybase run -e ${stored} -- <command>`
            : "\nSet BETTER_AUTH_SECRET to 32+ random bytes (openssl rand -base64 32), or rerun with --env <secrets env> to store one.",
        );
      });
      return true;
    }
    case "list": {
      const p = need(project, "project name");
      const search = flagString(flags, "search");
      const list = await api<AppUserList>(`${base(p)}/accounts?limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`);
      print(list, () => {
        if (list.users.length === 0) console.log(search ? "No users match." : "No users yet.");
        for (const u of list.users) console.log(`${u.id}\t${u.email ?? "-"}\t${u.name ?? "-"}\t${u.createdAt ?? ""}${u.banned ? "\tbanned" : ""}`);
        if (list.total > list.users.length) console.log(`… and ${list.total - list.users.length} more (narrow it with --search)`);
      });
      return true;
    }
    case "show": {
      const p = need(project, "project name");
      const u = await api<AppUserDetail>(`${base(p)}/accounts/${encodeURIComponent(need(userId, "user id"))}`);
      print(u, () => {
        console.log(`${u.email ?? u.id}${u.name ? ` (${u.name})` : ""}${u.banned ? "  BANNED" : ""}`);
        console.log(`  id          ${u.id}`);
        console.log(`  created     ${u.createdAt ?? "-"}`);
        console.log(`  verified    ${u.emailVerified ?? "-"}`);
        console.log(`  sign-in     ${u.providers.join(", ") || "-"}`);
        console.log(`\nActive sessions (${u.sessions.length}):`);
        for (const s of u.sessions) console.log(`  ${s.id}  since ${s.createdAt ?? "?"}  ${s.ipAddress ?? ""}  ${s.userAgent ?? ""}`);
      });
      return true;
    }
    case "revoke": {
      const p = need(project, "project name");
      const id = encodeURIComponent(need(userId, "user id"));
      if (sessionId) {
        await api(`${base(p)}/accounts/${id}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        print({ revoked: 1 }, () => console.log("Signed out that session."));
      } else {
        const r = await api<{ revoked: number }>(`${base(p)}/accounts/${id}/sessions`, { method: "DELETE" });
        print(r, () => console.log(`Signed out ${r.revoked} session(s).`));
      }
      return true;
    }
    case "delete": {
      const p = need(project, "project name");
      const id = need(userId, "user id");
      confirm(args.includes("--yes"), `This deletes user ${id} of "${p}" and signs them out.`, id, "the user id");
      await api(`${base(p)}/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      print({ deleted: id }, () => console.log(`Deleted user ${id}`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(args.includes("--yes"), `This deletes every user account, session, and sign-in method of "${p}" (the auth schema).`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/users`, { method: "DELETE" });
      print({ disabled: "users", project: p }, () => console.log(`Users disabled for "${p}"`));
      return true;
    }
  }
  return false;
}

import { useEffect, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { toast } from "sonner";
import type { AppUserDetail, Project } from "@mybase/shared";
import { LoadError, LoadingLines } from "@/components/analytics-parts";
import { KeyDialog } from "@/components/api-tokens";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const authSnippet = (apiUrl: string, project: string) => `// auth.ts: npm i better-auth pg @mybase-dev/sdk
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { createCache } from "@mybase-dev/sdk/cache";
import { authDatabaseUrl, mybaseAuth, mybaseSecondaryStorage } from "@mybase-dev/sdk/better-auth";

const mybase = { apiUrl: "${apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! };

export const auth = betterAuth({
  database: new Pool({ connectionString: authDatabaseUrl(process.env.DATABASE_URL!) }),
  secondaryStorage: mybaseSecondaryStorage(createCache(mybase)), // needs the cache service
  session: { storeSessionInDatabase: true }, // so this page can list and revoke sessions
  emailAndPassword: { enabled: true },
  plugins: [mybaseAuth(mybase)], // sign-ins in the mybase audit log
});`;

const when = (iso: string | null) =>
  iso ? (
    <time dateTime={iso} title={formatDate(iso)}>
      {timeAgo(iso)}
    </time>
  ) : (
    "—"
  );

function Setup({ project, apiUrl, ready }: { project: string; apiUrl: string; ready: boolean }) {
  const [keyOpen, setKeyOpen] = useState(false);
  return (
    <section aria-labelledby="users-setup" className="mb-10">
      <h2 id="users-setup" className="mb-3 text-base font-semibold">
        {ready ? "Setup" : "Set up Better Auth"}
      </h2>
      {!ready && (
        <p className="mb-4 max-w-prose text-muted-foreground">
          Better Auth runs in your app and signs your users in; mybase keeps its tables in this project's database (schema <span className="font-mono">auth</span>), its
          sessions in the cache, and its sign-ins in the audit log. Users show up here once its tables exist.
        </p>
      )}
      <Row title="1. API key" hint="For the app's server: sends sign-in events and uses the cache.">
        <Button variant="outline" onClick={() => setKeyOpen(true)}>
          <KeyRound />
          Create API key
        </Button>
      </Row>
      <Row title="2. auth.ts" hint="Better Auth's config, with mybase plugged in.">
        {code(authSnippet(apiUrl, project))}
      </Row>
      <Row title="3. Tables" hint="Better Auth creates them in the auth schema.">
        {code("npx @better-auth/cli migrate   # Better Auth 1.7+: npx auth migrate")}
      </Row>
      <KeyDialog open={keyOpen} onOpenChange={setKeyOpen} preset={{ name: `${project} auth`, permissions: ["users:write", "cache:write"], projects: [project] }} />
    </section>
  );
}

function UserList({ project, query }: { project: string; query: string }) {
  const [search, setSearch] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== query) navigate({ page: "users", name: project, user: null, query: search }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [search, query, project]);
  const { state, refresh } = useLoad(`app-users:${project}:${query}`, () => api.appUsers(project, query));

  return (
    <section aria-labelledby="users-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="users-list" className="text-base font-semibold">
          Users {state.status === "ready" && <span className="font-normal text-muted-foreground">{state.data.total.toLocaleString()}</span>}
        </h2>
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email, name, or id" className="max-w-xs" aria-label="Search users" />
      </div>
      {state.status === "loading" && <LoadingLines label="Loading users" lines={5} />}
      {state.status === "error" && <LoadError what="users" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" &&
        (state.data.users.length === 0 ? (
          <div className="max-w-prose rounded-lg border border-dashed p-5">
            <p className="font-medium">{query ? "No users match" : "No users yet"}</p>
            <p className="mt-1 text-muted-foreground">{query ? "Try part of an email address or a user id." : "People who sign up in your app show up here."}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Signed up</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.users.map((u) => (
                <TableRow key={u.id} className="cursor-pointer" onClick={() => navigate({ page: "users", name: project, user: u.id, query })}>
                  <TableCell>
                    <a href={href({ page: "users", name: project, user: u.id, query })} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {u.email ?? u.id}
                    </a>
                    {u.banned && <span className="ml-2 rounded-sm border px-1.5 py-0.5 text-xs text-destructive">Banned</span>}
                    {u.emailVerified === false && <span className="ml-2 rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground">Unverified</span>}
                  </TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{when(u.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}

function UserDetail({ project, id }: { project: string; id: string }) {
  const { state, refresh } = useLoad(`app-user:${project}:${id}`, () => api.appUser(project, id));
  const [dialog, setDialog] = useState<"delete" | "signout" | null>(null);
  const back = href({ page: "users", name: project, user: null, query: "" });

  const header = (u?: AppUserDetail) => (
    <PageHeader
      title={u ? (u.email ?? u.name ?? u.id) : "User"}
      breadcrumb={{ label: `${project} / Users`, href: back }}
      description={u?.name && u.email ? u.name : undefined}
      action={
        u && (
          <Button variant="outline" onClick={() => setDialog("signout")} disabled={u.sessions.length === 0}>
            <LogOut />
            Sign out everywhere
          </Button>
        )
      }
    />
  );

  if (state.status === "loading") return <>{header()}<LoadingLines label="Loading user" lines={4} /></>;
  if (state.status === "error") return <>{header()}<LoadError what="this user" message={state.message} onRetry={() => void refresh()} /></>;
  const u = state.data;

  const revoke = async (session: string) => {
    try {
      await api.revokeAppSession(project, u.id, session);
      toast.success("Signed out that session");
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const ban = async (banned: boolean) => {
    try {
      await api.banAppUser(project, u.id, banned);
      toast.success(banned ? `Banned ${u.email ?? u.id} and signed them out` : `Unbanned ${u.email ?? u.id}`);
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      {header(u)}
      <section aria-labelledby="user-details" className="mb-10">
        <h2 id="user-details" className="sr-only">
          Details
        </h2>
        <Row title="User id" hint="Better Auth's id, also the audit log's target.">
          <span className="font-mono text-xs">{u.id}</span>
        </Row>
        <Row title="Signed up" hint="When the account was created.">
          {when(u.createdAt)}
        </Row>
        <Row title="Email" hint="Verified when they followed the link Better Auth sent.">
          {u.email ?? "—"} {u.emailVerified !== null && <span className="text-muted-foreground">({u.emailVerified ? "verified" : "not verified"})</span>}
        </Row>
        <Row title="Signs in with" hint="credential = email and password.">
          {u.providers.length ? u.providers.join(", ") : "—"}
        </Row>
      </section>

      <section aria-labelledby="user-sessions" className="mb-10">
        <h2 id="user-sessions" className="mb-3 text-base font-semibold">
          Active sessions <span className="font-normal text-muted-foreground">{u.sessions.length}</span>
        </h2>
        {u.sessions.length === 0 ? (
          <p className="text-muted-foreground">Not signed in anywhere. (Sessions show here when the app sets session.storeSessionInDatabase.)</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Signed in</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {u.sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{when(s.createdAt)}</TableCell>
                  <TableCell className="max-w-72">
                    <span className="font-mono text-xs">{s.ipAddress ?? "—"}</span>
                    {s.userAgent && <div className="truncate text-xs text-muted-foreground" title={s.userAgent}>{s.userAgent}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{when(s.expiresAt)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => void revoke(s.id)}>
                      Sign out
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="user-danger">
        <h2 id="user-danger" className="mb-3 text-base font-semibold">
          Account
        </h2>
        {u.banned !== null && (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
            <p className="max-w-prose text-muted-foreground">{u.banned ? "Banned: Better Auth refuses their sign-ins." : "Banning signs them out and refuses new sign-ins (Better Auth's admin plugin)."}</p>
            <Button variant="outline" onClick={() => void ban(!u.banned)}>
              {u.banned ? "Unban" : "Ban user"}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes the account, its sign-in methods, and its sessions. Your app's own rows for this user stay.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
            Delete user
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={dialog === "signout"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Sign out ${u.email ?? u.id} everywhere`}
        description="Ends every session they have. They can sign in again."
        confirm="Sign out everywhere"
        pendingLabel="Signing out…"
        destructive={false}
        onConfirm={async () => {
          const r = await api.revokeAppSessions(project, u.id);
          toast.success(`Signed out ${r.revoked} session${r.revoked === 1 ? "" : "s"}`);
          void refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${u.email ?? u.id}`}
        description="Deletes the account, its sign-in methods, and its sessions. This can't be undone."
        confirm="Delete user"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await api.deleteAppUser(project, u.id);
          toast.success(`Deleted ${u.email ?? u.id}`);
          navigate({ page: "users", name: project, user: null, query: "" });
        }}
      />
    </>
  );
}

function Users({ project, user, query }: { project: Project; user: string | null; query: string }) {
  const name = project.name;
  const overview = useLoad(`users-overview:${name}`, () => api.usersOverview(name));
  const [off, setOff] = useState(false);

  if (user) return <UserDetail project={name} id={user} />;

  async function turnOff() {
    try {
      await api.disableService(name, "users");
      await refreshProjects();
      toast.success(`Turned off users for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off users: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <PageHeader title="Users" breadcrumb={{ label: name, href: href({ page: "project", name }) }} description="Your app's users, signed in by Better Auth in your app." />
      {overview.state.status === "loading" && <LoadingLines label="Loading users" lines={4} />}
      {overview.state.status === "error" && <LoadError what="users" message={overview.state.message} onRetry={() => void overview.refresh()} />}
      {overview.state.status === "ready" && (
        <>
          {overview.state.data.ready ? <UserList project={name} query={query} /> : <Setup project={name} apiUrl={overview.state.data.setup.apiUrl} ready={false} />}
          {overview.state.data.ready && (
            <details className="mt-10">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Setup and snippets</summary>
              <div className="mt-4">
                <Setup project={name} apiUrl={overview.state.data.setup.apiUrl} ready />
              </div>
            </details>
          )}
        </>
      )}
      <section aria-labelledby="danger" className="mt-10">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off users
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Deletes every account, session, and sign-in method (the auth schema).</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOff(true)}>
            Turn off users
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={`Turn off users for ${name}`}
        description={SERVICE_PAGES.users.turnOff}
        confirm="Turn off users"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function UsersPage({ name, user, query }: { name: string; user: string | null; query: string }) {
  return (
    <ProjectGate name={name} title="Users" backToProject>
      {(project) => {
        if (!project.services.includes("users")) {
          return (
            <ServiceOff project={project} id="users">
              Turn it on to sign your app's users in with Better Auth, backed by this project: its tables in your database, sessions in the cache, sign-ins in the audit log,
              and the users listed here.
            </ServiceOff>
          );
        }
        return <Users project={project} user={user} query={query} />;
      }}
    </ProjectGate>
  );
}

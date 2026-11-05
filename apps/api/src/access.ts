// How this server is reached, per service and route: what linked secrets resolve against and
// what `mybase database access` / the dashboard's Database page show. Built from env (compose
// passes the published ports, binds, and LAN/Tailscale names) plus live public-Postgres status.
import type { DatabaseAccess } from "@mybase/shared";
import { dbPublicStatus } from "./db-public";
import { wsUrl } from "./postgres";
import { topology, type Topology } from "./secrets-resolve";

const hostingOn = () => Boolean(process.env.MYBASE_HOSTING_WORKER_URL && process.env.MYBASE_HOSTING_WORKER_KEY);

export function currentTopology(): Topology {
  const s = dbPublicStatus();
  return topology(process.env, {
    dbPublic: { enabled: s.enabled && !s.problem, tlsActive: s.tls.active, host: s.host, port: s.port },
    hostingOn: hostingOn(),
    wsUrl,
  });
}

/** `GET /projects/:name/database/access`. No secrets: hosts and ports only. */
export function databaseAccess(project: string, hostingEnabled: boolean): DatabaseAccess {
  const routes = currentTopology().database.map((r) =>
    r.route === "internal"
      ? { ...r, on: r.on && hostingEnabled, note: r.on && !hostingEnabled ? "hosting isn't enabled for this project" : r.note }
      : r,
  );
  const s = dbPublicStatus();
  return { project, routes, wsUrl, public: { enabled: s.enabled, tlsActive: s.tls.active, host: s.enabled ? s.host : null, problem: s.problem } };
}

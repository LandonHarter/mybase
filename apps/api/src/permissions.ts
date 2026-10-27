// What an API key may do. Keys hold permissions (`queue:write`, `admin`, …) and optionally a
// list of projects. Each route's requirement comes from its path, so a route nobody thought
// about needs `admin`: new routes are never more open than that by accident.
import { KEY_RESOURCES, PROJECT_NAME_PATTERN, type KeyLevel, type KeyPermission, type KeyResource } from "@mybase/shared";
import { BadRequestError } from "./errors";

/** What a request authenticated with grants. Sessions are `{ permissions: ["admin"], projects: null }`. */
export interface Grant {
  permissions: readonly KeyPermission[];
  /** null = every project. */
  projects: readonly string[] | null;
}

/** `any`: any valid key (signing out). */
export type Requirement = "admin" | "any" | { resource: KeyResource; level: KeyLevel };

const RESOURCE_IDS = new Set<string>(KEY_RESOURCES.map((r) => r.id));

// `/projects/:name/<segment>/…` → resource.
const PROJECT_SEGMENTS: Record<string, KeyResource> = {
  files: "storage",
  database: "database",
  services: "projects",
  cron: "cron",
  analytics: "analytics",
  cache: "cache",
  ratelimit: "ratelimit",
  queue: "queue",
};

// App routes: `/<segment>/:project/…`.
const APP_SEGMENTS: Record<string, KeyResource> = { queue: "queue", ratelimit: "ratelimit", cache: "cache", cron: "cron" };

/** What a non-open route needs. GET reads; every other method writes. */
export function requirement(method: string, pathname: string): Requirement {
  const [first, project, segment, sub] = pathname.split("/").slice(1);
  const level: KeyLevel = method === "GET" || method === "HEAD" ? "read" : "write";
  if (first === "auth") return project === "logout" ? "any" : "admin";
  // MCP tools call the REST routes with the caller's key, so each tool is checked there.
  if (first === "mcp" && project === undefined) return "any";
  if (first === "projects") {
    if (segment === undefined) return { resource: "projects", level };
    // Any key that can see the project; the handler leaves out what it may not read.
    if (segment === "context" && sub === undefined && level === "read") return "any";
    // The SQL editor runs on a superuser pool (`RESET ROLE` gets out), and extensions are
    // created as superuser: both are as good as admin.
    if (segment === "database" && (sub === "query" || sub === "extensions")) return "admin";
    const resource = PROJECT_SEGMENTS[segment];
    return resource ? { resource, level } : "admin";
  }
  const resource = first !== undefined && project !== undefined ? APP_SEGMENTS[first] : undefined;
  return resource ? { resource, level } : "admin";
}

const has = (grant: Grant, permission: KeyPermission) => grant.permissions.includes(permission);

/**
 * Whether `grant` meets `need` for `project` (null for routes outside one project). A key
 * limited to some projects can read lists (filtered by the route) but can't write outside them,
 * so it can't create projects.
 */
export function allows(grant: Grant, need: Requirement, project: string | null): boolean {
  if (has(grant, "admin")) return true;
  if (need === "any") return true;
  if (need === "admin") return false;
  const { resource, level } = need;
  if (!has(grant, `${resource}:write`) && !(level === "read" && has(grant, `${resource}:read`))) return false;
  if (grant.projects === null) return true;
  return project === null ? level === "read" : grant.projects.includes(project);
}

/** Whether `grant` can see `project` at all (for filtering lists). */
export const canSeeProject = (grant: Grant, project: string) => grant.projects === null || grant.projects.includes(project);

/** Why `allows` said no, for the 403. */
export function deniedMessage(grant: Grant, need: Requirement, project: string | null): string {
  if (need === "admin" || need === "any") return "this API key needs the admin permission";
  if (project !== null && !canSeeProject(grant, project)) return `this API key can't access project "${project}"`;
  if (project === null && grant.projects !== null && need.level === "write") return "this API key is limited to some projects, so it can't do this";
  return `this API key needs ${need.resource}:${need.level}`;
}

/** Validates permissions and projects from a request body. */
export function readGrant(permissions: unknown, projects: unknown): Grant {
  if (!Array.isArray(permissions) || permissions.length === 0) throw new BadRequestError("permissions must be a non-empty list");
  for (const p of permissions) {
    const [resource, level, extra] = typeof p === "string" ? p.split(":") : [];
    const ok = p === "admin" || (resource !== undefined && RESOURCE_IDS.has(resource) && (level === "read" || level === "write") && extra === undefined);
    if (!ok) throw new BadRequestError(`unknown permission ${JSON.stringify(p)}: use admin or <resource>:read|write`);
  }
  const unique = [...new Set(permissions as KeyPermission[])].sort();
  if (projects === null || projects === undefined) return { permissions: unique, projects: null };
  if (!Array.isArray(projects) || projects.length === 0) throw new BadRequestError("projects must be null (all projects) or a non-empty list");
  if (unique.includes("admin")) throw new BadRequestError("an admin key can't be limited to projects");
  for (const p of projects) {
    if (typeof p !== "string" || !PROJECT_NAME_PATTERN.test(p)) throw new BadRequestError(`invalid project name ${JSON.stringify(p)}`);
  }
  return { permissions: unique, projects: [...new Set(projects as string[])].sort() };
}

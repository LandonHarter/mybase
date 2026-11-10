// Optional services: ones a project turns on, unlike the core database and storage.
// Each one is a ServiceModule; the project's registry entry lists which are enabled.
import { SERVICE_REQUIRES, SERVICES, type EnableServiceResponse, type ServiceId } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { analyticsService } from "./analytics";
import { cacheService } from "./cache";
import { captchaService } from "./captcha";
import { cronService } from "./cron";
import { ConflictError, NotFoundError, UpstreamError } from "./errors";
import { listProjects, updateProjectMeta } from "./postgres";
import { queueService } from "./queue";
import { ratelimitService } from "./ratelimit";
import { realtimeService } from "./realtime";
import { searchService } from "./search";
import { secretsService } from "./secrets";
import { linkService, rememberCachePassword, unlinkService } from "./secrets-link";
import { usersService } from "./users";
import { vectorService } from "./vector";
import { sandboxService } from "./sandbox";
import { hostingService } from "./hosting";
import { registryService } from "./registry";
import { emailService } from "./email";

/** What an optional service implements. Both steps must be safe to retry. */
export interface ServiceModule {
  id: ServiceId;
  /** Provisions the service's per-project resources. May return credentials, shown once. */
  enable(project: string, log: Logger): Promise<EnableServiceResponse | void>;
  /** Removes them, including the project's data in that service. */
  disable(project: string, log: Logger): Promise<void>;
}

/** Register optional services here (and in SERVICES, with `core: false`). */
const modules: ServiceModule[] = [cronService, analyticsService, cacheService, ratelimitService, queueService, searchService, secretsService, vectorService, usersService, captchaService, realtimeService, sandboxService, registryService, hostingService, emailService];

function optional(id: string): ServiceModule {
  const module = modules.find((m) => m.id === id);
  const known = SERVICES.find((s) => s.id === id);
  if (!module || !known || known.core) throw new NotFoundError(`no optional service "${id}"`);
  return module;
}

async function enabledServices(project: string): Promise<ServiceId[]> {
  return (await listProjects()).find((p) => p.name === project)?.services ?? [];
}

/** Enabled services that need `id` (SERVICE_REQUIRES). */
const dependents = (id: ServiceId, enabled: readonly ServiceId[]) => enabled.filter((s) => SERVICE_REQUIRES[s]?.includes(id));

/** `services` in an order safe to turn off one by one: services others need go last. */
export function teardownOrder(services: readonly ServiceId[]): ServiceId[] {
  const needed = (s: ServiceId) => services.some((other) => SERVICE_REQUIRES[other]?.includes(s));
  return [...services].sort((a, b) => Number(needed(a)) - Number(needed(b)));
}

/**
 * `project` must exist and match PROJECT_NAME_PATTERN. With `link`, the service's keys are added
 * to the project's linked secrets envs (see secrets-link.ts). Services it requires
 * (SERVICE_REQUIRES) are enabled first.
 */
export async function enableService(project: string, id: string, log: Logger, opts: { link?: boolean } = {}): Promise<EnableServiceResponse | void> {
  const module = optional(id);
  const required = SERVICE_REQUIRES[module.id] ?? [];
  if (required.length) {
    const enabled = await enabledServices(project);
    for (const dep of required) if (!enabled.includes(dep)) await enableService(project, dep, log);
  }
  const result = await module.enable(project, log);
  await updateProjectMeta(project, (meta) => ({ ...meta, services: [...new Set([...(meta.services ?? []), module.id])] }));
  log.info("service enabled", { service: id });
  // A new cache password: linked REDIS_URLs (stored credentials) follow it.
  if (result?.service === "cache") await rememberCachePassword(project, result.credentials.url, log);
  if (opts.link) {
    try {
      await linkService(project, module.id, result, log);
    } catch (err) {
      log.error("linking service keys failed", { service: id, err });
      throw new UpstreamError(`${id} is on, but adding its keys to the linked secrets envs failed. Run mybase secrets link to try again.`);
    }
  }
  return result;
}

export async function disableService(project: string, id: string, log: Logger) {
  const module = optional(id);
  const blocking = dependents(module.id, await enabledServices(project));
  if (blocking.length) throw new ConflictError(`turn off ${blocking.join(", ")} first: it needs ${id}`);
  await module.disable(project, log);
  await updateProjectMeta(project, (meta) => ({ ...meta, services: (meta.services ?? []).filter((s) => s !== module.id) }));
  log.info("service disabled", { service: id });
  // The keys don't work anymore; leaving them behind is harmless, so this never fails the disable.
  await unlinkService(project, module.id, log).catch((err) => log.warn("removing service keys from linked envs failed", { service: id, err }));
}

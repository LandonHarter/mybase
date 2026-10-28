// Optional services: ones a project turns on, unlike the core database and storage.
// Each one is a ServiceModule; the project's registry entry lists which are enabled.
import { SERVICES, type EnableServiceResponse, type ServiceId } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { analyticsService } from "./analytics";
import { cacheService } from "./cache";
import { captchaService } from "./captcha";
import { cronService } from "./cron";
import { NotFoundError, UpstreamError } from "./errors";
import { updateProjectMeta } from "./postgres";
import { queueService } from "./queue";
import { ratelimitService } from "./ratelimit";
import { realtimeService } from "./realtime";
import { searchService } from "./search";
import { secretsService } from "./secrets";
import { linkService, unlinkService } from "./secrets-link";
import { usersService } from "./users";
import { vectorService } from "./vector";

/** What an optional service implements. Both steps must be safe to retry. */
export interface ServiceModule {
  id: ServiceId;
  /** Provisions the service's per-project resources. May return credentials, shown once. */
  enable(project: string, log: Logger): Promise<EnableServiceResponse | void>;
  /** Removes them, including the project's data in that service. */
  disable(project: string, log: Logger): Promise<void>;
}

/** Register optional services here (and in SERVICES, with `core: false`). */
const modules: ServiceModule[] = [cronService, analyticsService, cacheService, ratelimitService, queueService, searchService, secretsService, vectorService, usersService, captchaService, realtimeService];

function optional(id: string): ServiceModule {
  const module = modules.find((m) => m.id === id);
  const known = SERVICES.find((s) => s.id === id);
  if (!module || !known || known.core) throw new NotFoundError(`no optional service "${id}"`);
  return module;
}

/**
 * `project` must exist and match PROJECT_NAME_PATTERN. With `link`, the service's keys are added
 * to the project's linked secrets envs (see secrets-link.ts).
 */
export async function enableService(project: string, id: string, log: Logger, opts: { link?: boolean } = {}): Promise<EnableServiceResponse | void> {
  const module = optional(id);
  const result = await module.enable(project, log);
  await updateProjectMeta(project, (meta) => ({ ...meta, services: [...new Set([...(meta.services ?? []), module.id])] }));
  log.info("service enabled", { service: id });
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
  await module.disable(project, log);
  await updateProjectMeta(project, (meta) => ({ ...meta, services: (meta.services ?? []).filter((s) => s !== module.id) }));
  log.info("service disabled", { service: id });
  // The keys don't work anymore; leaving them behind is harmless, so this never fails the disable.
  await unlinkService(project, module.id, log).catch((err) => log.warn("removing service keys from linked envs failed", { service: id, err }));
}

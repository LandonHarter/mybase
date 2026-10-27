// Jobs declared in code. `mybase cron sync` imports this file (and only this file),
// so keep app code out of it: handlers live with your routes (see ./cron).

/** One job mybase calls on a schedule. */
export interface CronJobConfig {
  /** Standard 5-field cron expression (minute precision), e.g. `0 3 * * *`. */
  schedule: string;
  /** Appended to `cron.baseUrl`. Default `/api/cron`. */
  path?: string;
  /** IANA time zone the schedule runs in. Default `UTC`. */
  timezone?: string;
  /** JSON sent to your handler as `run.payload`. */
  payload?: unknown;
  /** Extra tries after a failed call (network error, timeout, 429, 5xx). 0–5, default 2. */
  retries?: number;
  /** How long to wait for your endpoint, in ms. 1000–120000, default 30000. */
  timeoutMs?: number;
}

export interface MybaseConfig {
  /** The mybase project these jobs belong to. */
  project: string;
  cron?: {
    /** Where your app is reachable from the mybase server, e.g. `https://shop.example.com`. */
    baseUrl: string;
    jobs: Record<string, CronJobConfig>;
  };
}

/** Identity function that types `mybase.config.ts`. */
export function defineConfig<const C extends MybaseConfig>(config: C): C {
  return config;
}

export const DEFAULT_CRON_PATH = "/api/cron";

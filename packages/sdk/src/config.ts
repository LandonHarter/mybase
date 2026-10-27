// Cron jobs, rate limit rules, queues, and vector indexes declared in code. `mybase cron sync`,
// `mybase ratelimit sync`, `mybase queue sync`, and `mybase vector sync` import this file (and
// only this file), so keep app code out of it: handlers live with your routes (see ./cron).
import type { DeadLetterSettings } from "./queue";
import type { RateLimitAlgorithm } from "./ratelimit";
import type { VectorIndexInput } from "./vector";

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

/** One named rate limit. Apps use it with `limiter.limit("<name>", id)`. */
export interface RateLimitRuleConfig {
  /** Default `sliding`. */
  algorithm?: RateLimitAlgorithm;
  /** Requests (units) allowed per window. */
  limit: number;
  /** Milliseconds, or `"10s"`, `"1m"`, `"1h"`, `"1d"`. 1s–30d. */
  window: number | string;
  /** Token bucket only: capacity. Default `limit`. */
  burst?: number;
}

/** One queue. Durations are ms or `"30s"`, `"5m"`, `"4d"`. */
export interface QueueConfig {
  /** Strict order per message group, deduplicated sends. Can't be changed after creation. Default false. */
  fifo?: boolean;
  /** How long a received message stays hidden. 0–12h, default 30s. */
  visibilityTimeout?: number | string;
  /** How long new messages wait before they can be received. 0–15m, default 0. */
  delay?: number | string;
  /** How long unreceived messages are kept. 1m–14d, default 4d. */
  retention?: number | string;
  /** Default long-poll wait for receives. 0–20s, default 0. */
  receiveWait?: number | string;
  /** 1024–262144, default 262144. */
  maxMessageBytes?: number;
  /** FIFO only: deduplicate by body when a send has no `dedupId`. */
  contentDedup?: boolean;
  /** After `maxReceives` failed deliveries, move messages to this queue. */
  deadLetter?: DeadLetterSettings;
}

/** One vector/full-text index. Dimensions, metric, and language can't change after creation. */
export type VectorIndexConfig = VectorIndexInput;

export interface MybaseConfig {
  /** The mybase project these jobs belong to. */
  project: string;
  cron?: {
    /** Where your app is reachable from the mybase server, e.g. `https://shop.example.com`. */
    baseUrl: string;
    jobs: Record<string, CronJobConfig>;
  };
  ratelimit?: {
    rules: Record<string, RateLimitRuleConfig>;
  };
  queue?: {
    queues: Record<string, QueueConfig>;
  };
  vector?: {
    indexes: Record<string, VectorIndexConfig>;
  };
}

/** Identity function that types `mybase.config.ts`. */
export function defineConfig<const C extends MybaseConfig>(config: C): C {
  return config;
}

export const DEFAULT_CRON_PATH = "/api/cron";

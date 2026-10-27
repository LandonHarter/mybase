// The analytics service: page views, custom events, and errors sent by a project's apps.
// analytics-ingest.ts takes events in; this module turns the service on and off, holds its
// settings, and answers the dashboard's questions.
import {
  ANALYTICS_RANGES,
  type AnalyticsCount,
  type AnalyticsErrorGroup,
  type AnalyticsEventRecord,
  type AnalyticsOverview,
  type AnalyticsRange,
  type AnalyticsSettings,
  type AnalyticsTotals,
} from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { dropBuffered, flushAnalytics, forgetIngestConfig } from "./analytics-ingest";
import { newToken } from "./auth-http";
import { BadRequestError, NotFoundError } from "./errors";
import { sql } from "./postgres";
import type { ServiceModule } from "./services";

const publicApiUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const newWriteKey = () => newToken("mba_");

export const analyticsService: ServiceModule = {
  id: "analytics",
  async enable(project, log) {
    await sql`insert into mybase.analytics_projects (project, write_key) values (${project}, ${newWriteKey()}) on conflict do nothing`;
    forgetIngestConfig(project);
    log.info("analytics enabled");
  },
  async disable(project, log) {
    dropBuffered(project);
    // Cascades to every event.
    await sql`delete from mybase.analytics_projects where project = ${project}`;
    forgetIngestConfig(project);
    log.info("analytics disabled");
  },
};

async function requireEnabled(project: string) {
  const rows = await sql`select 1 from mybase.analytics_projects where project = ${project}`;
  if (rows.length === 0) throw new NotFoundError("analytics is not enabled for this project");
}

// ---- settings ---------------------------------------------------------------

export async function getSettings(project: string): Promise<AnalyticsSettings> {
  const [row]: { writeKey: string; allowedOrigins: string[]; retentionDays: number; createdAt: Date }[] = await sql`
    select write_key as "writeKey", allowed_origins as "allowedOrigins", retention_days as "retentionDays", created_at as "createdAt"
    from mybase.analytics_projects where project = ${project}`;
  if (!row) throw new NotFoundError("analytics is not enabled for this project");
  return {
    writeKey: row.writeKey,
    allowedOrigins: row.allowedOrigins,
    retentionDays: row.retentionDays,
    apiUrl: publicApiUrl,
    ingestUrl: `${publicApiUrl}/analytics/${project}/events`,
    scriptUrl: `${publicApiUrl}/analytics.js`,
    enabledAt: row.createdAt.toISOString(),
  };
}

/** `https://Shop.example.com/` → `https://shop.example.com`. Origins only: no paths. */
function readOrigin(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("allowedOrigins must be a list of origins");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestError(`"${value}" is not an origin. Use the form https://example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError(`"${value}" must start with http:// or https://`);
  if (url.pathname !== "/" || url.search || url.hash) throw new BadRequestError(`"${value}" must be an origin only, without a path`);
  return url.origin;
}

export async function updateSettings(project: string, body: Record<string, unknown>, log: Logger): Promise<AnalyticsSettings> {
  const current = await getSettings(project);
  let origins = current.allowedOrigins;
  if ("allowedOrigins" in body) {
    if (!Array.isArray(body.allowedOrigins)) throw new BadRequestError("allowedOrigins must be a list of origins");
    origins = [...new Set(body.allowedOrigins.map(readOrigin))];
    if (origins.length > 20) throw new BadRequestError("allow at most 20 origins");
  }
  let retention = current.retentionDays;
  if ("retentionDays" in body) {
    const n = body.retentionDays;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 365) throw new BadRequestError("retentionDays must be an integer from 1 to 365");
    retention = n as number;
  }
  await sql`update mybase.analytics_projects set allowed_origins = ${sql.array(origins, "text")}, retention_days = ${retention} where project = ${project}`;
  forgetIngestConfig(project);
  log.info("analytics settings updated", { origins: origins.length, retentionDays: retention });
  return getSettings(project);
}

/** Replaces the write key. Apps sending the old one get 401 at once. */
export async function rotateKey(project: string, log: Logger): Promise<AnalyticsSettings> {
  const rows = await sql`update mybase.analytics_projects set write_key = ${newWriteKey()} where project = ${project} returning 1`;
  if (rows.length === 0) throw new NotFoundError("analytics is not enabled for this project");
  forgetIngestConfig(project);
  log.info("analytics write key rotated");
  return getSettings(project);
}

/** Deletes every event, keeping the key and settings. */
export async function clearEvents(project: string, log: Logger) {
  await requireEnabled(project);
  dropBuffered(project);
  const result = await sql`delete from mybase.analytics_events where project = ${project}`;
  log.info("analytics events cleared", { events: result.count });
}

// ---- reports ----------------------------------------------------------------

const RANGES: Record<AnalyticsRange, { bucket: "hour" | "day"; buckets: number }> = {
  "24h": { bucket: "hour", buckets: 24 },
  "7d": { bucket: "day", buckets: 7 },
  "30d": { bucket: "day", buckets: 30 },
  "90d": { bucket: "day", buckets: 90 },
};

export function readRange(value: string | null): AnalyticsRange {
  if (value === null) return "7d";
  if (!(ANALYTICS_RANGES as readonly string[]).includes(value)) throw new BadRequestError(`range must be one of ${ANALYTICS_RANGES.join(", ")}`);
  return value as AnalyticsRange;
}

export function readTimeZone(value: string | null): string {
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new BadRequestError(`unknown time zone "${value}"`);
  }
  return value;
}

// Fixed column names for top-N lists; never from the request.
const TOP_COLUMNS = { routes: "path", referrers: "referrer", countries: "country", browsers: "browser", os: "os", devices: "device" } as const;

async function totals(project: string, from: Date, to: Date): Promise<AnalyticsTotals> {
  const [row]: AnalyticsTotals[] = await sql`
    select count(*) filter (where type = 'pageview')::int as pageviews,
           count(distinct visitor) filter (where type = 'pageview')::int as visitors,
           count(*) filter (where type = 'event')::int as events,
           count(*) filter (where type = 'error')::int as errors
    from mybase.analytics_events
    where project = ${project} and type in ('pageview', 'event', 'error') and ts >= ${from} and ts < ${to}`;
  return row!;
}

async function top(project: string, column: string, since: Date, limit: number): Promise<AnalyticsCount[]> {
  return sql.unsafe(
    `select ${column} as value, count(*)::int as count, count(distinct visitor)::int as visitors
     from mybase.analytics_events
     where project = $1 and type = 'pageview' and ts >= $2 and ${column} is not null
     group by 1 order by 2 desc, 1 limit ${limit}`,
    [project, since],
  );
}

/** Everything the Analytics page shows, for one range. Bucketed in `tz` (the viewer's zone). */
export async function overview(project: string, range: AnalyticsRange, tz: string): Promise<AnalyticsOverview> {
  await requireEnabled(project);
  // So events sent a moment ago show up.
  await flushAnalytics();
  const { bucket, buckets } = RANGES[range];
  const step = `1 ${bucket}`;
  const span = `${buckets} ${bucket}s`;
  // The range starts at the beginning of the oldest bucket, in the viewer's time zone.
  const [{ since, until, previousSince }]: { since: Date; until: Date; previousSince: Date }[] = await sql`
    select (date_trunc(${bucket}, now() at time zone ${tz}) - ${step}::interval * ${buckets - 1}) at time zone ${tz} as since,
           now() + interval '1 minute' as until,
           (date_trunc(${bucket}, now() at time zone ${tz}) - ${step}::interval * ${buckets - 1} - ${span}::interval) at time zone ${tz} as "previousSince"`;

  const [current, previous, series, routes, referrers, countries, browsers, os, devices, events, errors] = await Promise.all([
    totals(project, since, until),
    totals(project, previousSince, since),
    sql`
      with counts as (
        select date_trunc(${bucket}, ts at time zone ${tz}) as t, count(*)::int as pageviews, count(distinct visitor)::int as visitors
        from mybase.analytics_events
        where project = ${project} and type = 'pageview' and ts >= ${since}
        group by 1
      )
      select to_char(b.t, 'YYYY-MM-DD"T"HH24:MI') as t, coalesce(c.pageviews, 0) as pageviews, coalesce(c.visitors, 0) as visitors
      from generate_series(date_trunc(${bucket}, ${since}::timestamptz at time zone ${tz}), date_trunc(${bucket}, now() at time zone ${tz}), ${step}::interval) b(t)
      left join counts c on c.t = b.t
      order by b.t` as Promise<AnalyticsOverview["series"]>,
    top(project, TOP_COLUMNS.routes, since, 10),
    top(project, TOP_COLUMNS.referrers, since, 10),
    top(project, TOP_COLUMNS.countries, since, 10),
    top(project, TOP_COLUMNS.browsers, since, 10),
    top(project, TOP_COLUMNS.os, since, 10),
    top(project, TOP_COLUMNS.devices, since, 3),
    sql`
      select name as value, count(*)::int as count, count(distinct visitor)::int as visitors
      from mybase.analytics_events
      where project = ${project} and type = 'event' and ts >= ${since}
      group by 1 order by 2 desc, 1 limit 20` as Promise<AnalyticsCount[]>,
    sql`
      select fingerprint, (array_agg(name order by ts desc))[1] as message, count(*)::int as count,
             count(distinct visitor)::int as visitors, max(ts) as "lastSeen"
      from mybase.analytics_events
      where project = ${project} and type = 'error' and ts >= ${since}
      group by 1 order by count desc, "lastSeen" desc limit 10` as Promise<(Omit<AnalyticsErrorGroup, "lastSeen"> & { lastSeen: Date })[]>,
  ]);

  return {
    range,
    bucket,
    since: since.toISOString(),
    totals: current,
    previous,
    series: [...series],
    routes: [...routes],
    referrers: [...referrers],
    countries: [...countries],
    browsers: [...browsers],
    os: [...os],
    devices: [...devices],
    events: [...events],
    errors: errors.map((e) => ({ ...e, lastSeen: e.lastSeen.toISOString() })),
  };
}

export interface EventFilter {
  type: "pageview" | "event" | "error" | null;
  /** Custom event name. */
  name: string | null;
  /** Error group. */
  fingerprint: string | null;
  limit: number;
}

/** Recent events, newest first. */
export async function listEvents(project: string, filter: EventFilter): Promise<AnalyticsEventRecord[]> {
  await requireEnabled(project);
  await flushAnalytics();
  const rows: (Omit<AnalyticsEventRecord, "ts"> & { ts: Date })[] = await sql`
    select id::text, type, name, path, referrer, country, browser, os, device, props, stack, fingerprint, visitor, ts
    from mybase.analytics_events
    where project = ${project}
      and (${filter.type}::text is null or type = ${filter.type})
      and (${filter.name}::text is null or name = ${filter.name})
      and (${filter.fingerprint}::text is null or fingerprint = ${filter.fingerprint})
    order by ts desc, id desc
    limit ${filter.limit}`;
  return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
}

// ---- script tag -------------------------------------------------------------

let script: Promise<string> | null = null;

/**
 * The script-tag build of the SDK client (`/analytics.js`). The Docker image ships it prebuilt
 * (`ANALYTICS_SCRIPT`); in development it's built from the SDK source on first request.
 */
export function analyticsScript(): Promise<string> {
  script ??= (async () => {
    if (process.env.ANALYTICS_SCRIPT) return Bun.file(process.env.ANALYTICS_SCRIPT).text();
    const result = await Bun.build({
      entrypoints: [new URL("../../../packages/sdk/src/analytics-script.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
      minify: true,
    });
    if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "analytics.js build failed");
    return result.outputs[0].text();
  })().catch((err) => {
    script = null;
    throw err;
  });
  return script;
}

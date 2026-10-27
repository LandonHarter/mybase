// The control plane's own tables, in a `mybase` schema of the shared `postgres` database.
// Projects themselves are still registered by database comment (postgres.ts); this holds
// what doesn't fit there: cron jobs and tasks, the admin account and its sessions/tokens, analytics,
// the cache/ratelimit secrets and rules, and queues with their messages.
//
// Migrations are append-only: never edit one that has shipped, add a new one.
import type { Logger } from "@mybase/shared/logger";
import { sql } from "./postgres";

const MIGRATIONS: string[] = [
  // 1: cron service
  `
  create table mybase.cron_projects (
    project text primary key,
    secret text not null,
    rotated_at timestamptz not null default now()
  );
  create table mybase.cron_jobs (
    id uuid primary key default gen_random_uuid(),
    project text not null references mybase.cron_projects on delete cascade,
    name text not null,
    schedule text not null,
    timezone text not null default 'UTC',
    url text not null,
    payload jsonb,
    timeout_ms int not null default 30000,
    retries int not null default 2,
    enabled boolean not null default true,
    source text not null check (source in ('dashboard', 'code')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project, name)
  );
  create table mybase.cron_runs (
    id uuid primary key,
    job_id uuid not null references mybase.cron_jobs on delete cascade,
    trigger text not null check (trigger in ('schedule', 'manual')),
    status text not null check (status in ('success', 'failed')),
    attempts int not null,
    http_status int,
    duration_ms int not null,
    error text,
    response text,
    scheduled_at timestamptz not null,
    started_at timestamptz not null,
    finished_at timestamptz not null
  );
  create index on mybase.cron_runs (job_id, started_at desc);
  `,
  // 2: admin auth. Tokens are stored as SHA-256 hashes, never in plain text.
  `
  create table mybase.admin (
    id int primary key default 1 check (id = 1),
    username text not null,
    password_hash text not null,
    created_at timestamptz not null default now(),
    password_changed_at timestamptz not null default now()
  );
  create table mybase.sessions (
    token_hash text primary key,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    last_seen_at timestamptz not null default now()
  );
  create table mybase.api_tokens (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  );
  `,
  // 3: one-off cron tasks (cron-tasks.ts). Finished ones are pruned after 7 days.
  `
  create table mybase.cron_tasks (
    id uuid primary key default gen_random_uuid(),
    project text not null references mybase.cron_projects on delete cascade,
    job text not null,
    key text,
    url text not null,
    payload jsonb,
    run_at timestamptz not null,
    timeout_ms int not null,
    retries int not null,
    status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failed', 'cancelled')),
    attempts int not null default 0,
    http_status int,
    duration_ms int,
    error text,
    response text,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz
  );
  create index on mybase.cron_tasks (run_at) where status = 'pending';
  create index on mybase.cron_tasks (project, created_at desc);
  create unique index on mybase.cron_tasks (project, key) where key is not null and status in ('pending', 'running');
  `,
  // 4: analytics (analytics.ts, analytics-ingest.ts). The write key is public by design.
  // Visitors are a hash of a daily salt, IP, and user agent; IPs are never stored.
  `
  create table mybase.analytics_projects (
    project text primary key,
    write_key text not null unique,
    allowed_origins text[] not null default '{}',
    retention_days int not null default 90,
    created_at timestamptz not null default now()
  );
  create table mybase.analytics_salts (
    day date primary key,
    salt text not null
  );
  create table mybase.analytics_events (
    id bigint generated always as identity primary key,
    project text not null references mybase.analytics_projects on delete cascade,
    type text not null check (type in ('pageview', 'event', 'error')),
    name text,
    path text,
    referrer text,
    country text,
    browser text,
    os text,
    device text check (device in ('desktop', 'mobile', 'tablet')),
    visitor text not null,
    fingerprint text,
    props jsonb,
    stack text,
    ts timestamptz not null default now()
  );
  create index on mybase.analytics_events (project, type, ts);
  create index on mybase.analytics_events (ts);
  `,
  // 5: cache and rate limits (cache.ts, ratelimit.ts). Data lives in Valkey; these hold
  // SHA-256 hashes of the cache password and the rate limit key, never the secrets.
  `
  create table mybase.cache_projects (
    project text primary key,
    password_hash text not null,
    created_at timestamptz not null default now(),
    rotated_at timestamptz not null default now()
  );
  create table mybase.ratelimit_projects (
    project text primary key,
    key_hash text not null unique,
    key_hint text not null,
    created_at timestamptz not null default now(),
    rotated_at timestamptz not null default now()
  );
  create table mybase.ratelimit_rules (
    id uuid primary key default gen_random_uuid(),
    project text not null references mybase.ratelimit_projects on delete cascade,
    name text not null,
    algorithm text not null check (algorithm in ('sliding', 'fixed', 'token')),
    "limit" int not null,
    window_ms int not null,
    burst int,
    source text not null check (source in ('dashboard', 'code')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project, name)
  );
  `,
  // 6: queues (queue.ts). (The app key columns went in 7.) A message is in flight
  // while `receipt` is set and `visible_at` is in the future; `seq` orders FIFO queues.
  `
  create table mybase.queue_projects (
    project text primary key,
    key_hash text not null unique,
    key_hint text not null,
    created_at timestamptz not null default now(),
    rotated_at timestamptz not null default now()
  );
  create table mybase.queues (
    id uuid primary key default gen_random_uuid(),
    project text not null references mybase.queue_projects on delete cascade,
    name text not null,
    fifo boolean not null,
    visibility_timeout_ms int not null,
    delay_ms int not null,
    retention_ms bigint not null,
    max_message_bytes int not null,
    receive_wait_ms int not null,
    content_dedup boolean not null default false,
    dead_letter_id uuid references mybase.queues on delete set null,
    max_receives int,
    source text not null check (source in ('dashboard', 'code', 'api')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project, name)
  );
  create table mybase.queue_messages (
    id uuid primary key,
    queue_id uuid not null references mybase.queues on delete cascade,
    seq bigint generated always as identity,
    body text not null,
    attributes jsonb,
    group_id text,
    dedup_id text,
    visible_at timestamptz not null,
    expires_at timestamptz not null,
    receive_count int not null default 0,
    receipt text,
    sent_at timestamptz not null default now(),
    first_received_at timestamptz,
    dead_lettered_from uuid
  );
  create index on mybase.queue_messages (queue_id, visible_at, seq);
  create index on mybase.queue_messages (queue_id, group_id, seq) where group_id is not null;
  create index on mybase.queue_messages (expires_at);
  create table mybase.queue_dedup (
    queue_id uuid not null references mybase.queues on delete cascade,
    dedup_id text not null,
    message_id uuid not null,
    seq bigint not null,
    expires_at timestamptz not null,
    primary key (queue_id, dedup_id)
  );
  create table mybase.queue_stats (
    queue_id uuid not null references mybase.queues on delete cascade,
    hour timestamptz not null,
    sent int not null default 0,
    received int not null default 0,
    deleted int not null default 0,
    dead int not null default 0,
    primary key (queue_id, hour)
  );
  `,
  // 7: scoped API keys (permissions.ts). Tokens from before keep full access. They replace the
  // queue and rate limit app keys.
  `
  alter table mybase.api_tokens add column permissions text[] not null default '{admin}', add column projects text[];
  alter table mybase.ratelimit_projects drop column key_hash, drop column key_hint, drop column rotated_at;
  alter table mybase.queue_projects drop column key_hash, drop column key_hint, drop column rotated_at;
  `,
];

/** Brings the `mybase` schema up to date. Safe to run on every boot. */
export async function migrate(log: Logger) {
  await sql.begin(async (tx) => {
    // Serializes concurrent boots; released at commit.
    await tx`select pg_advisory_xact_lock(hashtext('mybase.migrate'))`;
    await tx`create schema if not exists mybase`;
    await tx`create table if not exists mybase.migrations (version int primary key, applied_at timestamptz not null default now())`;
    const [{ version }]: { version: number }[] = await tx`select coalesce(max(version), 0)::int as version from mybase.migrations`;
    for (let v = version + 1; v <= MIGRATIONS.length; v++) {
      await tx.unsafe(MIGRATIONS[v - 1]!);
      await tx`insert into mybase.migrations (version) values (${v})`;
      log.info("migration applied", { version: v });
    }
  });
}

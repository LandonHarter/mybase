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
  // 8: web search (search.ts). Results and pages are cached in Valkey, so this only records who has it on.
  `
  create table mybase.search_projects (
    project text primary key,
    created_at timestamptz not null default now()
  );
  `,
  // 9: secrets (secrets.ts). Values are AES-GCM ciphertexts under a per-project data key,
  // itself wrapped with MYBASE_SECRETS_KEY (secrets-crypto.ts). Every change is a revision;
  // its changes keep the old and new ciphertexts, so restoring copies them back.
  `
  create table mybase.secrets_projects (
    project text primary key,
    wrapped_key bytea not null,
    master_id bytea not null,
    linked_envs text[] not null default '{}',
    created_at timestamptz not null default now()
  );
  create table mybase.secrets_envs (
    id bigserial primary key,
    project text not null references mybase.secrets_projects on delete cascade,
    name text not null,
    parent_id bigint references mybase.secrets_envs on delete cascade,
    revision int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project, name)
  );
  create table mybase.secrets_values (
    env_id bigint not null references mybase.secrets_envs on delete cascade,
    key text not null,
    value bytea not null,
    managed boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (env_id, key)
  );
  create table mybase.secrets_revisions (
    env_id bigint not null references mybase.secrets_envs on delete cascade,
    revision int not null,
    actor text not null,
    message text,
    created_at timestamptz not null default now(),
    primary key (env_id, revision)
  );
  create table mybase.secrets_changes (
    env_id bigint not null,
    revision int not null,
    key text not null,
    old_value bytea,
    new_value bytea,
    managed boolean not null default false,
    primary key (env_id, revision, key),
    foreign key (env_id, revision) references mybase.secrets_revisions on delete cascade
  );
  alter table mybase.api_tokens add column environments text[];
  `,
  // 10: vector search (vector.ts). Documents live in each project's own database (schema
  // `mybase_vector`, one table per index); this keeps the settings. `embed_key` is the embedding
  // provider's API key, AES-GCM under MYBASE_SECRETS_KEY.
  `
  create table mybase.vector_projects (
    project text primary key,
    embed_url text,
    embed_model text,
    embed_dims int,
    embed_key bytea,
    embed_key_master bytea,
    created_at timestamptz not null default now()
  );
  create table mybase.vector_indexes (
    project text not null references mybase.vector_projects on delete cascade,
    name text not null,
    dimensions int,
    metric text not null check (metric in ('cosine', 'l2', 'ip')),
    language text not null,
    embed boolean not null default false,
    source text not null check (source in ('dashboard', 'code', 'api')),
    created_at timestamptz not null default now(),
    primary key (project, name)
  );
  `,
  // 11: admin 2FA (auth.ts, totp.ts). The TOTP secret can't be hashed (codes are computed from it), so
  // it's AES-GCM under MYBASE_SECRETS_KEY when that's set (`secret_master` = its id), plain otherwise.
  // `enabled_at` null = set up but not confirmed yet. Recovery codes are random, so sha256 is enough.
  `
  create table mybase.admin_totp (
    id int primary key default 1 check (id = 1) references mybase.admin on delete cascade,
    secret bytea not null,
    secret_master bytea,
    enabled_at timestamptz,
    last_step bigint not null default 0
  );
  create table mybase.admin_recovery_codes (
    code_hash text primary key,
    used_at timestamptz
  );
  `,
  // 12: audit log (audit.ts). Buffered writes; pruned hourly past `retention_days`. IPs are kept
  // (it's a security log), secret values and SQL text never are.
  `
  create table mybase.audit_events (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    actor_kind text not null check (actor_kind in ('session', 'token', 'anonymous', 'system')),
    actor_id text,
    actor_name text,
    ip text,
    action text not null,
    outcome text not null check (outcome in ('ok', 'denied', 'failed')),
    project text,
    target text,
    meta jsonb,
    request_id text
  );
  create index on mybase.audit_events (at);
  create index on mybase.audit_events (project, id desc);
  create index on mybase.audit_events (action, id desc);
  create table mybase.audit_settings (
    id int primary key default 1 check (id = 1),
    retention_days int not null default 90 check (retention_days between 7 and 365)
  );
  `,
  // 13: security alerts (alerts.ts). Webhook secrets sign calls (stored, like cron secrets);
  // ntfy tokens are AES-GCM under MYBASE_SECRETS_KEY when set (`token_master` = its id).
  // Rules are on unless a row turns them off.
  `
  create table mybase.alert_channels (
    id uuid primary key,
    name text not null,
    kind text not null check (kind in ('webhook', 'ntfy')),
    url text not null,
    enabled boolean not null default true,
    secret text,
    token bytea,
    token_master bytea,
    created_at timestamptz not null default now(),
    last_sent_at timestamptz,
    last_error text
  );
  create table mybase.alert_rules (
    rule text primary key,
    enabled boolean not null
  );
  create table mybase.alert_state (
    key text primary key,
    value jsonb not null
  );
  `,
  // 14: users (users.ts). Better Auth's own tables live in each project's database (schema auth);
  // this only records which projects have the service on.
  `
  create table mybase.users_projects (
    project text primary key,
    created_at timestamptz not null default now()
  );
  `,
  // 15: captcha (captcha.ts). hmac_key signs challenges (never leaves the server); secret lets an
  // app's server check tokens, so it's shown and stored like the cron secret.
  `
  create table mybase.captcha_projects (
    project text primary key,
    hmac_key bytea not null,
    secret text not null,
    max_number int not null,
    created_at timestamptz not null default now()
  );
  `,
  // 16: public Postgres (db-public.ts). The ACME account key and the certificate's private key
  // are sealed with MYBASE_SECRETS_KEY when it's set (`master` = its id), else stored as is.
  `
  create table mybase.db_public (
    id int primary key default 1 check (id = 1),
    directory text not null,
    account_key bytea not null,
    account_url text,
    host text,
    cert_pem text,
    cert_key bytea,
    not_after timestamptz,
    issued_at timestamptz,
    master bytea,
    ip text,
    ip_changed_at timestamptz
  );
  `,
  // 17: the API key `mybase secrets link` keeps in linked envs (MYBASE_API_KEY).
  `
  alter table mybase.secrets_projects add column linked_token uuid references mybase.api_tokens on delete set null;
  `,
  // 18: realtime (realtime.ts). secret signs browser tokens and webhook calls, so it's stored and
  // shown like the cron secret. Connections, channels, and stats live in memory only.
  `
  create table mybase.realtime_projects (
    project text primary key,
    secret text not null,
    max_connections int not null,
    max_channels int not null,
    max_message_bytes int not null,
    max_rate int not null,
    public_channels boolean not null default true,
    allowed_origins text[] not null default '{}',
    webhook_url text,
    webhook_events text[] not null default '{}',
    created_at timestamptz not null default now()
  );
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

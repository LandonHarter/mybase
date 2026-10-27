// The control plane's own tables, in a `mybase` schema of the shared `postgres` database.
// Projects themselves are still registered by database comment (postgres.ts); this holds
// what doesn't fit there: cron jobs, the admin account and its sessions/tokens.
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

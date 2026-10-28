// Public Postgres: a real postgres:// URL from anywhere, for when the router forwards the Postgres
// port to this machine (the Cloudflare Tunnel only carries HTTP). Three parts:
//  - pg_hba.conf (always): LAN/Docker/Tailscale as before; from the internet only project roles,
//    only to their own database (`sameuser`, like db-proxy.ts), and only over TLS. Superusers never.
//  - a Let's Encrypt certificate for MYBASE_DB_PUBLIC_HOST (acme.ts, dns-01 through Cloudflare),
//    renewed 30 days before expiry. Connection strings get `?sslmode=require` once it's installed.
//  - DDNS: an unproxied A record for the host, following this network's public IPv4.
// Files land in PGDATA through the superuser connection (lo_export writes them as the postgres
// user, mode 0600, which is what Postgres wants for server.key), so no shared volume is needed.
import { SQL } from "bun";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { cloudflare, DNS_TOKEN_PERMISSIONS, type Zone } from "@mybase/shared/cloudflare";
import type { DbPublicStatus } from "@mybase/shared";
import { createLogger, type Logger } from "@mybase/shared/logger";
import { importAccountKey, issueCertificate, LETS_ENCRYPT, LETS_ENCRYPT_STAGING, newAccountKey } from "./acme";
import { audit } from "./audit";
import { pgAddress, PROJECT_GROUP, setPublicTls, sql } from "./postgres";
import { secretsMaster } from "./secrets";
import { openBlob, sameId, sealBlob } from "./secrets-crypto";

const log = createLogger("db-public");

const DAY = 86_400_000;
const RENEW_BEFORE = 30 * DAY;
const CHECK_EVERY = 12 * 3_600_000;
const BACKOFF = [3_600_000, 6 * 3_600_000, DAY];
const DNS_EVERY = 5 * 60_000;
const KEY_AAD = "dbpublic\0key";

// ---- config ----------------------------------------------------------------

export interface DbPublicConfig {
  host: string;
  token: string;
  email?: string;
  staging: boolean;
}

const truthy = (v: string | undefined) => /^(1|on|true|yes)$/i.test(v?.trim() ?? "");

/** The config from env, or why it can't be used. */
export function readConfig(env: Record<string, string | undefined>): { enabled: boolean; config: DbPublicConfig | null; problem: string | null } {
  const enabled = truthy(env.MYBASE_DB_PUBLIC);
  if (!enabled) return { enabled, config: null, problem: null };
  const host = (env.MYBASE_DB_PUBLIC_HOST ?? "").trim().toLowerCase();
  if (!host || host === "localhost" || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return { enabled, config: null, problem: "MYBASE_DB_PUBLIC_HOST must be a DNS name on your Cloudflare zone, like db.example.com" };
  }
  const token = env.MYBASE_DNS_TOKEN?.trim();
  if (!token) return { enabled, config: null, problem: `MYBASE_DNS_TOKEN is missing (a Cloudflare token with ${DNS_TOKEN_PERMISSIONS.join(" + ")})` };
  return { enabled, config: { host, token, email: env.MYBASE_ACME_EMAIL?.trim() || undefined, staging: truthy(env.MYBASE_ACME_STAGING) }, problem: null };
}

// ---- pg_hba.conf -----------------------------------------------------------

const MANAGED = "# Managed by mybase (db-public.ts): rewritten on boot. Remove this line to manage it yourself.";

/** LAN, Docker networks, Tailscale (CGNAT range), IPv6 ULA and link-local. */
const PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7", "fe80::/10"];

/** With `ssl` off Postgres rejects hostssl lines, so the internet gets nothing until a cert is in. */
export function pgHba(ssl: boolean): string {
  return [
    MANAGED,
    "# TYPE  DATABASE     USER              ADDRESS          METHOD",
    "local   all          all                                trust",
    "local   replication  all                                trust",
    "host    all          all               127.0.0.1/32     trust",
    "host    all          all               ::1/128          trust",
    ...PRIVATE_NETS.map((net) => `host    all          all               ${net.padEnd(16)} scram-sha-256`),
    ...(ssl
      ? [
          "# The internet: a project role, to its own database, over TLS.",
          `hostssl sameuser     +${PROJECT_GROUP.padEnd(16)} 0.0.0.0/0        scram-sha-256`,
          `hostssl sameuser     +${PROJECT_GROUP.padEnd(16)} ::/0             scram-sha-256`,
        ]
      : []),
    "host    all          all               all              reject",
    "",
  ].join("\n");
}

/** Whether we may replace this file: ours already, or the official image's default. */
export const replaceableHba = (text: string) =>
  text.includes(MANAGED) || /^host\s+all\s+all\s+all\s+scram-sha-256\s*$/m.test(text) || /^host\s+all\s+all\s+all\s+md5\s*$/m.test(text);

/**
 * Writes `data` to `path` on the Postgres server, as the postgres user. lo_export creates files
 * 0644, which Postgres refuses for server.key, so a `secret` file is first made empty and 0600
 * (COPY TO PROGRAM runs as postgres): lo_export truncates it and keeps the mode.
 */
async function writeServerFile(path: string, data: string | Uint8Array, secret = false) {
  const bytes = Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data);
  if (secret) {
    // Spliced into a SQL literal and a shell command: settings-derived, but checked anyway.
    if (!/^[\w./-]+$/.test(path)) throw new Error(`unexpected path for ${path.split("/").pop()}`);
    await sql.unsafe(`copy (select 1) to program 'rm -f ${path} && umask 077 && touch ${path} && chmod 600 ${path}'`);
  }
  await sql.begin(async (tx) => {
    const [{ oid }]: { oid: number }[] = await tx`select lo_from_bytea(0, ${bytes}) as oid`;
    await tx`select lo_export(${oid}, ${path})`;
    await tx`select lo_unlink(${oid})`;
  });
}

const readServerFile = async (path: string): Promise<string | null> =>
  ((await sql`select pg_read_file(${path}, 0, 1048576, true) as text`) as { text: string | null }[])[0]?.text ?? null;

async function ensureProjectGroup() {
  await sql.unsafe(`do $$ begin create role ${PROJECT_GROUP} nologin; exception when duplicate_object then null; end $$`);
  const missing: { name: string }[] = await sql`
    select r.rolname as name from pg_roles r
    join pg_database d on d.datname = r.rolname
    where shobj_description(d.oid, 'pg_database') like '{"mybase":%'
      and not exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid where g.rolname = ${PROJECT_GROUP} and m.member = r.oid)`;
  // Names come from project databases, which all match PROJECT_NAME_PATTERN.
  for (const { name } of missing) await sql.unsafe(`grant ${PROJECT_GROUP} to "${name}"`);
  if (missing.length) log.info("project roles added to group", { group: PROJECT_GROUP, count: missing.length });
}

/** Installs our pg_hba.conf if it isn't already, checking it parses before reloading. */
async function applyHba() {
  const [{ path }]: { path: string }[] = await sql`select setting as path from pg_settings where name = 'hba_file'`;
  const current = (await readServerFile(path)) ?? "";
  const [{ ssl }]: { ssl: string }[] = await sql`select setting as ssl from pg_settings where name = 'ssl'`;
  const wanted = pgHba(ssl === "on");
  if (current === wanted) return;
  if (!replaceableHba(current)) {
    log.warn("pg_hba.conf has custom rules, leaving it alone", { path });
    return;
  }
  await writeServerFile(path, wanted);
  const [{ errors }]: { errors: number }[] = await sql`select count(*)::int as errors from pg_hba_file_rules where error is not null`;
  if (errors > 0) {
    await writeServerFile(path, current);
    log.error("new pg_hba.conf didn't parse, kept the old one", { path, errors });
    return;
  }
  await sql`select pg_reload_conf()`;
  log.info("pg_hba.conf updated", { path });
}

// ---- state -----------------------------------------------------------------

interface Row {
  directory: string;
  account_key: Buffer;
  account_url: string | null;
  host: string | null;
  cert_pem: string | null;
  cert_key: Buffer | null;
  not_after: Date | null;
  issued_at: Date | null;
  master: Buffer | null;
  ip: string | null;
  ip_changed_at: Date | null;
}

const loadRow = async (): Promise<Row | null> => ((await sql`select * from mybase.db_public where id = 1`) as Row[])[0] ?? null;

/** Reads a stored secret; null when it was sealed with a master we don't have now. */
async function unseal(row: Row, blob: Buffer): Promise<Uint8Array | null> {
  if (!row.master) return new Uint8Array(blob);
  const master = secretsMaster();
  if (!master || !sameId(master.id, row.master)) return null;
  return openBlob(master, blob, KEY_AAD);
}

async function seal(data: Uint8Array): Promise<{ blob: Buffer; master: Buffer | null }> {
  const master = secretsMaster();
  if (!master) return { blob: Buffer.from(data), master: null };
  return { blob: Buffer.from(await sealBlob(master, data, KEY_AAD)), master: Buffer.from(master.id) };
}

const status = {
  tlsActive: false,
  notAfter: null as Date | null,
  issuedAt: null as Date | null,
  tlsError: null as string | null,
  nextAttemptAt: null as Date | null,
  ip: null as string | null,
  dnsCheckedAt: null as Date | null,
  dnsError: null as string | null,
};

let config: ReturnType<typeof readConfig> = { enabled: false, config: null, problem: null };

export function dbPublicStatus(): DbPublicStatus {
  return {
    enabled: config.enabled,
    problem: config.problem,
    host: process.env.MYBASE_DB_PUBLIC_HOST ?? "localhost",
    port: Number(process.env.MYBASE_DB_PUBLIC_PORT ?? process.env.POSTGRES_PORT ?? 5432),
    tls: {
      active: status.tlsActive,
      notAfter: status.notAfter?.toISOString() ?? null,
      issuedAt: status.issuedAt?.toISOString() ?? null,
      staging: config.config?.staging ?? false,
      error: status.tlsError,
      nextAttemptAt: status.nextAttemptAt?.toISOString() ?? null,
    },
    dns: { ip: status.ip, checkedAt: status.dnsCheckedAt?.toISOString() ?? null, error: status.dnsError },
  };
}

// ---- certificate -----------------------------------------------------------

/** Throws unless the key matches the leaf certificate, which names `host` and hasn't expired. */
export function checkCertificate(certPem: string, keyPem: string, host: string, now = Date.now()): Date {
  const cert = new X509Certificate(certPem);
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("certificate and key don't match");
  if (!cert.checkHost(host)) throw new Error(`certificate isn't for ${host}`);
  const notAfter = new Date(cert.validTo);
  if (notAfter.getTime() <= now) throw new Error("certificate has expired");
  return notAfter;
}

/** Whether Postgres answers a TLS handshake now (a reload with a bad key keeps TLS off, silently). */
async function tlsWorks(): Promise<boolean> {
  const probe = new SQL({
    hostname: pgAddress.host,
    port: pgAddress.port,
    username: process.env.POSTGRES_USER ?? "mybase",
    password: process.env.POSTGRES_PASSWORD ?? "change-me",
    database: "postgres",
    max: 1,
    // Only checks that TLS is on; the API's own connections don't use it.
    tls: { rejectUnauthorized: false },
  });
  try {
    const [row]: { ssl: boolean }[] = await probe`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
    return row?.ssl === true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

/** Puts the cert into PGDATA (unless it's already there) and turns TLS on. Throws if Postgres won't load it. */
export async function installCertificate(certPem: string, keyPem: string, rewrite = false) {
  const [{ dir }]: { dir: string }[] = await sql`select setting as dir from pg_settings where name = 'data_directory'`;
  const certPath = `${dir}/server.crt`;
  const keyPath = `${dir}/server.key`;
  const [{ key }]: { key: boolean }[] = await sql`select pg_stat_file(${keyPath}, true) is not null as key`;
  const same = !rewrite && key && (await readServerFile(certPath)) === certPem;
  if (!same) {
    // Key first: Postgres only reads them at reload, and a cert without its key would fail it.
    await writeServerFile(keyPath, keyPem, true);
    await writeServerFile(certPath, certPem);
  }
  const [{ ssl }]: { ssl: string }[] = await sql`select setting as ssl from pg_settings where name = 'ssl'`;
  // ALTER SYSTEM can't run in a transaction, and it rewrites postgresql.auto.conf: only when needed.
  if (ssl !== "on") await sql.unsafe("alter system set ssl = on");
  if (!same || ssl !== "on") {
    await sql`select pg_reload_conf()`;
    log.info("certificate installed", { replaced: !same });
  }
  // Reloads reach backends between statements; give the postmaster a moment.
  if (!same || ssl !== "on") await Bun.sleep(500);
  if (!(await tlsWorks())) {
    // Files from an older install (wrong mode, say): write them again, once.
    if (same) return installCertificate(certPem, keyPem, true);
    throw new Error("Postgres didn't load the certificate (see the postgres container's log)");
  }
  // Now that TLS is on, the internet's hostssl lines can go in.
  await applyHba();
}

let zone: Zone | null = null;

async function zoneFor(cfg: DbPublicConfig): Promise<Zone> {
  if (zone) return zone;
  const found = await cloudflare(cfg.token, fetch, DNS_TOKEN_PERMISSIONS).zoneFor(cfg.host);
  if (!found) throw new Error(`no active Cloudflare zone for ${cfg.host} that MYBASE_DNS_TOKEN can see`);
  zone = found;
  return found;
}

async function issue(cfg: DbPublicConfig, row: Row | null) {
  const directory = cfg.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT;
  // A new account when switching between staging and production, or when the stored key can't be read.
  const storedKey = row && row.directory === directory ? await unseal(row, row.account_key) : null;
  const account = storedKey ? await importAccountKey(JSON.parse(new TextDecoder().decode(storedKey))) : await newAccountKey();
  const cf = cloudflare(cfg.token, fetch, DNS_TOKEN_PERMISSIONS);
  const { id: zoneId } = await zoneFor(cfg);

  log.info("requesting certificate", { host: cfg.host, staging: cfg.staging });
  const issued = await issueCertificate({
    directory,
    host: cfg.host,
    account,
    accountUrl: storedKey ? row!.account_url : null,
    email: cfg.email,
    async setTxt(name, value) {
      const record = await cf.createRecord(zoneId, { type: "TXT", name, content: value, ttl: 60, comment: "mybase ACME challenge" });
      return async () => {
        await cf.deleteRecord(zoneId, record.id);
      };
    },
  });
  checkCertificate(issued.certPem, issued.keyPem, cfg.host);

  const accountKey = await seal(new TextEncoder().encode(JSON.stringify(account.jwk)));
  const certKey = await seal(new TextEncoder().encode(issued.keyPem));
  // Both blobs were sealed with the same master (or neither), so one `master` column covers them.
  await sql`
    insert into mybase.db_public (id, directory, account_key, account_url, host, cert_pem, cert_key, not_after, issued_at, master)
    values (1, ${directory}, ${accountKey.blob}, ${issued.accountUrl}, ${cfg.host}, ${issued.certPem}, ${certKey.blob}, ${issued.notAfter}, now(), ${certKey.master})
    on conflict (id) do update set directory = excluded.directory, account_key = excluded.account_key, account_url = excluded.account_url,
      host = excluded.host, cert_pem = excluded.cert_pem, cert_key = excluded.cert_key, not_after = excluded.not_after,
      issued_at = excluded.issued_at, master = excluded.master`;
  await installCertificate(issued.certPem, issued.keyPem);
  status.notAfter = issued.notAfter;
  status.issuedAt = new Date();
  log.info("certificate issued", { host: cfg.host, notAfter: issued.notAfter.toISOString() });
  audit({ action: "database.public_cert_issued", target: cfg.host, meta: { staging: cfg.staging, notAfter: issued.notAfter.toISOString() } });
}

/** Installs the stored cert when it's still good; returns whether it's due for renewal. */
async function restoreStored(cfg: DbPublicConfig, row: Row | null): Promise<boolean> {
  if (!row?.cert_pem || !row.cert_key || row.host !== cfg.host) return true;
  if (row.directory !== (cfg.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT)) return true;
  const key = await unseal(row, row.cert_key);
  if (!key) {
    log.warn("stored certificate key is sealed with another MYBASE_SECRETS_KEY, requesting a new one");
    return true;
  }
  const keyPem = new TextDecoder().decode(key);
  try {
    status.notAfter = checkCertificate(row.cert_pem, keyPem, cfg.host);
  } catch (err) {
    log.warn("stored certificate unusable", { err: (err as Error).message });
    return true;
  }
  status.issuedAt = row.issued_at;
  await installCertificate(row.cert_pem, keyPem);
  return status.notAfter.getTime() - Date.now() < RENEW_BEFORE;
}

let failures = 0;
let certTimer: Timer | null = null;

async function certTick(cfg: DbPublicConfig) {
  let next = CHECK_EVERY;
  try {
    const row = await loadRow();
    const due = await restoreStored(cfg, row);
    if (due) await issue(cfg, row);
    // Only now: before a cert is installed, `sslmode=require` would break every new connection string.
    status.tlsActive = true;
    setPublicTls(true);
    status.tlsError = null;
    failures = 0;
  } catch (err) {
    next = BACKOFF[Math.min(failures, BACKOFF.length - 1)]!;
    failures++;
    status.tlsError = (err as Error).message;
    log.error("certificate check failed", { host: cfg.host, retryInMin: Math.round(next / 60_000), err });
    audit({ action: "database.public_cert_failed", outcome: "failed", target: cfg.host, meta: { error: status.tlsError } });
    // A cert that's still installed and valid keeps working while we retry.
    const valid = status.notAfter !== null && status.notAfter.getTime() > Date.now();
    status.tlsActive = valid;
    setPublicTls(valid);
  }
  status.nextAttemptAt = new Date(Date.now() + next);
  certTimer = setTimeout(() => void certTick(cfg), next);
}

// ---- DDNS ------------------------------------------------------------------

/** The `ip=` line of Cloudflare's trace page, if it's an IPv4 address. */
export function parseTrace(text: string): string | null {
  const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim();
  return ip && /^(\d{1,3})(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((n) => Number(n) <= 255) ? ip : null;
}

let dnsTimer: Timer | null = null;
// What the A record is known to say; null until the first upsert this boot, so a record edited
// by hand is put back after a restart.
let published: string | null = null;

async function dnsTick(cfg: DbPublicConfig) {
  try {
    // An IPv4 literal, so the answer is the IPv4 address even on a dual-stack network.
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(10_000) });
    const ip = parseTrace(await res.text());
    if (!ip) throw new Error("couldn't read this network's public IPv4 address");
    if (ip !== published) {
      const { id: zoneId } = await zoneFor(cfg);
      await cloudflare(cfg.token, fetch, DNS_TOKEN_PERMISSIONS).upsertRecord(zoneId, {
        type: "A",
        name: cfg.host,
        content: ip,
        proxied: false,
        ttl: 60,
        comment: "mybase public Postgres (DDNS)",
      });
      const before = status.ip;
      published = ip;
      // Written only when the address changes (SD card). The row appears with the first certificate.
      await sql`update mybase.db_public set ip = ${ip}, ip_changed_at = now() where id = 1 and ip is distinct from ${ip}`;
      if (before && before !== ip) {
        log.info("public address changed", { host: cfg.host });
        audit({ action: "database.public_ip_changed", target: cfg.host });
      }
    }
    status.ip = ip;
    status.dnsError = null;
  } catch (err) {
    status.dnsError = (err as Error).message;
    log.warn("DDNS update failed", { host: cfg.host, err: status.dnsError });
  }
  status.dnsCheckedAt = new Date();
  dnsTimer = setTimeout(() => void dnsTick(cfg), DNS_EVERY);
}

// ---- boot ------------------------------------------------------------------

/** Runs at boot after migrations and the secrets master: pg_hba always, the rest when enabled. */
export async function startDbPublic(bootLog: Logger) {
  try {
    await ensureProjectGroup();
    await applyHba();
  } catch (err) {
    bootLog.error("couldn't apply pg_hba.conf", { err });
  }

  config = readConfig(process.env);
  if (!config.enabled) return;
  if (!config.config) {
    bootLog.error("public Postgres is off", { reason: config.problem });
    return;
  }
  const cfg = config.config;
  status.ip = (await loadRow())?.ip ?? null;
  bootLog.info("public Postgres on", { host: cfg.host, staging: cfg.staging });
  // Not awaited: Let's Encrypt can take a minute, and the API should serve meanwhile.
  void dnsTick(cfg);
  void certTick(cfg);
}

export function stopDbPublic() {
  if (certTimer) clearTimeout(certTimer);
  if (dnsTimer) clearTimeout(dnsTimer);
}

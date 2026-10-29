import { createHash } from "node:crypto";
import type { CreateSandbox, ExecuteSandbox, Sandbox, SandboxArtifact, SandboxExecution, SandboxUsage } from "@mybase-dev/sdk/sandbox";
import { SANDBOX_LIMITS as limits, SANDBOX_RESOURCES, executionTerminal, sandboxInteger, sandboxKey, sandboxPath, sandboxTerminal } from "@mybase/shared/sandbox";
import { createLogger } from "@mybase/shared/logger";
import { audit } from "./audit";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, TooManyRequestsError, UpstreamError } from "./errors";
import { sql, projectExists } from "./postgres";
import { file } from "./storage";
import { objectHeaders } from "./security-headers";
import type { ServiceModule } from "./services";

const log = createLogger("sandbox");
const workerUrl = process.env.MYBASE_SANDBOX_WORKER_URL?.replace(/\/$/, "");
const workerKey = process.env.MYBASE_SANDBOX_WORKER_KEY;
const publicUrl = (process.env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value: any): string | null => value ? new Date(value).toISOString() : null;
const uuid = (value: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new NotFoundError("sandbox resource not found"); return value; };
function validate<T>(fn: () => T): T { try { return fn(); } catch (err) { throw new BadRequestError((err as Error).message); } }
let admissionTail = Promise.resolve();
let waitingAdmissions = 0;
async function serialAdmission<T>(fn: () => Promise<T>): Promise<T> {
  if (waitingAdmissions >= 32) throw new TooManyRequestsError("sandbox admission busy", 1);
  waitingAdmissions++;
  const previous = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { waitingAdmissions--; release(); }
}

export const sandboxService: ServiceModule = {
  id: "sandbox",
  async enable(project) {
    await worker("/health");
    await sql`insert into mybase.sandbox_projects(project) values(${project}) on conflict do nothing`;
  },
  async disable(project) {
    const rows = await sql`select id from mybase.sandboxes where project=${project} and state not in ('terminated','failed','expired')`;
    for (const row of rows) {
      await sql`update mybase.sandboxes set state='stopping' where id=${row.id} and state not in ('terminated','expired','failed')`;
      await worker(`/boxes/${row.id}`, project, "DELETE").catch(err => { if (!(err instanceof NotFoundError)) throw err; });
      await finish(row.id, "terminated", "service_disabled");
    }
    await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtext('mybase.sandbox.admission'))`;
      const objects = await tx`select object_key from mybase.sandbox_artifacts where project=${project}`;
      for (const object of objects) await file(project, object.object_key).delete();
      await tx`delete from mybase.sandboxes where project=${project}`;
      await tx`delete from mybase.sandbox_projects where project=${project}`;
    });
  },
};
export async function requireSandbox(project: string) {
  if (!(await projectExists(project)) || !(await sql`select 1 from mybase.sandbox_projects where project=${project}`).length) throw new NotFoundError("agent sandboxes are not enabled for this project");
}
function configured() {
  if (!workerUrl || !workerKey) throw new ServiceUnavailableError("sandbox worker is not configured; see docs/sandboxes");
}
export function workerBrowserUrl(id: string, project: string) {
  configured();
  return { url: `${workerUrl}/boxes/${uuid(id)}/browser`.replace(/^http/, "ws"), headers: { Authorization: `Bearer ${workerKey}`, "x-mybase-project": project } };
}
async function worker(path: string, project?: string, method = "GET", body?: unknown, raw = false): Promise<any> {
  configured();
  let response: Response;
  try {
    response = await fetch(workerUrl + path, {
      method, headers: { Authorization: `Bearer ${workerKey}`, ...(project ? { "x-mybase-project": project } : {}), "Content-Type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body),
      signal: AbortSignal.timeout(method === "PUT" && /^\/boxes\/[^/]+$/.test(path) ? 90_000 : 20_000),
    });
  } catch { throw new ServiceUnavailableError("sandbox worker is unreachable"); }
  if (response.status === 404) throw new NotFoundError("sandbox runtime missing; worker may have restarted");
  if (response.status === 409) throw new ConflictError("sandbox workspace is busy or unavailable");
  if (response.status === 429) throw new TooManyRequestsError("sandbox worker is full", 5);
  if (!response.ok) throw new UpstreamError("sandbox worker operation failed");
  return raw ? response : response.status === 204 ? undefined : response.json();
}
function boxView(row: any): Sandbox {
  return { id: row.id, project: row.project, profile: "browser", state: row.state, reason: row.reason,
    createdAt: iso(row.created_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), expiresAt: iso(row.expires_at)!, resources: SANDBOX_RESOURCES,
    runtimeMs: row.started_at && !row.finished_at ? Math.max(0, Date.now() - +new Date(row.started_at)) : Number(row.runtime_ms), executions: row.executions, artifactBytes: Number(row.artifact_bytes) };
}
const runView = (row: any): SandboxExecution => ({ id: row.id, sandboxId: row.sandbox_id, state: row.state, exitCode: row.exit_code, stdout: row.stdout, stderr: row.stderr, truncated: row.truncated, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at) });
const artifactView = (row: any): SandboxArtifact => ({ id: row.id, sandboxId: row.sandbox_id, project: row.project, name: row.name, type: row.type, size: row.size, sha256: row.sha256, expiresAt: iso(row.expires_at)! });
async function owned(project: string, id: string) {
  const [row] = await sql`select * from mybase.sandboxes where project=${project} and id=${uuid(id)}`;
  if (!row) throw new NotFoundError("sandbox not found");
  return row;
}
export const getSandbox = async (project: string, id: string) => boxView(await owned(project, id));
export const listSandboxes = async (project: string) => (await sql`select * from mybase.sandboxes where project=${project} order by created_at desc limit 100`).map(boxView);
export async function sandboxUsage(project: string, db: typeof sql | import("bun").TransactionSQL = sql): Promise<SandboxUsage> {
  const [row] = await db`select count(*) filter(where state not in ('terminated','expired','failed'))::int as active,
    coalesce(sum(ttl_seconds) filter(where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),0)::int as allocated,
    coalesce(sum(case when started_at is not null and finished_at is null then extract(epoch from now()-started_at)*1000 else runtime_ms end)
      filter(where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),0)::bigint as runtime,
    coalesce(sum(executions) filter(where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),0)::int as executions,
    coalesce(sum(artifact_bytes) filter(where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),0)::bigint as bytes
    from mybase.sandboxes where project=${project}`;
  return { active: row.active, allocatedSecondsToday: row.allocated, runtimeMsToday: Number(row.runtime), executionsToday: row.executions, artifactBytesToday: Number(row.bytes), limits: { concurrency: limits.concurrency, dailyAllocatedSeconds: limits.dailyAllocatedSeconds, dailyArtifactBytes: limits.dailyArtifactBytes } };
}
export async function createSandbox(project: string, input: CreateSandbox) {
  configured();
  const spec = validate(() => {
    if (input.profile !== undefined && input.profile !== "browser") throw new Error("only the browser profile is supported");
    return { key: sandboxKey(input.key), ttlSeconds: sandboxInteger(input.ttlSeconds, 300, 10, 600), idleSeconds: sandboxInteger(input.idleSeconds, 120, 10, 300) };
  });
  const fingerprint = hash(spec);
  // Bound in-process waiters instead of occupying every small Postgres pool slot on the same lock.
  const result = await serialAdmission(() => sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('mybase.sandbox.admission'))`;
    const [old] = await tx`select * from mybase.sandboxes where project=${project} and key=${spec.key}`;
    if (old) { if (old.fingerprint !== fingerprint) throw new ConflictError("creation key already used with different settings"); return old; }
    const [{ active }] = await tx`select count(*)::int as active from mybase.sandboxes where state not in ('terminated','expired','failed')`;
    const usage = await sandboxUsage(project,tx);
    if (active >= limits.workers || usage.active >= limits.concurrency) throw new TooManyRequestsError("sandbox capacity reached", 5);
    if (usage.allocatedSecondsToday + spec.ttlSeconds > limits.dailyAllocatedSeconds) throw new TooManyRequestsError("daily sandbox allocation exhausted", 3600);
    const [row] = await tx`insert into mybase.sandboxes(id,project,key,fingerprint,ttl_seconds,idle_seconds,state,expires_at)
      values(${crypto.randomUUID()},${project},${spec.key},${fingerprint},${spec.ttlSeconds},${spec.idleSeconds},'queued',now()+${spec.ttlSeconds}*interval '1 second') returning *`;
    return row;
  }));
  audit({ action: "sandbox.created", project, target: result.id });
  return boxView(result);
}
export async function terminateSandbox(project: string, id: string) {
  const row = await owned(project, id);
  if (!sandboxTerminal(row.state)) await sql`update mybase.sandboxes set state='stopping',reason='requested' where id=${id} and state not in ('terminated','expired','failed')`;
  audit({ action: "sandbox.terminate_requested", project, target: id });
  return getSandbox(project, id);
}
export function executionSpec(input: ExecuteSandbox): ExecuteSandbox {
  return validate(() => {
    if ((typeof input.code === "string") === Array.isArray(input.command)) throw new Error("provide exactly one of code or command");
    if (input.code !== undefined && (typeof input.code !== "string" || input.code.length > 65536)) throw new Error("code must be at most 64 KiB");
    if (input.command && (!input.command.length || input.command.length > 64 || input.command.some(s => typeof s !== "string" || !s || s.length > 4096 || s.includes("\0")))) throw new Error("invalid command argument array");
    return { key: sandboxKey(input.key), ...(input.code !== undefined ? { code: input.code } : { command: input.command }), timeoutMs: sandboxInteger(input.timeoutMs, 30_000, 100, 120_000) };
  });
}
export async function executeSandbox(project: string, id: string, input: ExecuteSandbox) {
  const spec = executionSpec(input); const fingerprint = hash(spec);
  const row = await serialAdmission(() => sql.begin(async tx => {
    const [box] = await tx`select * from mybase.sandboxes where project=${project} and id=${uuid(id)} for update`;
    if (!box) throw new NotFoundError("sandbox not found");
    const [old] = await tx`select * from mybase.sandbox_executions where sandbox_id=${id} and key=${spec.key}`;
    if (old) { if (old.fingerprint !== fingerprint) throw new ConflictError("execution key already used with different input"); return old; }
    if (box.state !== "ready" || +new Date(box.expires_at) <= Date.now()) throw new ConflictError("sandbox is not ready");
    if (box.executions >= limits.executions) throw new TooManyRequestsError("sandbox execution limit reached", 600);
    const busy = await tx`select 1 from mybase.sandbox_executions where sandbox_id=${id} and state in ('queued','running')`;
    if (busy.length) throw new ConflictError("sandbox already has an active execution");
    await tx`update mybase.sandboxes set executions=executions+1 where id=${id}`;
    const [result] = await tx`insert into mybase.sandbox_executions(id,sandbox_id,key,fingerprint,spec,state)
      values(${crypto.randomUUID()},${id},${spec.key},${fingerprint},${JSON.stringify(spec)}::text::jsonb,'queued') returning *`;
    return result;
  }));
  audit({ action: "sandbox.execution_created", project, target: row.id });
  return runView(row);
}
export async function listExecutions(project: string, id: string) {
  await owned(project, id);
  return (await sql`select * from mybase.sandbox_executions where sandbox_id=${id} order by started_at nulls last,id`).map(runView);
}
export async function getExecution(project: string, id: string, run: string) {
  await owned(project, id);
  const [row] = await sql`select * from mybase.sandbox_executions where sandbox_id=${id} and id=${uuid(run)}`;
  if (!row) throw new NotFoundError("execution not found");
  return runView(row);
}
export async function cancelExecution(project: string, id: string, run: string) {
  const result = await getExecution(project, id, run);
  if (!executionTerminal(result.state)) {
    // Mark first so a queued operation can never launch after cancellation commits.
    await sql.begin(async tx => {
      await tx`select id from mybase.sandboxes where id=${id} for update`;
      await tx`update mybase.sandbox_executions set state='cancelled',spec=null,finished_at=now() where id=${run} and state in ('queued','running')`;
      await tx`update mybase.sandboxes set state='stopping',reason='execution_cancelled' where id=${id} and state not in ('terminated','expired','failed')`;
    });
  }
  audit({ action: "sandbox.execution_cancelled", project, target: run });
  return getExecution(project, id, run);
}
export async function readBoundedBody(req: Request, max: number = limits.fileBytes): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new BadRequestError("body exceeds sandbox transfer limit");
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = req.body?.getReader();
  if (reader) try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new BadRequestError("body exceeds sandbox transfer limit"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}
async function ready(project: string, id: string) {
  const box = await owned(project, id);
  if (box.state !== "ready" || +new Date(box.expires_at) <= Date.now()) throw new ConflictError("sandbox is not ready");
  return box;
}
export async function workspaceFile(project: string, id: string, path: unknown, bytes?: Uint8Array): Promise<Response> {
  await ready(project, id);
  const valid = validate(() => sandboxPath(path));
  const res = await worker(`/boxes/${id}/files?path=${encodeURIComponent(valid)}`, project, bytes === undefined ? "GET" : "PUT", bytes, true) as Response;
  return new Response(res.body, { status: res.status, headers: { ...objectHeaders("application/octet-stream",valid), "Content-Type": "application/octet-stream" } });
}
export async function exportArtifact(project: string, id: string, path: unknown, type: unknown) {
  await ready(project, id);
  const valid = validate(() => sandboxPath(path));
  if (type !== undefined && (typeof type !== "string" || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(type))) throw new BadRequestError("invalid artifact MIME type");
  const response = await workspaceFile(project, id, valid);
  const bytes = await readBoundedBody(new Request("http://artifact", { method: "POST", body: response.body, duplex: "half" } as RequestInit));
  const artifactId = crypto.randomUUID(); const objectKey = `_mybase/sandboxes/${id}/${artifactId}`;
  const digest = createHash("sha256").update(bytes).digest("hex");
  // Commit a pending object record BEFORE touching Garage. A crash can never lose its cleanup key.
  const reservation = await sql.begin(async tx => {
      // Same lock as admission, so cross-sandbox project daily totals cannot race.
      await tx`select pg_advisory_xact_lock(hashtext('mybase.sandbox.admission'))`;
      const [box] = await tx`select * from mybase.sandboxes where id=${id} and project=${project} for update`;
      if (!box || box.state !== "ready") throw new ConflictError("sandbox stopped during export");
      const [old] = await tx`select * from mybase.sandbox_artifacts where sandbox_id=${id} and name=${valid} and sha256=${digest}`;
      if (old) {
        if (old.state !== "ready") throw new ConflictError("identical artifact export is pending; retry after cleanup");
        return old;
      }
      const usage = await sandboxUsage(project,tx);
      if (Number(box.artifact_bytes) + bytes.length > limits.artifactBytes || usage.artifactBytesToday + bytes.length > limits.dailyArtifactBytes) throw new TooManyRequestsError("sandbox artifact byte limit reached", 3600);
      const [{ count }] = await tx`select count(*)::int as count from mybase.sandbox_artifacts where sandbox_id=${id}`;
      if (count >= 100) throw new ConflictError("sandbox artifact count limit reached");
      const [row] = await tx`insert into mybase.sandbox_artifacts(id,sandbox_id,project,name,type,size,sha256,object_key,expires_at)
        values(${artifactId},${id},${project},${valid},${String(type ?? "application/octet-stream")},${bytes.length},${digest},${objectKey},now()+interval '7 days') returning *`;
      await tx`update mybase.sandboxes set artifact_bytes=artifact_bytes+${bytes.length} where id=${id}`;
      return row;
  });
  if (reservation.state === "ready") return artifactView(reservation);
  await sql.begin(async tx => {
    // Service disable and retention cleanup use this lock too; no writer can resurrect deleted objects.
    await tx`select pg_advisory_xact_lock(hashtext('mybase.sandbox.admission'))`;
    if (!(await tx`select 1 from mybase.sandbox_artifacts where id=${artifactId}`).length) throw new ConflictError("artifact export cancelled");
    await file(project, objectKey).write(bytes, { type: String(type ?? "application/octet-stream") });
    await tx`update mybase.sandbox_artifacts set state='ready' where id=${artifactId}`;
  });
  audit({ action: "sandbox.artifact_exported", project, target: artifactId, meta: { bytes: bytes.length } });
  return artifactView(reservation);
}
export async function listArtifacts(project: string, id: string) {
  await owned(project, id);
  return (await sql`select * from mybase.sandbox_artifacts where project=${project} and sandbox_id=${id} and state='ready' and expires_at>now()`).map(artifactView);
}
export async function downloadArtifact(project: string, id: string, artifact: string) {
  await owned(project, id);
  const [row] = await sql`select * from mybase.sandbox_artifacts where project=${project} and sandbox_id=${id} and id=${uuid(artifact)} and state='ready' and expires_at>now()`;
  if (!row) throw new NotFoundError("artifact not found or expired");
  return new Response(file(project, row.object_key).stream(), { headers: { ...objectHeaders(row.type,row.name), "Content-Type": "application/octet-stream", "Content-Length": String(row.size), "Content-Disposition": "attachment", "X-Checksum-SHA256": row.sha256 } });
}

const leases = new Map<string, { project: string; id: string; expires: number }>();
export async function browserConnection(project: string, id: string) {
  await ready(project, id);
  const token = crypto.randomUUID(); const expires = Date.now() + 30_000;
  // At most one outstanding credential per sandbox. Only its digest is retained.
  for (const [key, lease] of leases) if (lease.id === id || lease.expires <= Date.now()) leases.delete(key);
  leases.set(hash(token), { project, id, expires });
  audit({ action: "sandbox.browser_issued", project, target: id });
  return { endpoint: `${publicUrl.replace(/^http/, "ws")}/sandbox/${project}/${id}/browser`, headers: { "X-Mybase-Browser-Token": token }, expiresAt: new Date(expires).toISOString(), maxConnectionSeconds: 60 };
}
export async function consumeBrowserLease(project: string, id: string, token: string | null) {
  await ready(project, id);
  const digest = hash(token); const lease = leases.get(digest);
  if (!lease || lease.project !== project || lease.id !== id || lease.expires <= Date.now()) throw new NotFoundError("browser credential invalid or expired");
  leases.delete(digest);
}
async function finish(id: string, state: string, reason: string) {
  const rows = await sql`update mybase.sandboxes set state=${state},reason=${reason},finished_at=now(),
    runtime_ms=case when started_at is null then 0 else greatest(0,extract(epoch from now()-started_at)*1000)::bigint end
    where id=${id} and state not in ('terminated','expired','failed') returning project`;
  await sql`update mybase.sandbox_executions set state='failed',spec=null,finished_at=now(),stderr='sandbox stopped before execution completed' where sandbox_id=${id} and state in ('queued','running')`;
  if (rows.length) audit({ action: `sandbox.${state}`, project: rows[0].project, target: id, meta: { reason } });
}
async function saveRun(result: SandboxExecution) {
  if (!executionTerminal(result.state)) return;
  if (!["success", "failed", "timed_out", "cancelled"].includes(result.state) || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("invalid worker result");
  await sql`update mybase.sandbox_executions set state=${result.state},exit_code=${result.exitCode},stdout=${result.stdout.slice(0,limits.outputBytes)},stderr=${result.stderr.slice(0,limits.outputBytes)},truncated=${!!result.truncated},spec=null,
    started_at=${result.startedAt},finished_at=${result.finishedAt} where id=${result.id} and sandbox_id=${result.sandboxId} and state in ('queued','running')`;
}
let closing = false; let ticking = false; let lastPrune = 0;
const provisioning = new Set<string>();
async function reconcile() {
  if (ticking || closing) return; ticking = true;
  try {
    const boxes = await sql`select * from mybase.sandboxes where state not in ('terminated','expired','failed')`;
    for (const box of boxes) {
      if (provisioning.has(box.id)) continue;
      try {
        if (box.state === "queued") {
          if (+new Date(box.expires_at) <= Date.now()) { await finish(box.id, "expired", "admission_expired"); continue; }
          const updated = await sql`update mybase.sandboxes set state='provisioning',started_at=now() where id=${box.id} and state='queued' returning id`;
          if (!updated.length) continue;
          provisioning.add(box.id);
          void worker(`/boxes/${box.id}`, box.project, "PUT", { ttlSeconds: Math.max(10, Math.ceil((+new Date(box.expires_at) - Date.now()) / 1000)), idleSeconds: box.idle_seconds })
            .then(async result => {
              if (result.state === "ready") await sql`update mybase.sandboxes set state='ready' where id=${box.id} and state='provisioning'`;
              else await finish(box.id, "failed", "provisioning_failed");
            })
            .catch(err => log.warn("sandbox provisioning pending reconciliation", { sandbox: box.id, err: (err as Error).name }))
            .finally(() => provisioning.delete(box.id));
          continue;
        }
        const runs = await sql`select * from mybase.sandbox_executions where sandbox_id=${box.id} and state in ('queued','running')`;
        // Harvest execution output before observing terminal runtime state.
        for (const run of runs) {
          if (run.state === "running") {
            try { await saveRun(await worker(`/boxes/${box.id}/executions/${run.id}`, box.project)); }
            catch (err) {
              if (!(err instanceof NotFoundError)) throw err;
              // API may have crashed after its claim but before dispatch, or worker lost results.
              // Neither case licenses replay: fence the guest and report uncertain work promptly.
              await sql`update mybase.sandboxes set state='stopping',reason='execution_dispatch_lost' where id=${box.id} and state not in ('terminated','expired','failed')`;
              box.state = "stopping"; box.reason = "execution_dispatch_lost";
            }
          }
        }
        if (box.state === "stopping" || +new Date(box.expires_at) <= Date.now()) {
          await worker(`/boxes/${box.id}`, box.project, "DELETE").catch(err => { if (!(err instanceof NotFoundError)) throw err; });
          await finish(box.id, box.reason === "execution_dispatch_lost" ? "failed" : box.state === "stopping" ? "terminated" : "expired", box.reason ?? "ttl"); continue;
        }
        const current = await worker(`/boxes/${box.id}`, box.project);
        if (sandboxTerminal(current.state)) { await finish(box.id, current.state, current.reason ?? "runtime_stopped"); continue; }
        if (current.state === "ready" && box.state === "provisioning") await sql`update mybase.sandboxes set state='ready' where id=${box.id} and state='provisioning'`;
        for (const run of runs) if (run.state === "queued" && box.state === "ready") {
          const claimed = await sql`update mybase.sandbox_executions e set state='running',started_at=now() where e.id=${run.id} and e.state='queued'
            and exists(select 1 from mybase.sandboxes s where s.id=e.sandbox_id and s.state='ready') returning id`;
          if (!claimed.length) continue;
          try { await saveRun(await worker(`/boxes/${box.id}/executions/${run.id}`, box.project, "PUT", run.spec)); }
          catch (err) {
            // A lost response may mean the command ran. Never replay unknown work.
            await sql`update mybase.sandboxes set state='stopping',reason='dispatch_uncertain' where id=${box.id} and state='ready'`;
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof NotFoundError) await finish(box.id, "failed", "worker_restarted_or_guest_lost");
        else log.warn("sandbox reconciliation deferred", { sandbox: box.id, err: (err as Error).name });
      }
    }
    if (Date.now() - lastPrune > 60_000) {
      lastPrune = Date.now();
      await sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtext('mybase.sandbox.admission'))`;
        const expired = await tx`select * from mybase.sandbox_artifacts where expires_at<=now() or (state='pending' and created_at<now()-interval '5 minutes') limit 100`;
        for (const row of expired) {
          await file(row.project,row.object_key).delete();
          await tx`delete from mybase.sandbox_artifacts where id=${row.id}`;
          if (row.state === "pending") await tx`update mybase.sandboxes set artifact_bytes=greatest(0,artifact_bytes-${row.size}) where id=${row.sandbox_id}`;
        }
      });
      await sql`delete from mybase.sandboxes s where finished_at<now()-interval '7 days' and not exists(select 1 from mybase.sandbox_artifacts a where a.sandbox_id=s.id)`;
    }
  } catch (err) { log.error("sandbox reconciliation failed", { err }); }
  finally { ticking = false; }
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startSandboxes() { if (!workerUrl || !workerKey) return; timer = setInterval(() => void reconcile(), 1000); void reconcile(); }
export async function stopSandboxes() {
  closing = true; clearInterval(timer);
  // Worker has its own lifetime/idle watchdog even when the API cannot reach it.
  const boxes = await sql`select * from mybase.sandboxes where state not in ('terminated','expired','failed')`;
  for (const box of boxes) {
    try { await worker(`/boxes/${box.id}`, box.project, "DELETE"); await finish(box.id,"failed","api_shutdown"); }
    catch { /* On restart reconciliation marks absent runtimes failed or reattaches live ones. */ }
  }
}

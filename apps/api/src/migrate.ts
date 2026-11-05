// Moves Garage's contents between mybase instances, for `mybase server backup|restore|migrate`.
// Runs as a one-off container next to Garage (`docker compose run --rm --no-deps -T mybase
// bun migrate.js garage-export|garage-import`), since Garage's admin API is internal only.
//
// garage-export writes to stdout, garage-import reads from stdin. The stream is a list of
// records: u32 header length, a JSON header, then `size` bytes of object data when the header
// has one. Keys (with their secrets, so apps' credentials keep working), then buckets (aliases,
// grants, website, quotas, CORS), then objects, then an `end` record with the totals, which the
// import checks. Logs go to stderr only: stdout is the data.
import type { Logger, LogFields } from "@mybase/shared/logger";
import { admin, allowAll, GarageError, INTERNAL_KEY, internalKey, s3Endpoint, waitForGarage } from "./storage";

/** Objects up to this size are sent with one PUT; bigger ones as a multipart upload of these parts. */
const PART_SIZE = 16 * 1024 * 1024;

/** Response headers that describe an object, kept as they are. */
const KEPT_HEADERS = ["content-type", "cache-control", "content-disposition", "content-encoding", "content-language", "expires", "x-amz-website-redirect-location"];

type Rec =
  | { t: "key"; id: string; name: string; secret: string; createBucket: boolean }
  | {
      t: "bucket";
      id: string;
      globalAliases: string[];
      localAliases: { accessKeyId: string; alias: string }[];
      keys: { accessKeyId: string; permissions: { read: boolean; write: boolean; owner: boolean } }[];
      website: { indexDocument: string; errorDocument: string | null } | null;
      quotas: { maxSize: number | null; maxObjects: number | null };
      cors: string | null;
    }
  | { t: "object"; bucket: string; key: string; size: number; headers: Record<string, string> }
  | { t: "end"; keys: number; buckets: number; objects: number; bytes: number };

interface KeyListItem {
  id: string;
  name: string;
}
interface KeyInfo {
  accessKeyId: string;
  name: string;
  secretAccessKey: string | null;
  permissions?: { createBucket?: boolean };
}
interface BucketListItem {
  id: string;
  globalAliases: string[];
  localAliases?: { accessKeyId: string; alias: string }[];
}
interface BucketInfo {
  id: string;
  globalAliases: string[];
  websiteAccess: boolean;
  websiteConfig: { indexDocument: string; errorDocument: string | null } | null;
  keys: { accessKeyId: string; name: string; permissions: { read: boolean; write: boolean; owner: boolean }; bucketLocalAliases?: string[] }[];
  quotas?: { maxSize: number | null; maxObjects: number | null };
}

// ── Logging (stderr only) ──────────────────────────────────────────────────────────────────────

function stderrLogger(base: LogFields = {}): Logger {
  const write = (level: string, msg: string, fields: LogFields = {}) => {
    const all = { ...base, ...fields };
    for (const [k, v] of Object.entries(all)) if (v instanceof Error) all[k] = v.message;
    process.stderr.write(`${JSON.stringify({ level, service: "migrate", msg, ...all })}\n`);
  };
  return {
    debug: () => {},
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => stderrLogger({ ...base, ...fields }),
  };
}

const log = stderrLogger();

// ── Stream helpers ─────────────────────────────────────────────────────────────────────────────

async function out(bytes: Uint8Array) {
  if (!process.stdout.write(bytes)) await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
}

async function writeRecord(rec: Rec) {
  const json = new TextEncoder().encode(JSON.stringify(rec));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length);
  await out(len);
  await out(json);
}

/** Reads exact byte counts from a stream. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Fills the buffer to `n` bytes; false if the stream ended first. */
  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value.length) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
    return this.buffered >= n;
  }

  /** Up to `max` bytes (at least 1), or null at the end. */
  async some(max: number): Promise<Uint8Array | null> {
    if (!(await this.fill(1))) return null;
    const first = this.chunks[0]!;
    if (first.length <= max) {
      this.chunks.shift();
      this.buffered -= first.length;
      return first;
    }
    this.chunks[0] = first.subarray(max);
    this.buffered -= max;
    return first.subarray(0, max);
  }

  async exact(n: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!(await this.fill(n))) throw new Error("the export ended early");
    const outBuf = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const piece = (await this.some(n - at))!;
      outBuf.set(piece, at);
      at += piece.length;
    }
    return outBuf;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }
}

async function readRecord(r: ByteReader): Promise<Rec | null> {
  if (await r.atEnd()) return null;
  const len = new DataView((await r.exact(4)).buffer).getUint32(0);
  return JSON.parse(new TextDecoder().decode(await r.exact(len))) as Rec;
}

const objectUrl = (bucket: string, key: string) => `${s3Endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

async function s3(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await internalKey().aws.fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname.split("/")[1]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ── Export ─────────────────────────────────────────────────────────────────────────────────────

async function exportGarage() {
  await waitForGarage(log, 15);
  const internalId = internalKey().accessKeyId;
  const totals = { keys: 0, buckets: 0, objects: 0, bytes: 0 };

  for (const item of await admin<KeyListItem[]>("ListKeys")) {
    if (item.name === INTERNAL_KEY || item.id === internalId) continue;
    const key = await admin<KeyInfo>(`GetKeyInfo?id=${encodeURIComponent(item.id)}&showSecretKey=true`);
    if (!key.secretAccessKey) throw new Error(`garage did not return the secret of key ${item.name}`);
    await writeRecord({ t: "key", id: key.accessKeyId, name: key.name, secret: key.secretAccessKey, createBucket: key.permissions?.createBucket === true });
    totals.keys++;
  }

  const buckets: { id: string; alias: string }[] = [];
  for (const item of await admin<BucketListItem[]>("ListBuckets")) {
    const info = await admin<BucketInfo>(`GetBucketInfo?id=${encodeURIComponent(item.id)}`);
    const alias = info.globalAliases[0];
    let cors: string | null = null;
    if (alias) {
      const res = await internalKey().aws.fetch(`${s3Endpoint}/${alias}?cors`);
      if (res.ok) cors = await res.text();
      else await res.body?.cancel();
    }
    await writeRecord({
      t: "bucket",
      id: info.id,
      globalAliases: info.globalAliases,
      localAliases: item.localAliases ?? [],
      keys: info.keys.filter((k) => k.accessKeyId !== internalId).map((k) => ({ accessKeyId: k.accessKeyId, permissions: k.permissions })),
      website: info.websiteAccess && info.websiteConfig ? info.websiteConfig : null,
      quotas: { maxSize: info.quotas?.maxSize ?? null, maxObjects: info.quotas?.maxObjects ?? null },
      cors,
    });
    totals.buckets++;
    if (alias) buckets.push({ id: info.id, alias });
    else log.warn("bucket has no global alias, its objects are skipped", { bucket: info.id.slice(0, 16) });
  }

  const { client } = internalKey();
  for (const { id, alias } of buckets) {
    let continuationToken: string | undefined;
    let count = 0;
    do {
      const page = await client.list({ maxKeys: 1000, continuationToken }, { bucket: alias });
      for (const obj of page.contents ?? []) {
        const res = await s3(objectUrl(alias, obj.key));
        const size = Number(res.headers.get("content-length") ?? obj.size ?? 0);
        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
          if (KEPT_HEADERS.includes(name) || name.startsWith("x-amz-meta-")) headers[name] = value;
        });
        await writeRecord({ t: "object", bucket: id, key: obj.key, size, headers });
        let sent = 0;
        for await (const chunk of res.body!) {
          sent += chunk.length;
          if (sent > size) throw new Error(`object in ${alias} grew while it was read`);
          await out(chunk);
        }
        if (sent !== size) throw new Error(`object in ${alias} was cut short (${sent} of ${size} bytes)`);
        totals.objects++;
        totals.bytes += size;
        count++;
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    log.info("bucket exported", { bucket: alias, objects: count });
  }

  await writeRecord({ t: "end", ...totals });
  log.info("garage exported", totals);
}

// ── Import ─────────────────────────────────────────────────────────────────────────────────────

async function putObject(r: ByteReader, bucket: string, rec: Extract<Rec, { t: "object" }>) {
  const url = objectUrl(bucket, rec.key);
  if (rec.size <= PART_SIZE) {
    const body = await r.exact(rec.size);
    await s3(url, { method: "PUT", body, headers: rec.headers });
    return;
  }
  const created = await (await s3(`${url}?uploads`, { method: "POST", headers: rec.headers })).text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)?.[1];
  if (!uploadId) throw new Error("garage did not start a multipart upload");
  const parts: string[] = [];
  try {
    for (let left = rec.size, n = 1; left > 0; n++) {
      const body = await r.exact(Math.min(PART_SIZE, left));
      left -= body.length;
      const res = await s3(`${url}?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT", body });
      parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${res.headers.get("etag")}</ETag></Part>`);
    }
    const xml = `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`;
    await s3(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body: xml });
  } catch (err) {
    await internalKey().aws.fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
}

async function importGarage() {
  await waitForGarage(log, 30);
  const internalId = internalKey().accessKeyId;
  const r = new ByteReader(Bun.stdin.stream().getReader());
  const totals = { keys: 0, buckets: 0, objects: 0, bytes: 0 };
  /** Source bucket id → [new id, S3 name]. */
  const buckets = new Map<string, { id: string; alias: string | null }>();
  const keys = new Set<string>();
  let end: Extract<Rec, { t: "end" }> | null = null;

  for (let rec = await readRecord(r); rec; rec = await readRecord(r)) {
    if (end) throw new Error("data after the end of the export");
    if (rec.t === "key") {
      try {
        await admin("ImportKey", { accessKeyId: rec.id, secretAccessKey: rec.secret, name: rec.name });
      } catch (err) {
        // A retried import on the same Garage: the key is already there.
        if (!(err instanceof GarageError && /exist/i.test(`${err.code} ${err.message}`))) throw err;
      }
      if (rec.createBucket) await admin(`UpdateKey?id=${encodeURIComponent(rec.id)}`, { allow: { createBucket: true } });
      keys.add(rec.id);
      totals.keys++;
    } else if (rec.t === "bucket") {
      const [first, ...more] = rec.globalAliases;
      let id: string;
      try {
        id = (await admin<{ id: string }>("CreateBucket", first ? { globalAlias: first } : {})).id;
      } catch (err) {
        if (!(first && err instanceof GarageError && err.code === "BucketAlreadyExists")) throw err;
        id = (await admin<{ id: string }>(`GetBucketInfo?globalAlias=${encodeURIComponent(first)}`)).id;
      }
      for (const alias of more) await admin("AddBucketAlias", { bucketId: id, globalAlias: alias }).catch(() => {});
      for (const k of rec.keys) {
        if (!keys.has(k.accessKeyId)) continue;
        await admin("AllowBucketKey", { bucketId: id, accessKeyId: k.accessKeyId, permissions: k.permissions });
      }
      for (const a of rec.localAliases) {
        if (keys.has(a.accessKeyId)) await admin("AddBucketAlias", { bucketId: id, accessKeyId: a.accessKeyId, localAlias: a.alias }).catch(() => {});
      }
      await allowAll(id, internalId);
      const update: Record<string, unknown> = {};
      if (rec.website) update.websiteAccess = { enabled: true, indexDocument: rec.website.indexDocument, errorDocument: rec.website.errorDocument };
      if (rec.quotas.maxSize !== null || rec.quotas.maxObjects !== null) update.quotas = rec.quotas;
      if (Object.keys(update).length) await admin(`UpdateBucket?id=${encodeURIComponent(id)}`, update);
      if (rec.cors && first) await s3(`${s3Endpoint}/${first}?cors`, { method: "PUT", body: rec.cors });
      buckets.set(rec.id, { id, alias: first ?? null });
      totals.buckets++;
    } else if (rec.t === "object") {
      const bucket = buckets.get(rec.bucket);
      if (!bucket?.alias) throw new Error("an object came before its bucket");
      await putObject(r, bucket.alias, rec);
      totals.objects++;
      totals.bytes += rec.size;
      if (totals.objects % 500 === 0) log.info("objects imported", { objects: totals.objects });
    } else if (rec.t === "end") end = rec;
  }

  if (!end) throw new Error("the export ended early");
  for (const k of ["keys", "buckets", "objects", "bytes"] as const) {
    if (end[k] !== totals[k]) throw new Error(`imported ${totals[k]} ${k}, the export had ${end[k]}`);
  }
  log.info("garage imported", totals);
  process.stdout.write(`${JSON.stringify(totals)}\n`);
}

const command = process.argv[2];
try {
  if (command === "garage-export") await exportGarage();
  else if (command === "garage-import") await importGarage();
  else throw new Error(`usage: migrate.js garage-export|garage-import (got ${command ?? "nothing"})`);
  // Let the last bytes reach the pipe before exiting.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
} catch (err) {
  log.error("migration failed", { err: err as Error });
  process.exit(1);
}

// Provisions per-project buckets on the shared Garage server (S3-compatible).
//
// Each project gets a bucket plus its own access key. The API keeps one internal
// key with access to every bucket, for the dashboard's file browser, public reads,
// and emptying buckets on delete. Its secret is read from Garage at startup and
// never stored or logged.
import { S3Client } from "bun";
import { AwsClient } from "aws4fetch";
import { bucketName, PUBLIC_PREFIX, type ListFilesResponse, type StorageCredentials, type StorageInfo } from "@mybase/shared";
import type { Logger } from "@mybase/shared/logger";
import { ProjectExistsError } from "./errors";

const env = process.env;
const adminUrl = env.GARAGE_ADMIN_URL ?? "http://localhost:3903";
const adminToken = env.GARAGE_ADMIN_TOKEN ?? "change-me";
const s3Url = env.GARAGE_S3_URL ?? "http://localhost:3900";
const region = "garage";

// Where apps reach Garage and the mybase API, which differ from the API's view inside Docker.
const publicS3Url = env.MYBASE_S3_PUBLIC_URL ?? s3Url;
const publicApiUrl = (env.MYBASE_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

const INTERNAL_KEY = "mybase-internal";

/** Public connection details for a project's bucket (no secrets). */
export const storageInfo = (project: string): StorageInfo => ({
  endpoint: publicS3Url,
  region,
  bucket: bucketName(project),
  publicUrl: `${publicApiUrl}/storage/${project}/${PUBLIC_PREFIX}`,
});

/** An error response from Garage's admin API; `code` is Garage's error code, e.g. `NoSuchBucket`. */
class GarageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function admin<T>(endpoint: string, body?: unknown): Promise<T> {
  const res = await fetch(`${adminUrl}/v2/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new GarageError(data?.code ?? String(res.status), data?.message ?? `garage admin ${endpoint} failed (${res.status})`);
  return data as T;
}

interface KeyInfo {
  accessKeyId: string;
  name: string;
  secretAccessKey: string | null;
}
interface KeyListItem {
  id: string;
  name: string;
}
interface BucketInfo {
  id: string;
  keys: { accessKeyId: string; name: string }[];
}
interface NodeStatus {
  id: string;
}

let internal: { client: S3Client; accessKeyId: string; aws: AwsClient } | undefined;

function internalKey() {
  if (!internal) throw new Error("storage not initialised: call waitForGarage first");
  return internal;
}

/** Parses sizes like `100G`, `1T`, or plain bytes. */
function parseBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(value.trim());
  if (!match) throw new Error(`invalid GARAGE_CAPACITY: ${value}`);
  const power = " KMGT".indexOf((match[2] || " ").toUpperCase());
  return Math.round(Number(match[1]) * 1000 ** power);
}

/**
 * Waits for Garage, then gets it ready on first boot: assigns this single node a
 * layout role and makes the internal key. Both steps are skipped once done.
 */
export async function waitForGarage(log: Logger, attempts = 30) {
  let status: { layoutVersion: number; nodes: NodeStatus[] };
  for (let attempt = 1; ; attempt++) {
    try {
      status = await admin("GetClusterStatus");
      log.info("garage connected", { url: adminUrl });
      break;
    } catch (err) {
      if (attempt >= attempts || (err instanceof GarageError && err.code === "403")) throw err;
      log.warn("garage not ready, retrying", { url: adminUrl, attempt, err: (err as Error).message });
      await Bun.sleep(2000);
    }
  }

  if (status.layoutVersion === 0) {
    const node = status.nodes[0];
    if (!node) throw new Error("garage reported no nodes");
    const capacity = parseBytes(env.GARAGE_CAPACITY ?? "100G");
    await admin("UpdateClusterLayout", { roles: [{ id: node.id, zone: "dc1", capacity, tags: [] }] });
    await admin("ApplyClusterLayout", { version: 1 });
    log.info("garage layout applied", { node: node.id.slice(0, 16), capacity });
  }

  const keys = await admin<KeyListItem[]>("ListKeys");
  let id = keys.find((k) => k.name === INTERNAL_KEY)?.id;
  if (!id) {
    id = (await admin<KeyInfo>("CreateKey", { name: INTERNAL_KEY })).accessKeyId;
    log.info("garage internal key created");
  }
  const { secretAccessKey } = await admin<KeyInfo>(`GetKeyInfo?id=${id}&showSecretKey=true`);
  if (!secretAccessKey) throw new Error("garage did not return the internal key's secret");
  internal = {
    client: new S3Client({ accessKeyId: id, secretAccessKey, endpoint: s3Url, region }),
    accessKeyId: id,
    aws: new AwsClient({ accessKeyId: id, secretAccessKey, region, service: "s3" }),
  };

  // Self-heal: make sure the internal key can reach every bucket, e.g. if it was recreated.
  const buckets = await admin<{ id: string }[]>("ListBuckets");
  await Promise.all(buckets.map((b) => allowAll(b.id, id)));
}

const allowAll = (bucketId: string, accessKeyId: string) =>
  admin("AllowBucketKey", { bucketId, accessKeyId, permissions: { read: true, write: true, owner: true } });

// Lets browsers use presigned URLs from any origin. Apps own their bucket and can tighten this.
const CORS_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration><CORSRule>
<AllowedOrigin>*</AllowedOrigin>
<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedMethod>PUT</AllowedMethod>
<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader>
<MaxAgeSeconds>3600</MaxAgeSeconds>
</CORSRule></CORSConfiguration>`;

async function putCors(bucket: string) {
  const res = await internalKey().aws.fetch(`${s3Url}/${bucket}?cors`, { method: "PUT", body: CORS_CONFIG });
  if (!res.ok) throw new Error(`setting bucket CORS failed (${res.status}): ${await res.text()}`);
}

/**
 * Creates the project's bucket and an access key that can use only it.
 * Undoes its own work on failure, so a failed call leaves nothing behind.
 */
export async function createBucket(project: string, log: Logger): Promise<StorageCredentials> {
  const bucket = bucketName(project);

  let bucketId: string;
  try {
    bucketId = (await admin<BucketInfo>("CreateBucket", { globalAlias: bucket })).id;
  } catch (err) {
    if (err instanceof GarageError && err.code === "BucketAlreadyExists") throw new ProjectExistsError(`bucket "${bucket}" already exists`);
    throw err;
  }

  let keyId: string | undefined;
  try {
    const key = await admin<KeyInfo>("CreateKey", { name: project });
    keyId = key.accessKeyId;
    await allowAll(bucketId, key.accessKeyId);
    await allowAll(bucketId, internalKey().accessKeyId);
    await putCors(bucket);
    return { ...storageInfo(project), accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey! };
  } catch (err) {
    if (keyId) await admin(`DeleteKey?id=${keyId}`, {}).catch((e) => log.error("key cleanup failed", { bucket, err: e }));
    await admin(`DeleteBucket?id=${bucketId}`, {}).catch((e) => log.error("bucket cleanup failed", { bucket, err: e }));
    throw err;
  }
}

/**
 * Replaces the project's access key: makes a new one for its bucket, then deletes the old
 * ones (only keys named after the project; never the internal key or ones granted by hand).
 */
export async function rotateStorageKey(project: string, log: Logger): Promise<StorageCredentials> {
  const bucket = bucketName(project);
  const info = await admin<BucketInfo>(`GetBucketInfo?globalAlias=${bucket}`);
  const key = await admin<KeyInfo>("CreateKey", { name: project });
  try {
    await allowAll(info.id, key.accessKeyId);
  } catch (err) {
    await admin(`DeleteKey?id=${key.accessKeyId}`, {}).catch((e) => log.error("key cleanup failed", { bucket, err: e }));
    throw err;
  }
  let removed = 0;
  for (const old of info.keys) {
    if (old.name !== project || old.accessKeyId === key.accessKeyId) continue;
    await admin(`DeleteKey?id=${old.accessKeyId}`, {}).catch((err) => {
      if (!(err instanceof GarageError && err.code === "NoSuchAccessKey")) throw err;
    });
    removed++;
  }
  log.info("storage key rotated", { bucket, removed });
  return { ...storageInfo(project), accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey! };
}

/**
 * Deletes the project's access keys, every object, and the bucket.
 * Returns false if the bucket was already gone, so callers can retry a partial delete.
 */
export async function deleteBucket(project: string, log: Logger): Promise<boolean> {
  const bucket = bucketName(project);
  let info: BucketInfo;
  try {
    info = await admin<BucketInfo>(`GetBucketInfo?globalAlias=${bucket}`);
  } catch (err) {
    if (err instanceof GarageError && err.code === "NoSuchBucket") return false;
    throw err;
  }

  // Revoke app access first, so nothing writes while the bucket is emptied.
  // Only the project's own key: never the internal one or anything granted by hand.
  const { client } = internalKey();
  for (const key of info.keys) {
    if (key.name !== project) continue;
    await admin(`DeleteKey?id=${key.accessKeyId}`, {}).catch((err) => {
      if (!(err instanceof GarageError && err.code === "NoSuchAccessKey")) throw err;
    });
  }

  let deleted = 0;
  for (;;) {
    const page = await client.list({ maxKeys: 1000 }, { bucket });
    const keys = page.contents ?? [];
    if (keys.length === 0) break;
    await Promise.all(keys.map((obj) => client.delete(obj.key, { bucket })));
    deleted += keys.length;
  }
  await admin("CleanupIncompleteUploads", { bucketId: info.id, olderThanSecs: 0 });
  await admin(`DeleteBucket?id=${info.id}`, {});
  log.info("bucket deleted", { bucket, objects: deleted });
  return true;
}

/** One level of the bucket under `prefix`, like a directory listing. */
export async function listFiles(project: string, prefix: string): Promise<ListFilesResponse> {
  const bucket = bucketName(project);
  const { client } = internalKey();
  const folders: string[] = [];
  const files: ListFilesResponse["files"] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix, delimiter: "/", continuationToken }, { bucket });
    for (const p of page.commonPrefixes ?? []) folders.push(p.prefix);
    for (const obj of page.contents ?? []) {
      files.push({ key: obj.key, size: obj.size ?? 0, lastModified: obj.lastModified ?? null });
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return { prefix, folders, files };
}

/** A handle to one object, read and written with the internal key. */
export const file = (project: string, key: string) => internalKey().client.file(key, { bucket: bucketName(project) });

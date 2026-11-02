// Pushes a `docker save` tarball to mybase's registry, in chunks small enough for Cloudflare's
// 100 MB request cap (plain `docker push` sends each layer in one request). Works with both
// tar layouts `docker save` writes (legacy `<id>/layer.tar`, and OCI `blobs/sha256/…` since
// Docker 25): manifest.json names the config and layers either way. Uncompressed layers are
// gzipped first; blobs the registry already has are skipped.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

export const CHUNK_BYTES = 32 * 1024 * 1024;

export interface TarEntry {
  name: string;
  offset: number;
  size: number;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, "");

/** Octal, or GNU base-256 for sizes over 8 GB. */
function tarSize(field: Uint8Array): number {
  if (field[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  return parseInt(text(field).trim() || "0", 8);
}

/** Lists a tar's regular files, reading only headers (layers can be GBs). */
export async function readTar(path: string): Promise<Map<string, TarEntry>> {
  const file = Bun.file(path);
  const entries = new Map<string, TarEntry>();
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= file.size) {
    const h = new Uint8Array(await file.slice(at, at + 512).arrayBuffer());
    if (h.every((b) => b === 0)) break;
    const size = tarSize(h.subarray(124, 136));
    const type = String.fromCharCode(h[156]!);
    const prefix = text(h.subarray(345, 500));
    let name = longName ?? (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    const body = at + 512;
    if (type === "L") {
      longName = text(new Uint8Array(await file.slice(body, body + size).arrayBuffer()));
    } else if (type === "x") {
      const pax = new TextDecoder().decode(await file.slice(body, body + size).arrayBuffer());
      longName = /\d+ path=([^\n]*)\n/.exec(pax)?.[1] ?? null;
    } else {
      longName = null;
      name = name.replace(/^\.\//, "");
      if (type === "0" || type === "\0") entries.set(name, { name, offset: body, size });
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** The parts of an image a push needs. */
export interface SavedImage {
  config: { bytes: Uint8Array; architecture?: string; os?: string };
  layers: TarEntry[];
}

export async function savedImage(tar: string, entries: Map<string, TarEntry>): Promise<SavedImage> {
  const read = async (name: string) => {
    const e = entries.get(name);
    if (!e) throw new Error(`the saved image is missing ${name}`);
    return new Uint8Array(await Bun.file(tar).slice(e.offset, e.offset + e.size).arrayBuffer());
  };
  const manifest = JSON.parse(new TextDecoder().decode(await read("manifest.json"))) as { Config: string; Layers: string[] }[];
  if (manifest.length !== 1) throw new Error("expected exactly one image in the saved tar");
  const bytes = await read(manifest[0]!.Config);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { architecture?: string; os?: string };
  const layers = manifest[0]!.Layers.map((name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`the saved image is missing layer ${name}`);
    return e;
  });
  return { config: { bytes, architecture: parsed.architecture, os: parsed.os }, layers };
}

/** A blob ready to upload: a slice of the tar, or a temp file with the gzipped layer. */
interface Blob {
  digest: string;
  size: number;
  mediaType: string;
  source: () => ReturnType<typeof Bun.file>;
  cleanup?: () => Promise<void>;
}

async function isGzip(tar: string, e: TarEntry) {
  const head = new Uint8Array(await Bun.file(tar).slice(e.offset, e.offset + 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

async function sha256Stream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function layerBlob(tar: string, e: TarEntry): Promise<Blob> {
  const slice = () => Bun.file(tar).slice(e.offset, e.offset + e.size) as ReturnType<typeof Bun.file>;
  if (await isGzip(tar, e)) {
    // OCI layouts name blobs by digest; legacy ones don't, so hash those.
    const fromName = /blobs\/sha256\/([0-9a-f]{64})$/.exec(e.name)?.[1];
    const digest = fromName ? `sha256:${fromName}` : await sha256Stream(slice().stream());
    return { digest, size: e.size, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", source: slice };
  }
  const out = join(tmpdir(), `mybase-layer-${crypto.randomUUID()}.tar.gz`);
  const hash = createHash("sha256");
  const writer = Bun.file(out).writer();
  let size = 0;
  for await (const chunk of slice().stream().pipeThrough(new CompressionStream("gzip")) as ReadableStream<Uint8Array>) {
    hash.update(chunk);
    writer.write(chunk);
    size += chunk.length;
  }
  await writer.end();
  return {
    digest: `sha256:${hash.digest("hex")}`,
    size,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    source: () => Bun.file(out),
    cleanup: () => rm(out, { force: true }),
  };
}

export interface PushTarget {
  /** e.g. https://mybase.example.com */
  url: string;
  token: string;
  /** `<project>/<site>` */
  repo: string;
  /** Default CHUNK_BYTES (tests use small ones). */
  chunkBytes?: number;
}

export interface PushProgress {
  (event: { kind: "skip" | "upload" | "done"; digest: string; sent?: number; size: number }): void;
}

async function registry(t: PushTarget, path: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  const url = path.startsWith("http") ? path : `${t.url}${path}`;
  for (let i = 1; ; i++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${t.token}`, ...(init.headers as Record<string, string>) } });
    } catch (err) {
      if (i >= attempts) throw new Error(`can't reach the registry at ${t.url}: ${(err as Error).message}`);
    }
    if (res && (res.status < 500 || i >= attempts)) return res;
    await Bun.sleep(1000 * i);
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  let reason = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: string; errors?: { message?: string }[] };
    reason = parsed.error ?? parsed.errors?.map((e) => e.message).join("; ") ?? reason;
  } catch {}
  return new Error(`${what} failed (${res.status}): ${reason}`);
}

async function uploadBlob(t: PushTarget, blob: Blob, progress: PushProgress) {
  const head = await registry(t, `/v2/${t.repo}/blobs/${blob.digest}`, { method: "HEAD" });
  if (head.ok) return progress({ kind: "skip", digest: blob.digest, size: blob.size });
  const start = await registry(t, `/v2/${t.repo}/blobs/uploads/`, { method: "POST", headers: { "Content-Length": "0" } });
  if (start.status !== 202) throw await failure(start, "starting an upload");
  let location = start.headers.get("Location")!;
  const absolute = (loc: string) => (loc.startsWith("http") ? loc.replace(/^https?:\/\/[^/]+/, t.url) : `${t.url}${loc}`);
  location = absolute(location);
  const file = blob.source();
  const step = t.chunkBytes ?? CHUNK_BYTES;
  for (let sent = 0; sent < blob.size; sent += step) {
    const end = Math.min(sent + step, blob.size);
    const chunk = await file.slice(sent, end).arrayBuffer();
    const res = await registry(t, location, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream", "Content-Range": `${sent}-${end - 1}`, "Content-Length": String(end - sent) },
      body: chunk,
    }, 1);
    if (res.status !== 202) throw await failure(res, "uploading a layer chunk");
    location = absolute(res.headers.get("Location")!);
    progress({ kind: "upload", digest: blob.digest, sent: end, size: blob.size });
  }
  const done = await registry(t, `${location}${location.includes("?") ? "&" : "?"}digest=${encodeURIComponent(blob.digest)}`, {
    method: "PUT",
    headers: { "Content-Length": "0" },
  });
  if (done.status !== 201) throw await failure(done, "finishing an upload");
  progress({ kind: "done", digest: blob.digest, size: blob.size });
}

/** Pushes the image in a `docker save` tar; returns the manifest digest. */
export async function pushImage(tar: string, t: PushTarget, progress: PushProgress = () => {}): Promise<{ digest: string; architecture?: string }> {
  const image = await savedImage(tar, await readTar(tar));
  const configDigest = `sha256:${createHash("sha256").update(image.config.bytes).digest("hex")}`;
  const configPath = join(tmpdir(), `mybase-config-${crypto.randomUUID()}.json`);
  await Bun.write(configPath, image.config.bytes);
  const blobs: Blob[] = [];
  try {
    for (const layer of image.layers) blobs.push(await layerBlob(tar, layer));
    const config: Blob = { digest: configDigest, size: image.config.bytes.length, mediaType: "application/vnd.oci.image.config.v1+json", source: () => Bun.file(configPath) };
    for (const blob of [...blobs, config]) await uploadBlob(t, blob, progress);
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: config.mediaType, digest: config.digest, size: config.size },
        layers: blobs.map((b) => ({ mediaType: b.mediaType, digest: b.digest, size: b.size })),
      }),
    );
    const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const res = await registry(t, `/v2/${t.repo}/manifests/${digest}`, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest,
    });
    if (res.status !== 201) throw await failure(res, "pushing the manifest");
    return { digest, architecture: image.config.architecture };
  } finally {
    await rm(configPath, { force: true });
    for (const b of blobs) await b.cleanup?.();
  }
}

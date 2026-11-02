import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushImage, readTar } from "./oci-push";

const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const dir = await mkdtemp(join(tmpdir(), "oci-push-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A `docker save`-style tar: one uncompressed legacy layer and one gzipped OCI blob. */
async function savedTar(): Promise<string> {
  const root = join(dir, "image");
  const config = JSON.stringify({ architecture: "arm64", os: "linux", rootfs: { type: "layers" } });
  const plain = crypto.getRandomValues(new Uint8Array(5000));
  const gz = Bun.gzipSync(crypto.getRandomValues(new Uint8Array(3000)));
  const gzName = `blobs/sha256/${sha(gz).slice(7)}`;
  await Bun.write(join(root, "cfg.json"), config);
  await Bun.write(join(root, "aaa/layer.tar"), plain);
  await Bun.write(join(root, gzName), gz);
  await Bun.write(join(root, "manifest.json"), JSON.stringify([{ Config: "cfg.json", Layers: ["aaa/layer.tar", gzName] }]));
  const tar = join(dir, "image.tar");
  const r = Bun.spawnSync(["tar", "-cf", tar, "-C", root, "manifest.json", "cfg.json", "aaa/layer.tar", gzName]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return tar;
}

test("readTar lists files with offsets", async () => {
  const tar = await savedTar();
  const entries = await readTar(tar);
  const cfg = entries.get("cfg.json")!;
  const text = await Bun.file(tar).slice(cfg.offset, cfg.offset + cfg.size).text();
  expect(JSON.parse(text).architecture).toBe("arm64");
  expect(entries.get("aaa/layer.tar")!.size).toBe(5000);
});

test("pushImage uploads in chunks, gzips plain layers, and skips blobs the registry has", async () => {
  const blobs = new Map<string, Uint8Array>();
  const uploads = new Map<string, Uint8Array[]>();
  const manifests = new Map<string, Uint8Array>();
  let patches = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      expect(req.headers.get("authorization")).toBe("Bearer mb_test");
      const blob = /^\/v2\/shop\/web\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
      if (blob && req.method === "HEAD") return new Response(null, { status: blobs.has(blob[1]!) ? 200 : 404 });
      if (url.pathname === "/v2/shop/web/blobs/uploads/" && req.method === "POST") {
        const id = crypto.randomUUID();
        uploads.set(id, []);
        return new Response(null, { status: 202, headers: { Location: `/v2/shop/web/blobs/uploads/${id}?_state=x` } });
      }
      const up = /^\/v2\/shop\/web\/blobs\/uploads\/([0-9a-f-]+)$/.exec(url.pathname);
      if (up && req.method === "PATCH") {
        patches++;
        const parts = uploads.get(up[1]!)!;
        const start = Number(req.headers.get("content-range")!.split("-")[0]);
        expect(start).toBe(parts.reduce((n, p) => n + p.length, 0));
        parts.push(new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 202, headers: { Location: `/v2/shop/web/blobs/uploads/${up[1]}?_state=y` } });
      }
      if (up && req.method === "PUT") {
        const data = Buffer.concat(uploads.get(up[1]!)!);
        const digest = url.searchParams.get("digest")!;
        if (sha(data) !== digest) return new Response("digest mismatch", { status: 400 });
        blobs.set(digest, data);
        return new Response(null, { status: 201 });
      }
      const manifest = /^\/v2\/shop\/web\/manifests\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
      if (manifest && req.method === "PUT") {
        const body = new Uint8Array(await req.arrayBuffer());
        if (sha(body) !== manifest[1]) return new Response("bad manifest digest", { status: 400 });
        manifests.set(manifest[1]!, body);
        return new Response(null, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const tar = await savedTar();
    const target = { url: `http://localhost:${server.port}`, token: "mb_test", repo: "shop/web", chunkBytes: 1024 };
    const { digest, architecture } = await pushImage(tar, target);
    expect(architecture).toBe("arm64");
    const manifest = JSON.parse(new TextDecoder().decode(manifests.get(digest)!));
    expect(manifest.layers).toHaveLength(2);
    for (const l of manifest.layers) {
      expect(l.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip");
      const stored = blobs.get(l.digest)!;
      expect(stored.length).toBe(l.size);
      expect(stored[0]).toBe(0x1f);
    }
    expect(blobs.has(manifest.config.digest)).toBe(true);
    expect(patches).toBeGreaterThan(3);
    // A second push sends nothing new.
    const before = patches;
    expect((await pushImage(tar, target)).digest).toBe(digest);
    expect(patches).toBe(before);
  } finally {
    server.stop(true);
  }
});

import { expect, test } from "bun:test";
import { ArchiveError, ArchiveReader, ArchiveWriter, CHUNK, collect, compatible, dropSuperuserCreate, type Manifest, newCode, normalizeCode, skip } from "./archive";

const manifest: Manifest = { format: 1, version: "1.0.14", arch: "arm64", hostname: "pi", createdAt: "2026-11-05T00:00:00Z", projects: 2, sections: ["env", "postgres"] };

async function build(secret?: string, sections: Record<string, Uint8Array[]> = { env: [new TextEncoder().encode("A=1\n")], postgres: [new Uint8Array(CHUNK * 2 + 5).fill(7)] }) {
  const parts: Uint8Array[] = [];
  const w = new ArchiveWriter(async (b) => void parts.push(new Uint8Array(b)));
  await w.start(secret);
  await w.manifest(manifest);
  for (const [name, chunks] of Object.entries(sections)) {
    await w.section(name as "env", (async function* () {
      yield* chunks;
    })());
  }
  await w.end();
  return new Uint8Array(Buffer.concat(parts));
}

const stream = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

async function readAll(bytes: Uint8Array, secret?: string) {
  const r = new ArchiveReader(stream(bytes));
  const m = await r.open(secret);
  const out: Record<string, Uint8Array> = {};
  for (let s = await r.next(); s; s = await r.next()) out[s.name] = await collect(s.data);
  return { m, out };
}

test("round-trips plain and encrypted archives, splitting big sections into records", async () => {
  for (const secret of [undefined, "correct horse"]) {
    const { m, out } = await readAll(await build(secret), secret);
    expect(m).toEqual(manifest);
    expect(new TextDecoder().decode(out.env)).toBe("A=1\n");
    expect(out.postgres!.length).toBe(CHUNK * 2 + 5);
    expect(out.postgres!.every((b) => b === 7)).toBe(true);
  }
});

test("encrypted archives hide their contents", async () => {
  const bytes = await build("secret", { env: [new TextEncoder().encode("MYBASE_SECRETS_KEY=visible-if-plain")] });
  expect(Buffer.from(bytes).includes("visible-if-plain")).toBe(false);
  expect(Buffer.from(await build(undefined, { env: [new TextEncoder().encode("MYBASE_SECRETS_KEY=visible-if-plain")] })).includes("visible-if-plain")).toBe(true);
});

test("a wrong or missing secret is refused at the manifest", async () => {
  const bytes = await build("right");
  await expect(readAll(bytes, "wrong")).rejects.toThrow("wrong passphrase or code");
  await expect(readAll(bytes)).rejects.toThrow("encrypted");
});

test("tampering, truncation, and reordering are caught", async () => {
  const bytes = await build("k");
  const flipped = bytes.slice();
  flipped[flipped.length - 40]! ^= 1;
  await expect(readAll(flipped, "k")).rejects.toBeInstanceOf(ArchiveError);
  // Cut anywhere after the manifest, including exactly before the end record.
  for (const cut of [200, bytes.length - 30, bytes.length - 1]) await expect(readAll(bytes.subarray(0, cut), "k")).rejects.toThrow(ArchiveError);
  const plain = await build();
  await expect(readAll(plain.subarray(0, plain.length - 5))).rejects.toThrow("ends early");
});

test("records can't be dropped or swapped in an encrypted archive", async () => {
  // Two one-record sections: swapping their data records breaks the nonce sequence.
  const bytes = await build("k", { env: [new Uint8Array([1])], postgres: [new Uint8Array([2])] });
  // Find record boundaries after the header.
  const view = new DataView(bytes.buffer);
  let at = 14;
  at += 4 + view.getUint32(at);
  const records: [number, number][] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    records.push([at, at + 4 + len]);
    at += 4 + len;
  }
  // manifest, env start, env data, env end, pg start, pg data, pg end, end
  const [a, b] = [records[2]!, records[5]!];
  const swapped = Buffer.concat([bytes.subarray(0, a[0]), bytes.subarray(b[0], b[1]), bytes.subarray(a[1], b[0]), bytes.subarray(a[0], a[1]), bytes.subarray(b[1])]);
  await expect(readAll(new Uint8Array(swapped), "k")).rejects.toThrow(ArchiveError);
});

test("not a backup", async () => {
  await expect(readAll(new TextEncoder().encode("hello world, not a backup at all"))).rejects.toThrow("not a mybase backup");
});

test("sections must be read in order", async () => {
  const r = new ArchiveReader(stream(await build()));
  await r.open();
  const env = await r.next();
  await expect(r.next()).rejects.toThrow("previous section");
  await skip(env!.data);
  expect((await r.next())?.name).toBe("postgres");
});

test("dropSuperuserCreate removes only the bootstrap superuser's CREATE ROLE", () => {
  const dump = "--\n-- Roles\n--\n\nCREATE ROLE mybase;\nALTER ROLE mybase WITH SUPERUSER LOGIN;\nCREATE ROLE shop;\nCREATE ROLE mybase2;\n";
  const out = dropSuperuserCreate(dump, "mybase");
  expect(out).not.toContain("CREATE ROLE mybase;");
  expect(out).toContain("ALTER ROLE mybase WITH SUPERUSER LOGIN;");
  expect(out).toContain("CREATE ROLE shop;");
  expect(out).toContain("CREATE ROLE mybase2;");
  expect(dropSuperuserCreate('CREATE ROLE "Admin.User";\n', "Admin.User")).toBe("");
  expect(dropSuperuserCreate("CREATE ROLE AdminXUser;\n", "Admin.User")).toBe("CREATE ROLE AdminXUser;\n");
});

test("compatible compares major.minor", () => {
  expect(compatible("1.0.14", "1.0.2")).toBe(true);
  expect(compatible("1.1.0", "1.0.14")).toBe(false);
});

test("codes are long and survive retyping", () => {
  const code = newCode();
  expect(normalizeCode(code).length).toBe(26);
  expect(normalizeCode(code.toLowerCase().replaceAll("-", " "))).toBe(normalizeCode(code));
  expect(newCode()).not.toBe(code);
});

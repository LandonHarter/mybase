// The `.mbk` format for `mybase server backup|restore|migrate`: a stream, so nothing is staged on
// disk (SD cards) and sections of unknown size (pg_dumpall, Garage) can flow straight through.
//
//   MAGIC, u32 header length, header JSON ({ format, encryption })
//   records: u32 length, body. Body = type byte + payload, or, when encrypted, AES-256-GCM of it
//   (12-byte nonce = 4 zero bytes + u64 record counter, 16-byte tag), so records can't be dropped,
//   reordered, or changed. The key is scrypt(secret, salt from the header).
//   Records: manifest, then per section: start (name), data…, end; then one `end` record. A stream
//   that stops before the `end` record is an error, never a short restore.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export const MAGIC = new TextEncoder().encode("MYBASE-BACKUP\n");
export const FORMAT = 1;
/** Largest data record. */
export const CHUNK = 1024 * 1024;
const MAX_RECORD = CHUNK + 1024;

const enum Type {
  Manifest = 1,
  SectionStart = 2,
  Data = 3,
  SectionEnd = 4,
  End = 5,
}

export type SectionName = "env" | "postgres" | "garage" | "valkey" | "registry";

export interface Manifest {
  format: number;
  /** The server's version (MYBASE_VERSION) when the backup was made. */
  version: string;
  /** CPU of the machine it came from (`x64`, `arm64`): hosted sites' images only run on the same one. */
  arch: string;
  hostname: string;
  createdAt: string;
  projects: number;
  sections: SectionName[];
}

interface Header {
  format: number;
  encryption: null | { kdf: "scrypt"; salt: string; N: number; r: number; p: number };
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };

function deriveKey(secret: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret.normalize("NFKC"), salt, 32, { ...params, maxmem: 128 * params.N * params.r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const nonce = (counter: number) => {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
};

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** The archive was damaged, cut short, or the secret is wrong. */
export class ArchiveError extends Error {}

/** A random code for `migrate`: 128 bits, as 26 base32 characters in groups. */
export function newCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = randomBytes(26);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return (chars.join("").match(/.{1,4}/g) ?? []).join("-");
}

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Same major.minor: a restore needs the CLI (compose.yml) and images the backup came from. */
export function compatible(a: string, b: string): boolean {
  const mm = (v: string) => v.split(".").slice(0, 2).join(".");
  return mm(a) === mm(b);
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────

export class ArchiveWriter {
  private key: Buffer | null = null;
  private counter = 0;
  /** Bytes per section, for progress. */
  readonly sizes: Partial<Record<SectionName, number>> = {};

  constructor(private sink: (bytes: Uint8Array) => Promise<void>) {}

  /** Writes the header. With a secret, every record after it is encrypted. */
  async start(secret?: string) {
    const header: Header = { format: FORMAT, encryption: null };
    if (secret) {
      const salt = randomBytes(16);
      this.key = await deriveKey(secret, salt);
      header.encryption = { kdf: "scrypt", salt: salt.toString("base64"), ...SCRYPT };
    }
    const json = new TextEncoder().encode(JSON.stringify(header));
    await this.sink(MAGIC);
    await this.sink(u32(json.length));
    await this.sink(json);
  }

  private async record(type: Type, payload: Uint8Array = new Uint8Array(0)) {
    let body = new Uint8Array(1 + payload.length);
    body[0] = type;
    body.set(payload, 1);
    if (this.key) {
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce(this.counter));
      body = new Uint8Array(Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]));
    }
    this.counter++;
    await this.sink(u32(body.length));
    await this.sink(body);
  }

  manifest(m: Manifest) {
    return this.record(Type.Manifest, new TextEncoder().encode(JSON.stringify(m)));
  }

  /** Copies `source` into a section, in records of at most CHUNK bytes. */
  async section(name: SectionName, source: AsyncIterable<Uint8Array>, progress?: (bytes: number) => void) {
    await this.record(Type.SectionStart, new TextEncoder().encode(name));
    let total = 0;
    for await (const chunk of source) {
      for (let at = 0; at < chunk.length; at += CHUNK) {
        const part = chunk.subarray(at, at + CHUNK);
        await this.record(Type.Data, part);
        total += part.length;
        progress?.(total);
      }
    }
    await this.record(Type.SectionEnd);
    this.sizes[name] = total;
  }

  end() {
    return this.record(Type.End);
  }
}

/**
 * A sink that writes to a WritableStream, waiting when it's full. `abort` also ends a write
 * that's waiting on a full stream (Bun leaves it pending when the reader went away, e.g. an
 * HTTP request body whose server already answered).
 */
export function streamSink(writable: WritableStream<Uint8Array>) {
  const writer = writable.getWriter();
  let fail!: (err: unknown) => void;
  const aborted = new Promise<never>((_, reject) => (fail = reject));
  aborted.catch(() => {});
  return {
    sink: async (bytes: Uint8Array) => {
      await Promise.race([writer.ready.then(() => writer.write(bytes)), aborted]);
    },
    close: () => Promise.race([writer.close(), aborted]),
    abort: (err: unknown) => {
      fail(err instanceof Error ? err : new Error(String(err)));
      writer.abort(err).catch(() => {});
    },
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

/** Reads exact byte counts from a stream. */
export class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

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

  async exact(n: number): Promise<Uint8Array> {
    if (!(await this.fill(n))) throw new ArchiveError("the backup ends early (incomplete file or interrupted transfer)");
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const first = this.chunks[0]!;
      const take = Math.min(first.length, n - at);
      out.set(first.subarray(0, take), at);
      at += take;
      if (take === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(take);
      this.buffered -= take;
    }
    return out;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }

  cancel() {
    return this.reader.cancel().catch(() => {});
  }
}

export interface Section {
  name: SectionName;
  /** The section's bytes. Read it to the end (or call `skip`) before asking for the next section. */
  data: AsyncIterable<Uint8Array>;
}

export class ArchiveReader {
  private r: ByteReader;
  private key: Buffer | null = null;
  private counter = 0;
  private header: Header | null = null;
  private pending = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.r = new ByteReader(stream.getReader());
  }

  /** Reads the header. Whether the archive needs a secret to open. */
  async readHeader(): Promise<{ encrypted: boolean }> {
    const magic = await this.r.exact(MAGIC.length).catch(() => new Uint8Array(0));
    if (magic.length !== MAGIC.length || magic.some((b, i) => b !== MAGIC[i])) throw new ArchiveError("not a mybase backup");
    const len = new DataView((await this.r.exact(4)).buffer).getUint32(0);
    if (len > 64 * 1024) throw new ArchiveError("not a mybase backup (bad header)");
    this.header = JSON.parse(new TextDecoder().decode(await this.r.exact(len))) as Header;
    if (this.header.format !== FORMAT) throw new ArchiveError(`this backup's format (${this.header.format}) is newer than this CLI understands: update the CLI`);
    return { encrypted: !!this.header.encryption };
  }

  /** Reads the manifest. Fails here when the secret is wrong. */
  async open(secret?: string): Promise<Manifest> {
    if (!this.header) await this.readHeader();
    const enc = this.header!.encryption;
    if (enc) {
      if (!secret) throw new ArchiveError("this backup is encrypted: a passphrase (or migration code) is needed");
      this.key = await deriveKey(secret, Buffer.from(enc.salt, "base64"), { N: enc.N, r: enc.r, p: enc.p });
    }
    const first = await this.record().catch((err) => {
      if (this.key && err instanceof ArchiveError && err.message.startsWith("damaged")) throw new ArchiveError("wrong passphrase or code");
      throw err;
    });
    if (first.type !== Type.Manifest) throw new ArchiveError("damaged backup: no manifest");
    return JSON.parse(new TextDecoder().decode(first.payload)) as Manifest;
  }

  private async record(): Promise<{ type: Type; payload: Uint8Array }> {
    const len = new DataView((await this.r.exact(4)).buffer).getUint32(0);
    if (len < 1 || len > MAX_RECORD + 16) throw new ArchiveError("damaged backup: bad record length");
    let body = await this.r.exact(len);
    if (this.key) {
      if (len < 17) throw new ArchiveError("damaged backup: record too short");
      try {
        const decipher = createDecipheriv("aes-256-gcm", this.key, nonce(this.counter));
        decipher.setAuthTag(body.subarray(len - 16));
        body = new Uint8Array(Buffer.concat([decipher.update(body.subarray(0, len - 16)), decipher.final()]));
      } catch {
        throw new ArchiveError("damaged backup: a record failed its integrity check");
      }
    }
    this.counter++;
    return { type: body[0] as Type, payload: body.subarray(1) };
  }

  /** The next section, or null after the last one (the archive's end is checked). */
  async next(): Promise<Section | null> {
    if (this.pending) throw new Error("read the previous section to its end first");
    const rec = await this.record();
    if (rec.type === Type.End) {
      if (!(await this.r.atEnd())) throw new ArchiveError("damaged backup: data after the end");
      return null;
    }
    if (rec.type !== Type.SectionStart) throw new ArchiveError("damaged backup: expected a section");
    const name = new TextDecoder().decode(rec.payload) as SectionName;
    this.pending = true;
    const self = this;
    async function* data() {
      for (;;) {
        const r = await self.record();
        if (r.type === Type.SectionEnd) break;
        if (r.type !== Type.Data) throw new ArchiveError("damaged backup: unexpected record in a section");
        yield r.payload;
      }
      self.pending = false;
    }
    return { name, data: data() };
  }

  cancel() {
    return this.r.cancel();
  }
}

/** Reads a whole section into memory (small ones: env). */
export async function collect(data: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of data) parts.push(chunk);
  return new Uint8Array(Buffer.concat(parts));
}

/** Reads and drops a section. */
export async function skip(data: AsyncIterable<Uint8Array>) {
  for await (const _ of data);
}

/**
 * pg_dumpall recreates every role, including the superuser the new server already made at first
 * boot, and `CREATE ROLE` for an existing role is an error. Drops that one statement from the
 * head of the dump (roles come first). Bytes are handled as latin1, so nothing else changes.
 */
export function dropSuperuserCreate(head: string, user: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = `"${user.replace(/"/g, '""')}"`;
  const names = /^[a-z_][a-z0-9_$]*$/.test(user) ? `(?:${escape(user)}|${escape(quoted)})` : escape(quoted);
  return head.replace(new RegExp(`^CREATE ROLE ${names};\\n`, "m"), "");
}

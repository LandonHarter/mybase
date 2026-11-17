// AWS binary event-stream (application/vnd.amazon.eventstream), as Bedrock's ConverseStream
// sends it. Each message: prelude (total length, headers length, prelude CRC32), headers,
// payload, message CRC32. Incremental: `feed` takes bytes as they arrive.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface EventMessage {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
}

function readHeaders(bytes: Uint8Array): EventMessage["headers"] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: EventMessage["headers"] = {};
  let i = 0;
  while (i < bytes.length) {
    const nameLen = bytes[i]!;
    const name = decoder.decode(bytes.subarray(i + 1, i + 1 + nameLen));
    i += 1 + nameLen;
    const type = bytes[i++]!;
    switch (type) {
      case 0:
        out[name] = true;
        break;
      case 1:
        out[name] = false;
        break;
      case 2:
        out[name] = view.getInt8(i);
        i += 1;
        break;
      case 3:
        out[name] = view.getInt16(i);
        i += 2;
        break;
      case 4:
        out[name] = view.getInt32(i);
        i += 4;
        break;
      case 5:
      case 8:
        out[name] = Number(view.getBigInt64(i));
        i += 8;
        break;
      case 6:
      case 7: {
        const len = view.getUint16(i);
        const value = bytes.subarray(i + 2, i + 2 + len);
        out[name] = type === 7 ? decoder.decode(value) : value.slice();
        i += 2 + len;
        break;
      }
      case 9:
        out[name] = bytes.slice(i, i + 16);
        i += 16;
        break;
      default:
        throw new Error(`event stream: unknown header type ${type}`);
    }
  }
  return out;
}

export class EventStreamDecoder {
  private buffer = new Uint8Array(0);

  feed(chunk: Uint8Array): EventMessage[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const out: EventMessage[] = [];
    while (this.buffer.length >= 12) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const total = view.getUint32(0);
      const headersLen = view.getUint32(4);
      if (total < 16 || headersLen > total - 16) throw new Error("event stream: bad prelude");
      if (crc32(this.buffer, 0, 8) !== view.getUint32(8)) throw new Error("event stream: prelude checksum mismatch");
      if (this.buffer.length < total) break;
      if (crc32(this.buffer, 0, total - 4) !== view.getUint32(total - 4)) throw new Error("event stream: message checksum mismatch");
      out.push({
        headers: readHeaders(this.buffer.subarray(12, 12 + headersLen)),
        payload: this.buffer.slice(12 + headersLen, total - 4),
      });
      this.buffer = this.buffer.slice(total);
    }
    return out;
  }
}

/** Builds one message (for tests and fixtures). String headers only. */
export function encodeEvent(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    parts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const headerBytes = new Uint8Array(parts);
  const total = 12 + headerBytes.length + payload.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out, 0, 8));
  out.set(headerBytes, 12);
  out.set(payload, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}

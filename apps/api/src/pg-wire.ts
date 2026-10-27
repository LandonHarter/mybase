// The few bits of the Postgres wire protocol the WebSocket proxy (db-proxy.ts) needs:
// reading the client's first message and writing an error back. No I/O, so it's easy to test.

const PROTOCOL_3 = 196608;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
/** Real startup messages are a few hundred bytes; anything this big isn't one. */
export const MAX_STARTUP_BYTES = 10_000;

export type FirstMessage =
  /** More bytes needed. */
  | { kind: "partial" }
  /** SSLRequest / GSSENCRequest: answer `N` and wait for the real startup. */
  | { kind: "encryption"; length: number }
  | { kind: "startup"; length: number; params: Map<string, string> }
  | { kind: "invalid"; reason: string };

/** Parses the start of `buf` as a client's first message (StartupMessage or a request code). */
export function parseFirstMessage(buf: Uint8Array): FirstMessage {
  if (buf.length < 8) return { kind: "partial" };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = view.getInt32(0);
  if (length < 8 || length > MAX_STARTUP_BYTES) return { kind: "invalid", reason: "bad startup length" };
  const code = view.getInt32(4);
  if (code === SSL_REQUEST || code === GSSENC_REQUEST) return length === 8 ? { kind: "encryption", length } : { kind: "invalid", reason: "bad request length" };
  if (code === CANCEL_REQUEST) return { kind: "invalid", reason: "cancel requests aren't supported over the proxy" };
  if (code !== PROTOCOL_3) return { kind: "invalid", reason: "unsupported protocol version" };
  if (buf.length < length) return { kind: "partial" };

  // Null-terminated key/value pairs, ended by an empty key.
  const params = new Map<string, string>();
  const strings = new TextDecoder().decode(buf.subarray(8, length)).split("\0");
  for (let i = 0; i + 1 < strings.length && strings[i]; i += 2) params.set(strings[i]!, strings[i + 1]!);
  return { kind: "startup", length, params };
}

/** A FATAL ErrorResponse, so the client shows `message` instead of a bare disconnect. */
export function errorResponse(code: string, message: string): Uint8Array {
  const fields = `SFATAL\0VFATAL\0C${code}\0M${message}\0\0`;
  const body = new TextEncoder().encode(fields);
  const out = new Uint8Array(5 + body.length);
  out[0] = "E".charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

import { expect, test } from "bun:test";
import { errorResponse, parseFirstMessage } from "./pg-wire";

function startup(params: Record<string, string>): Uint8Array {
  const body = new TextEncoder().encode(Object.entries(params).map(([k, v]) => `${k}\0${v}\0`).join("") + "\0");
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, out.length);
  view.setInt32(4, 196608);
  out.set(body, 8);
  return out;
}

const code = (n: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setInt32(0, 8);
  new DataView(out.buffer).setInt32(4, n);
  return out;
};

test("parses a startup message", () => {
  const msg = parseFirstMessage(startup({ user: "recipes", database: "recipes", client_encoding: "UTF8" }));
  expect(msg.kind).toBe("startup");
  if (msg.kind !== "startup") return;
  expect(msg.params.get("user")).toBe("recipes");
  expect(msg.params.get("database")).toBe("recipes");
  expect(msg.params.get("client_encoding")).toBe("UTF8");
});

test("waits for the rest of a split message", () => {
  const full = startup({ user: "recipes" });
  expect(parseFirstMessage(full.subarray(0, 5)).kind).toBe("partial");
  expect(parseFirstMessage(full.subarray(0, full.length - 1)).kind).toBe("partial");
});

test("ignores bytes after the startup message", () => {
  const full = startup({ user: "recipes" });
  const withMore = new Uint8Array(full.length + 10);
  withMore.set(full);
  const msg = parseFirstMessage(withMore);
  expect(msg.kind === "startup" && msg.length).toBe(full.length);
});

test("SSLRequest and GSSENCRequest ask for encryption", () => {
  expect(parseFirstMessage(code(80877103)).kind).toBe("encryption");
  expect(parseFirstMessage(code(80877104)).kind).toBe("encryption");
});

test("rejects cancel requests, other protocols, and bad lengths", () => {
  expect(parseFirstMessage(code(80877102)).kind).toBe("invalid");
  expect(parseFirstMessage(code(131072)).kind).toBe("invalid");
  const huge = code(196608);
  new DataView(huge.buffer).setInt32(0, 1_000_000);
  expect(parseFirstMessage(huge).kind).toBe("invalid");
});

test("errorResponse is a well-formed ErrorResponse", () => {
  const msg = errorResponse("28000", "nope");
  expect(String.fromCharCode(msg[0]!)).toBe("E");
  expect(new DataView(msg.buffer).getInt32(1)).toBe(msg.length - 1);
  expect(new TextDecoder().decode(msg.subarray(5))).toContain("Mnope\0");
});

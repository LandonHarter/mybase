import { expect, test } from "bun:test";
import { composeEnv, guessLevel, logService, splitComposeLine, tunnelConnections } from "./server-docker";

test("composeEnv drops variables compose.yml reads, so a cwd .env can't override the server's", () => {
  process.env.POSTGRES_PORT = "5433";
  process.env.COMPOSE_PROFILES = "tunnel";
  process.env.MYBASE_RESTART = "no";
  const env = composeEnv();
  expect(env.POSTGRES_PORT).toBeUndefined();
  expect(env.COMPOSE_PROFILES).toBeUndefined();
  expect(env.MYBASE_RESTART).toBeUndefined();
  expect(env.PATH).toBe(process.env.PATH);
});

test("tunnelConnections keeps each connection's latest state since the last start", () => {
  const logs = [
    "2026-10-28T17:00:00Z INF Starting tunnel tunnelID=abc",
    "2026-10-28T17:00:01Z INF Registered tunnel connection connIndex=0 connection=x event=0 ip=198.41.192.27 location=nrt01 protocol=quic",
    "2026-10-28T17:30:00Z INF Starting tunnel tunnelID=abc",
    "2026-10-28T17:30:01Z INF Registered tunnel connection connIndex=0 connection=a event=0 ip=198.41.192.27 location=ord08 protocol=quic",
    "2026-10-28T17:30:01Z INF Registered tunnel connection connIndex=1 connection=b event=0 ip=198.41.200.13 location=dtw01 protocol=quic",
    "2026-10-28T17:40:00Z ERR Serve tunnel error error=\"timeout\" connIndex=1 event=0 ip=198.41.200.13",
    "2026-10-28T17:40:00Z INF Retrying connection in up to 2s connIndex=1 event=0 ip=198.41.200.13",
  ].join("\n");
  expect(tunnelConnections(logs)).toEqual([{ index: 0, location: "ord08", protocol: "quic" }]);
  expect(tunnelConnections("no tunnel here")).toEqual([]);
});

test("splitComposeLine reads the service off compose's prefix, old and new", () => {
  expect(splitComposeLine('mybase-1       | {"level":"info"}')).toEqual({ service: "mybase", text: '{"level":"info"}' });
  expect(splitComposeLine("postgres_1  | LOG:  checkpoint starting: time")).toEqual({ service: "postgres", text: "LOG:  checkpoint starting: time" });
  expect(splitComposeLine("cloudflared-1  |")).toEqual({ service: "cloudflared", text: "" });
  expect(splitComposeLine("no such service: nope")).toBeNull();
});

test("logService maps aliases to compose services", () => {
  expect(logService("api")).toBe("mybase");
  expect(logService("Postgres")).toBe("postgres");
  expect(logService("tunnel")).toBe("cloudflared");
  expect(logService("nope")).toBeNull();
});

test("guessLevel reads other services' markers", () => {
  expect(guessLevel('2026-10-28 17:00:00 UTC [1] ERROR:  relation "x" does not exist')).toBe("error");
  expect(guessLevel("2026-10-28 17:00:00 UTC [1] FATAL:  password authentication failed")).toBe("error");
  expect(guessLevel("2026-10-28T17:00:00Z WRN Connection lost")).toBe("warn");
  expect(guessLevel("2026-10-28T17:00:00Z  INFO garage: no error here")).toBe("info");
});

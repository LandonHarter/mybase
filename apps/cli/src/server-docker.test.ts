import { expect, test } from "bun:test";
import { composeEnv, tunnelConnections } from "./server-docker";

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

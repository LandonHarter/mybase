import { expect, test } from "bun:test";
import { composeEnv } from "./server-docker";

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

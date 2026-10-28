import { expect, test } from "bun:test";
import { prettyJsonLine } from "./logger";

test("prettyJsonLine renders LOG_FORMAT=json lines like the pretty format", () => {
  process.env.NO_COLOR = "1";
  const line = JSON.stringify({
    time: "2026-10-28T17:00:01.234Z",
    level: "error",
    service: "cron",
    msg: "call failed",
    job: "nightly",
    err: { name: "TypeError", message: "boom", stack: "TypeError: boom\n    at x (a.ts:1)" },
  });
  const out = prettyJsonLine(line)!;
  expect(out.level).toBe("error");
  expect(out.text).toBe('17:00:01.234 ERROR [cron] call failed job=nightly err="boom"\nTypeError: boom\n    at x (a.ts:1)');
  expect(prettyJsonLine("LOG:  checkpoint starting")).toBeNull();
  expect(prettyJsonLine('{"level":"loud","service":"x","msg":"y"}')).toBeNull();
});

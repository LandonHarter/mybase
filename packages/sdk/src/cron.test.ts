import { describe, expect, test } from "bun:test";
import { defineConfig } from "./config";
import { cronHandler, CronVerificationError, signCronRequest, verifyCronSignature, type CronRun } from "./cron";

const secret = "mbcron_test";
const run: CronRun = {
  job: "cleanup",
  runId: "00000000-0000-0000-0000-000000000000",
  attempt: 1,
  trigger: "schedule",
  scheduledAt: new Date().toISOString(),
  firedAt: new Date().toISOString(),
  payload: { days: 30 },
};
const body = JSON.stringify(run);

async function request(b = body, s = secret, t?: number) {
  return new Request("http://app.test/api/cron", {
    method: "POST",
    body: b,
    headers: { "Content-Type": "application/json", "X-Mybase-Signature": await signCronRequest(s, b, t) },
  });
}

describe("verifyCronSignature", () => {
  test("accepts a fresh signature", async () => {
    await verifyCronSignature({ body, signature: await signCronRequest(secret, body), secret });
  });

  test("rejects a tampered body", async () => {
    const signature = await signCronRequest(secret, body);
    expect(verifyCronSignature({ body: body.replace("30", "31"), signature, secret })).rejects.toThrow(CronVerificationError);
  });

  test("rejects the wrong secret", async () => {
    const signature = await signCronRequest("other", body);
    expect(verifyCronSignature({ body, signature, secret })).rejects.toThrow("does not match");
  });

  test("rejects an old timestamp", async () => {
    const signature = await signCronRequest(secret, body, Math.floor(Date.now() / 1000) - 600);
    expect(verifyCronSignature({ body, signature, secret })).rejects.toThrow("tolerance");
  });

  test("rejects missing and malformed headers", async () => {
    expect(verifyCronSignature({ body, signature: null, secret })).rejects.toThrow("missing");
    expect(verifyCronSignature({ body, signature: "v1=abc", secret })).rejects.toThrow("malformed");
  });

  test("accepts any of several secrets", async () => {
    const signature = await signCronRequest(secret, body);
    await verifyCronSignature({ body, signature, secret: ["new", secret] });
  });

  test("rejects an empty secret", async () => {
    const signature = await signCronRequest(secret, body);
    expect(verifyCronSignature({ body, signature, secret: "" })).rejects.toThrow("no cron secret");
  });
});

describe("cronHandler", () => {
  const config = defineConfig({ project: "shop", cron: { baseUrl: "http://app.test", jobs: { cleanup: { schedule: "0 3 * * *" } } } });
  let seen: CronRun | undefined;
  const handler = cronHandler<typeof config>({
    secret,
    jobs: {
      cleanup: (r) => {
        seen = r;
      },
    },
    onError: () => {},
  });

  test("runs the job and returns 200", async () => {
    const res = await handler(await request());
    expect(res.status).toBe(200);
    expect(seen?.payload).toEqual({ days: 30 });
  });

  test("401 on a bad signature", async () => {
    expect((await handler(await request(body, "wrong"))).status).toBe(401);
  });

  test("404 on an unknown job", async () => {
    expect((await handler(await request(JSON.stringify({ ...run, job: "nope" })))).status).toBe(404);
  });

  test("500 when the job throws", async () => {
    const failing = cronHandler({
      secret,
      jobs: {
        cleanup: () => {
          throw new Error("boom");
        },
      },
      onError: () => {},
    });
    expect((await failing(await request())).status).toBe(500);
  });

  test("405 on GET", async () => {
    expect((await handler(new Request("http://app.test/api/cron"))).status).toBe(405);
  });
});

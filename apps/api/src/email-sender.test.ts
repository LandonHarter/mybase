// Sender loop without Postgres: a fake `sql` answers the sender's queries by their text.
import { afterEach, describe, expect, test } from "bun:test";
import { AwsError, type AwsEmailClient } from "./email-aws";
import { isQuotaOrPaused, isThrottle, reserveSlot, resetSenderForTests, setSenderDepsForTests, tickForTests } from "./email-sender";
import { setSesClientForTests } from "./email-ses";

afterEach(() => {
  resetSenderForTests();
  setSesClientForTests(null);
});

describe("pacing", () => {
  test("a message reserves one slot per recipient", () => {
    resetSenderForTests();
    expect(reserveSlot(3, 1, 0)).toBe(0);
    expect(reserveSlot(1, 1, 0)).toBe(3000); // the 3-recipient message took 3 s at 1/s
    expect(reserveSlot(1, 10, 3000)).toBe(1000); // then 100 ms per recipient at 10/s
  });
});

describe("SES error classes", () => {
  test("rate throttling retries; daily quota and paused sending wait", () => {
    const throttle = new AwsError("ses", 429, "TooManyRequestsException", "Maximum sending rate exceeded.");
    expect(isQuotaOrPaused(throttle)).toBe(false);
    expect(isThrottle(throttle)).toBe(true);
    expect(isQuotaOrPaused(new AwsError("ses", 400, "LimitExceededException", "Daily message quota exceeded."))).toBe(true);
    expect(isQuotaOrPaused(new AwsError("ses", 400, "SendingPausedException", "Sending paused for this account."))).toBe(true);
    expect(isQuotaOrPaused(new AwsError("ses", 400, "MessageRejected", "Email address is not verified."))).toBe(false);
  });
});

describe("loop", () => {
  test("at 1/s with a send in progress and a backlog, the loop doesn't keep querying", async () => {
    let nextQueries = 0;
    let claimQueries = 0;
    const due = ["a", "b", "c"].map((id) => ({
      id: `00000000-0000-0000-0000-00000000000${id}`,
      project: "shop",
      from: "hi@acme.com",
      to: ["x@y.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "s",
      html: null,
      text: "t",
      attachments: [],
      configurationSet: "mybase",
      attempts: 1,
    }));
    const result = (rows: unknown[]) => Object.assign(Promise.resolve(Object.assign(rows, { count: rows.length })), {});
    const fakeSql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      if (!("raw" in strings)) return { list: strings };
      const q = strings.join("$");
      if (q.includes("set status = 'sending'")) {
        claimQueries++;
        return result(due.splice(0, values[0] as number));
      }
      if (q.includes('send_at as "sendAt"')) {
        nextQueries++;
        return result(due.length ? [{ sendAt: new Date(Date.now() - 1000) }] : []);
      }
      if (q.includes("email_suppressions")) return result([{ n: 0 }]);
      return result([]);
    }) as unknown as typeof import("./postgres").sql;
    setSenderDepsForTests({ sql: fakeSql });
    setSesClientForTests({
      region: "us-east-1",
      getAccount: async () => ({ SendQuota: { MaxSendRate: 1 } }),
      sendEmail: () => new Promise(() => {}), // never answers: the one slot stays busy
    } as unknown as AwsEmailClient);

    await tickForTests();
    await Bun.sleep(200);
    expect(claimQueries).toBe(1);
    expect(nextQueries).toBeLessThanOrEqual(3);
    expect(due).toHaveLength(2); // only one claimed at rate 1
  });
});

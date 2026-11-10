// Needs Postgres (the dev one from `bun run db:up`, or POSTGRES_* in the env); skipped without it.
// Regression: content sends (no template) failed with a 500 because Bun SQL sent the recipient
// arrays as plain strings into text[] columns ("malformed array literal").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@mybase/shared/logger";
import { AwsError, type AwsEmailClient, type SesSendInput } from "./email-aws";
import { recordEvents } from "./email-events";
import { migrate } from "./control";
import { addDomain, emailService, removeDomain, send, sendTest } from "./email";
import { resetSenderForTests, sendNowForTests, setSenderDepsForTests, stopSender } from "./email-sender";
import { setSesClientForTests } from "./email-ses";
import { sql } from "./postgres";

const reachable = await Promise.race([
  sql`select 1`.then(() => true, () => false),
  Bun.sleep(2000).then(() => false),
]);

const PROJECT = "zz_email_send_test";
const DOMAIN = "zz-email-send-test.invalid";
// Far enough ahead that the sender never claims it during the test.
const LATER = () => new Date(Date.now() + 86_400_000).toISOString();

describe.skipIf(!reachable)("email send (Postgres)", () => {
  beforeAll(async () => {
    await migrate(createLogger("test"));
    await sql`delete from mybase.email_projects where project = ${PROJECT}`;
    await sql`insert into mybase.email_projects (project) values (${PROJECT})`;
    await sql`insert into mybase.email_domains (domain, project, status, dns) values (${DOMAIN}, ${PROJECT}, 'verified', 'manual')`;
    setSesClientForTests({ region: "us-east-1" } as AwsEmailClient);
  });

  afterAll(async () => {
    stopSender();
    resetSenderForTests();
    setSesClientForTests(null);
    await sql`delete from mybase.email_projects where project = ${PROJECT}`;
  });

  test("queues content (no template) on a project with a verified domain and no templates", async () => {
    const res = await send(PROJECT, { from: `Test <oauth@${DOMAIN}>`, to: ["success@simulator.amazonses.com"], subject: "t", text: "t", sendAt: LATER() });
    expect(res.status).toBe("queued");
    const [row]: { to_addresses: string[]; cc_addresses: string[]; reply_to: string[]; template_id: string | null; html: string | null; text: string }[] = await sql`
      select to_addresses, cc_addresses, reply_to, template_id, html, text from mybase.email_messages where id = ${res.id}`;
    expect(row).toMatchObject({ to_addresses: ["success@simulator.amazonses.com"], cc_addresses: [], reply_to: [], template_id: null, html: null, text: "t" });
  });

  test("keeps several recipients, cc, bcc, and reply-to as arrays", async () => {
    const res = await send(PROJECT, {
      from: `oauth@${DOMAIN}`,
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      replyTo: ["e@example.com"],
      subject: "t",
      html: "<p>t</p>",
      sendAt: LATER(),
    });
    const [row]: Record<string, string[]>[] = await sql`
      select to_addresses, cc_addresses, bcc_addresses, reply_to from mybase.email_messages where id = ${res.id}`;
    expect(row).toEqual({ to_addresses: ["a@example.com", "b@example.com"], cc_addresses: ["c@example.com"], bcc_addresses: ["d@example.com"], reply_to: ["e@example.com"] });
  });

  test("send test takes one address and respects suppressions", async () => {
    await sql`
      insert into mybase.email_templates (project, id, name, subject, from_address, html, text, source, variables, source_kind)
      values (${PROJECT}, 'zz-test', 'zz-test', 'Hi {{name}}', ${`oauth@${DOMAIN}`}, '<p>Hi {{name}}</p>', 'Hi {{name}}', 'x',
        ${JSON.stringify([{ name: "name", sample: "Ann" }])}::text::jsonb, 'dashboard')
      on conflict (project, id) do nothing`;
    await expect(sendTest(PROJECT, "zz-test", { to: ["a@example.com", "b@example.com"] })).rejects.toThrow("one email address");
    const address = `test-sup-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await sql`insert into mybase.email_suppressions (project, address, reason) values (${PROJECT}, ${address}, 'bounce')`;
    await expect(sendTest(PROJECT, "zz-test", { to: address })).rejects.toThrow("suppressed");
  });

  test("concurrent sends with one idempotency key make one message", async () => {
    const key = `race-${crypto.randomUUID()}`;
    const body = { from: `oauth@${DOMAIN}`, to: ["a@example.com"], subject: "t", text: "t", sendAt: LATER(), idempotencyKey: key };
    const [a, b] = await Promise.all([send(PROJECT, body), send(PROJECT, body)]);
    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
    const [{ n }]: { n: number }[] = await sql`select count(*)::int as n from mybase.email_messages where project = ${PROJECT} and idempotency_key = ${key}`;
    expect(n).toBe(1);
  });

  test("an idempotency key older than 24 h makes a new message", async () => {
    const key = `old-${crypto.randomUUID()}`;
    const body = { from: `oauth@${DOMAIN}`, to: ["a@example.com"], subject: "t", text: "t", sendAt: LATER(), idempotencyKey: key };
    const first = await send(PROJECT, body);
    await sql`update mybase.email_messages set created_at = now() - interval '25 hours' where id = ${first.id}`;
    const second = await send(PROJECT, body);
    expect(second.id).not.toBe(first.id);
    expect(second.duplicate).toBeUndefined();
  });

});

// ---- the sender, one claimed message at a time (sendNowForTests never touches other rows) ----

describe.skipIf(!reachable)("email sender (Postgres)", () => {
  const sent: SesSendInput[] = [];
  let sendEmail: (input: SesSendInput) => Promise<{ messageId: string }> = async () => ({ messageId: "m" });

  beforeAll(async () => {
    await migrate(createLogger("test"));
    await sql`delete from mybase.email_projects where project = ${PROJECT}`;
    await sql`insert into mybase.email_projects (project) values (${PROJECT})`;
    await sql`insert into mybase.email_domains (domain, project, status, dns) values (${DOMAIN}, ${PROJECT}, 'verified', 'manual')`;
  });

  const useSes = () => {
    setSesClientForTests({
      region: "us-east-1",
      getAccount: async () => ({ SendQuota: { MaxSendRate: 100 } }),
      sendEmail: (input: SesSendInput) => {
        sent.push(input);
        return sendEmail(input);
      },
    } as unknown as AwsEmailClient);
    setSenderDepsForTests({ sleep: async () => {} });
  };

  afterAll(async () => {
    resetSenderForTests();
    setSesClientForTests(null);
    await sql`delete from mybase.email_projects where project = ${PROJECT}`;
  });

  const queue = async (to = "a@example.com") => {
    useSes();
    sent.length = 0;
    const res = await send(PROJECT, { from: `oauth@${DOMAIN}`, to: [to], subject: "t", text: "t", sendAt: LATER() });
    return res.id;
  };
  const row = async (id: string) => {
    const [r]: { status: string; ses_message_id: string | null; error: string | null }[] = await sql`
      select status, ses_message_id, error from mybase.email_messages where id = ${id}`;
    return r!;
  };
  const failedEvents = async (id: string) => {
    const [{ n }]: { n: number }[] = await sql`select count(*)::int as n from mybase.email_events where message_id = ${id} and type = 'failed'`;
    return n;
  };

  test("a DB error after SES accepted the message doesn't send it again", async () => {
    const id = await queue();
    sendEmail = async () => ({ messageId: "ses-accepted-1" });
    let failures = 1;
    const flaky = new Proxy(sql, {
      apply(target, thisArg, args) {
        const [strings] = args as [unknown];
        if (failures > 0 && Array.isArray(strings) && "raw" in strings && strings.join("").includes("ses_message_id =")) {
          failures--;
          return Promise.reject(new Error("connection reset"));
        }
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
      get(target, prop) {
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    setSenderDepsForTests({ sql: flaky as typeof sql });
    await sendNowForTests(id);
    setSenderDepsForTests({ sql });
    expect(sent).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "sent", ses_message_id: "ses-accepted-1" });
  });

  test("the last attempt failing doesn't overwrite a delivered message", async () => {
    const id = await queue();
    await sql`update mybase.email_messages set attempts = 3 where id = ${id}`;
    sendEmail = async () => {
      await sql`update mybase.email_messages set status = 'delivered' where id = ${id}`;
      throw new AwsError("ses", 503, "ServiceUnavailable", "try later");
    };
    await sendNowForTests(id);
    expect((await row(id)).status).toBe("delivered");
    expect(await failedEvents(id)).toBe(0);
  });

  test("an address suppressed after queueing isn't sent to", async () => {
    const address = `late-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const id = await queue(address);
    await sql`insert into mybase.email_suppressions (project, address, reason) values (${PROJECT}, ${address}, 'complaint')`;
    await sendNowForTests(id);
    expect(sent).toHaveLength(0);
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("suppressed: 1 recipient");
    expect(r.error).not.toContain(address);
    expect(await failedEvents(id)).toBe(1);
  });

  test("a stored attachment over the limit (or grown since queueing) is never read or sent", async () => {
    let reads = 0;
    const object = (size: number, actual: number) => ({
      exists: async () => true,
      stat: async () => ({ size }),
      slice: () => ({ arrayBuffer: async () => (reads++, new ArrayBuffer(actual)) }),
    });
    for (const [size, actual, expectReads, error] of [
      [11 * 1024 * 1024, 11 * 1024 * 1024, 0, "over 10 MB"],
      [10, 11, 1, "changed while sending"],
    ] as const) {
      const id = await queue();
      await sql`update mybase.email_messages set attachments = ${JSON.stringify([{ filename: "big.bin", contentType: "application/octet-stream", size: 1, storageKey: "big.bin" }])}::text::jsonb where id = ${id}`;
      reads = 0;
      setSenderDepsForTests({ file: (() => object(size, actual)) as never });
      await sendNowForTests(id);
      expect(sent).toHaveLength(0);
      expect(reads).toBe(expectReads);
      const r = await row(id);
      expect(r.status).toBe("failed");
      expect(r.error).toContain(error);
    }
  });

  test("a complaint for a pruned message still suppresses, for projects with email on", async () => {
    const address = `pruned-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const event = (project: string) => ({
      sesMessageId: `ses-${crypto.randomUUID()}`,
      messageId: crypto.randomUUID(),
      project,
      type: "complaint" as const,
      at: new Date().toISOString(),
      detail: null,
      status: "complained" as const,
      suppress: [{ address, reason: "complaint" as const }],
    });
    expect(await recordEvents([event(PROJECT), event("zz_no_email_here")])).toBe(1);
    const rows: { project: string }[] = await sql`select project from mybase.email_suppressions where address = ${address}`;
    expect(rows.map((r) => r.project)).toEqual([PROJECT]);
  });
});

// ---- domains: identities mybase only adopted stay in SES ----

describe.skipIf(!reachable)("email domains (Postgres)", () => {
  const P = "zz_email_domain_test";
  const calls: string[] = [];
  const known = new Set<string>();
  let failDelete: string | null = null;
  const log = createLogger("test");

  beforeAll(async () => {
    await migrate(log);
    delete process.env.MYBASE_DNS_TOKEN;
    await sql`delete from mybase.email_projects where project = ${P}`;
    await sql`insert into mybase.email_projects (project) values (${P})`;
    setSesClientForTests({
      region: "us-east-1",
      getIdentity: async (d: string) =>
        known.has(d) ? { VerifiedForSendingStatus: true, DkimAttributes: { Tokens: ["t1"] }, MailFromAttributes: { MailFromDomain: `old.${d}` } } : null,
      createIdentity: async (d: string) => (calls.push(`create ${d}`), { DkimAttributes: { Tokens: ["t1"] } }),
      setMailFrom: async (d: string, m: string | null) => void calls.push(`mailfrom ${d} ${m}`),
      deleteIdentity: async (d: string) => {
        calls.push(`delete ${d}`);
        if (d === failDelete) throw new AwsError("ses", 500, "InternalFailure", "boom");
      },
    } as unknown as AwsEmailClient);
  });

  afterAll(async () => {
    setSesClientForTests(null);
    await sql`delete from mybase.email_projects where project = ${P}`;
  });

  test("adopted identity: remove keeps it and restores MAIL FROM; created one is deleted", async () => {
    const adopted = "zz-adopted.invalid";
    const created = "zz-created.invalid";
    known.add(adopted);
    calls.length = 0;
    await addDomain(P, { domain: adopted }, log);
    await addDomain(P, { domain: created }, log);
    const res = await removeDomain(P, adopted, log);
    expect(res.warning).toContain("kept");
    await removeDomain(P, created, log);
    expect(calls).not.toContain(`delete ${adopted}`);
    expect(calls).toContain(`mailfrom ${adopted} old.${adopted}`);
    expect(calls).toContain(`delete ${created}`);
  });

  test("disable keeps going past one failing SES delete and removes local state", async () => {
    calls.length = 0;
    await addDomain(P, { domain: "zz-a.invalid" }, log);
    await addDomain(P, { domain: "zz-b.invalid" }, log);
    failDelete = "zz-a.invalid";
    await emailService.disable(P, log);
    expect(calls).toContain("delete zz-a.invalid");
    expect(calls).toContain("delete zz-b.invalid");
    const rows = await sql`select 1 from mybase.email_domains where project = ${P}`;
    expect(rows).toHaveLength(0);
  });
});

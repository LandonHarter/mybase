// Needs Postgres (the dev one from `bun run db:up`, or POSTGRES_* in the env); skipped without it.
// Regression: content sends (no template) failed with a 500 because Bun SQL sent the recipient
// arrays as plain strings into text[] columns ("malformed array literal").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@mybase/shared/logger";
import type { AwsEmailClient } from "./email-aws";
import { migrate } from "./control";
import { send } from "./email";
import { stopSender } from "./email-sender";
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
});

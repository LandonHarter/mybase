import { describe, expect, test } from "bun:test";
import type { Cloudflare, DnsRecord } from "@mybase/shared/cloudflare";
import { addressDomain, applyDns, domainRecords, fromAllowed, normalizeDomain, parseAddress, removeDns } from "./email-domains";
import { mapSesEvent, statusRank } from "./email-events";
import { fillTemplate, formatAddress, parseAttachments, parseSend, parseSyncTemplates, parseTemplateVariables, parseVariables, placeholders, sizeAttachments } from "./email-input";

describe("fillTemplate", () => {
  const t = { subject: "Hi {{name}}", html: "<p>Hello {{ name }}, code {{code}}</p>", text: "Hello {{name}}" };

  test("escapes html, keeps text, flattens subject", () => {
    const out = fillTemplate(t, { name: '<b>"Ann"</b>\r\nBcc: x@y.com', code: "42" }, []);
    expect(out.html).toBe("<p>Hello &lt;b&gt;&quot;Ann&quot;&lt;/b&gt;\r\nBcc: x@y.com, code 42</p>");
    expect(out.text).toBe('Hello <b>"Ann"</b>\r\nBcc: x@y.com');
    expect(out.subject).toBe('Hi <b>"Ann"</b> Bcc: x@y.com');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  test("missing variables are named", () => {
    expect(() => fillTemplate(t, { name: "a" }, [])).toThrow("missing variables: code");
    expect(() => fillTemplate({ subject: "s", html: "h", text: "" }, {}, ["x"])).toThrow("missing variables: x");
  });

  test("a value containing {{other}} is not filled again", () => {
    expect(fillTemplate({ subject: "s", html: "{{a}}", text: "" }, { a: "{{b}}", b: "x" }, []).html).toBe("{{b}}");
  });

  test("placeholders lists names once", () => {
    expect(placeholders("{{a}} {{ b }}", "{{a}} {{c}} {{9x}}")).toEqual(["a", "b", "c"]);
  });
});

describe("parseSend", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("template send", () => {
    const r = parseSend({ template: "welcome", to: "Ann <ANN@Example.com>", variables: { name: "Ann", n: 3 } }, now);
    expect(r.template).toBe("welcome");
    expect(r.to).toEqual(['"Ann" <ann@example.com>']);
    expect(r.variables).toEqual({ name: "Ann", n: "3" });
    expect(r.from).toBeNull();
  });

  test("content send needs from, subject, and a body", () => {
    expect(() => parseSend({ to: "a@b.com", subject: "s", html: "h" }, now)).toThrow("from is required");
    expect(() => parseSend({ from: "x@y.com", to: "a@b.com", html: "h" }, now)).toThrow("subject is required");
    expect(() => parseSend({ from: "x@y.com", to: "a@b.com", subject: "s" }, now)).toThrow("html or text");
    const r = parseSend({ from: "x@y.com", to: ["a@b.com"], subject: "s\nBcc: evil", text: "t" }, now);
    expect(r.subject).toBe("s Bcc: evil");
  });

  test("template and content don't mix", () => {
    expect(() => parseSend({ template: "w", to: "a@b.com", html: "x" }, now)).toThrow("come from the template");
    expect(() => parseSend({ from: "x@y.com", to: "a@b.com", subject: "s", text: "t", variables: {} }, now)).toThrow("only work with a template");
  });

  test("recipient checks", () => {
    expect(() => parseSend({ template: "w", to: [] }, now)).toThrow("at least one");
    expect(() => parseSend({ template: "w", to: "not an email" }, now)).toThrow("isn't an email address");
    expect(() => parseSend({ template: "w", to: "a@b.com\r\nBcc: c@d.com" }, now)).toThrow("isn't an email address");
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@b.com`);
    expect(() => parseSend({ template: "w", to: many }, now)).toThrow("at most 50");
  });

  test("sendAt: past = now, far future refused", () => {
    expect(parseSend({ template: "w", to: "a@b.com", sendAt: "2025-01-01T00:00:00Z" }, now).sendAt).toBeNull();
    expect(parseSend({ template: "w", to: "a@b.com", sendAt: "2026-01-02T00:00:00Z" }, now).sendAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(() => parseSend({ template: "w", to: "a@b.com", sendAt: "2026-03-01T00:00:00Z" }, now)).toThrow("30 days");
    expect(() => parseSend({ template: "w", to: "a@b.com", sendAt: "soon" }, now)).toThrow("ISO date");
  });

  test("tags and idempotency key", () => {
    expect(parseSend({ template: "w", to: "a@b.com", tags: { kind: "receipt" }, idempotencyKey: "o-1" }, now)).toMatchObject({ tags: { kind: "receipt" }, idempotencyKey: "o-1" });
    expect(() => parseSend({ template: "w", to: "a@b.com", tags: { "bad key": "x" } }, now)).toThrow("tag");
    expect(() => parseSend({ template: "w", to: "a@b.com", idempotencyKey: "" }, now)).toThrow("idempotencyKey");
  });
});

describe("parseAttachments", () => {
  test("base64 and storage keys", () => {
    const [a, b] = parseAttachments([
      { filename: "hi.txt", content: Buffer.from("hi").toString("base64") },
      { filename: "r.pdf", storageKey: "receipts/1.pdf" },
    ]);
    expect(a).toMatchObject({ filename: "hi.txt", contentType: "text/plain", storageKey: null });
    expect(new TextDecoder().decode(a!.content!)).toBe("hi");
    expect(b).toMatchObject({ filename: "r.pdf", contentType: "application/pdf", content: null, storageKey: "receipts/1.pdf" });
  });

  test("refusals", () => {
    expect(() => parseAttachments([{ filename: "run.exe", content: "aGk=" }])).toThrow(".exe");
    expect(() => parseAttachments([{ filename: "a.txt" }])).toThrow("either content");
    expect(() => parseAttachments([{ filename: "a.txt", content: "aGk=", storageKey: "x" }])).toThrow("either content");
    expect(() => parseAttachments([{ filename: "a.txt", storageKey: "../other/x" }])).toThrow("storageKey");
    expect(() => parseAttachments([{ filename: 'a"b.txt', content: "aGk=" }])).toThrow("plain filename");
    expect(() => parseAttachments([{ filename: "a.txt", content: "not base64!" }])).toThrow("base64");
    const big = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    expect(() => parseAttachments([{ filename: "a.bin", content: big }, { filename: "b.bin", content: big }])).toThrow("over 10 MB");
  });
});

describe("templates", () => {
  test("placeholders without a declared variable are added", () => {
    const vars = parseTemplateVariables([{ name: "name", sample: "Ann" }], { subject: "Hi {{name}}", html: "{{code}}", text: "" });
    expect(vars).toEqual([
      { name: "name", sample: "Ann" },
      { name: "code", sample: "" },
    ]);
    expect(() => parseTemplateVariables([{ name: "a" }, { name: "a" }], { subject: "", html: "", text: "" })).toThrow("unique");
  });

  test("sync payload", () => {
    const [t] = parseSyncTemplates([{ id: "welcome", subject: "Hi {{name}}", html: "<p>{{name}}</p>", text: "{{name}}", variables: [{ name: "name", sample: "Ann" }] }]);
    expect(t).toMatchObject({ id: "welcome", name: "welcome", from: null });
    expect(() => parseSyncTemplates([{ id: "Bad Id", subject: "s", html: "h", text: "" }])).toThrow("id must match");
    expect(() => parseSyncTemplates([{ id: "a", subject: "s", html: "h", text: "" }, { id: "a", subject: "s", html: "h", text: "" }])).toThrow("twice");
    expect(() => parseSyncTemplates([{ id: "a", subject: "two\nlines", html: "h", text: "" }])).toThrow("one line");
  });
});

describe("addresses and domains", () => {
  test("parseAddress", () => {
    expect(parseAddress("a@b.com")).toEqual({ name: null, email: "a@b.com" });
    expect(parseAddress('"Acme Shop" <Hi@Acme.com>')).toEqual({ name: "Acme Shop", email: "hi@acme.com" });
    expect(parseAddress("Acme <hi@acme.com>")).toEqual({ name: "Acme", email: "hi@acme.com" });
    expect(parseAddress("nope")).toBeNull();
    expect(parseAddress("a@b")).toBeNull();
    expect(parseAddress("a@b.com\nX: y")).toBeNull();
  });

  test("from must be exactly a verified domain", () => {
    expect(addressDomain("Shop <hi@acme.com>")).toBe("acme.com");
    expect(fromAllowed("hi@acme.com", ["acme.com"])).toBe(true);
    expect(fromAllowed("hi@mail.acme.com", ["acme.com"])).toBe(false);
    expect(fromAllowed("hi@acme.com.evil.io", ["acme.com"])).toBe(false);
  });

  test("normalizeDomain", () => {
    expect(normalizeDomain(" Acme.COM. ")).toBe("acme.com");
    expect(() => normalizeDomain("*.acme.com")).toThrow("wildcard");
    expect(() => normalizeDomain("localhost")).toThrow("isn't a domain");
    expect(() => normalizeDomain("box.local")).toThrow("public");
  });

  test("domainRecords", () => {
    const r = domainRecords("acme.com", ["t1", "t2", "t3"], "eu-west-1");
    expect(r.filter((x) => x.purpose === "dkim").map((x) => [x.name, x.value])).toEqual([
      ["t1._domainkey.acme.com", "t1.dkim.amazonses.com"],
      ["t2._domainkey.acme.com", "t2.dkim.amazonses.com"],
      ["t3._domainkey.acme.com", "t3.dkim.amazonses.com"],
    ]);
    expect(r.find((x) => x.type === "MX")).toMatchObject({ name: "bounce.acme.com", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 });
    expect(r.find((x) => x.purpose === "dmarc")).toMatchObject({ name: "_dmarc.acme.com", type: "TXT" });
  });
});

/** In-memory Cloudflare with one zone. */
function fakeCloudflare(initial: DnsRecord[] = []) {
  const records = [...initial];
  let n = 0;
  const cf = {
    listZones: async () => [{ id: "z1", name: "acme.com" }],
    listRecords: async (_zone: string, name: string) => records.filter((r) => r.name === name),
    createRecord: async (_zone: string, rec: { type: string; name: string; content: string; comment?: string }) => {
      const created = { id: `r${++n}`, type: rec.type, name: rec.name, content: rec.content, comment: rec.comment ?? null } as DnsRecord;
      records.push(created);
      return created;
    },
    deleteRecord: async (_zone: string, id: string) => {
      records.splice(
        records.findIndex((r) => r.id === id),
        1,
      );
    },
  } as unknown as Cloudflare;
  return { cf, records };
}

describe("applyDns / removeDns", () => {
  const recs = domainRecords("acme.com", ["t1", "t2", "t3"], "us-east-1");

  test("adds everything on a clean zone, removes only ours", async () => {
    const { cf, records } = fakeCloudflare([{ id: "keep", type: "TXT", name: "acme.com", content: "v=spf1 -all", comment: null } as DnsRecord]);
    const res = await applyDns("acme.com", recs, cf);
    expect(res.error).toBeNull();
    expect(res.zoneId).toBe("z1");
    expect(res.recordIds).toHaveLength(6);
    expect(res.records.every((r) => r.state === "added")).toBe(true);
    await removeDns(res.zoneId, res.recordIds, res.records, cf);
    expect(records.map((r) => r.id)).toEqual(["keep"]);
  });

  test("keeps existing DMARC and identical records; reports conflicts", async () => {
    const { cf } = fakeCloudflare([
      { id: "d", type: "TXT", name: "_dmarc.acme.com", content: '"v=DMARC1; p=reject"', comment: null } as DnsRecord,
      { id: "k", type: "CNAME", name: "t1._domainkey.acme.com", content: "t1.dkim.amazonses.com", comment: null } as DnsRecord,
      { id: "x", type: "MX", name: "bounce.acme.com", content: "other.mx.example", comment: null } as DnsRecord,
    ]);
    const res = await applyDns("acme.com", recs, cf);
    const state = (name: string, type: string) => res.records.find((r) => r.name === name && r.type === type)?.state;
    expect(state("_dmarc.acme.com", "TXT")).toBe("present");
    expect(state("t1._domainkey.acme.com", "CNAME")).toBe("present");
    expect(state("bounce.acme.com", "MX")).toBe("conflict");
    expect(state("t2._domainkey.acme.com", "CNAME")).toBe("added");
    expect(res.error).toContain("bounce.acme.com already has MX other.mx.example");
    expect(res.recordIds).toHaveLength(3);
  });

  test("no zone → error, nothing added", async () => {
    const { cf } = fakeCloudflare();
    const res = await applyDns("other.org", domainRecords("other.org", ["t"], "us-east-1"), cf);
    expect(res.zoneId).toBeNull();
    expect(res.error).toContain("no active Cloudflare zone");
  });
});

describe("mapSesEvent", () => {
  const id = "8b0f6d6e-2a7e-4a35-9b8a-1f7c7c0f0e11";
  const mail = { messageId: "ses-1", timestamp: "2026-01-01T00:00:00Z", tags: { mybase_project: ["shop"], mybase_id: [id] } };

  test("permanent bounce suppresses recipients", () => {
    const e = mapSesEvent(
      JSON.stringify({
        eventType: "Bounce",
        mail,
        bounce: { bounceType: "Permanent", bounceSubType: "General", timestamp: "2026-01-01T00:00:05Z", bouncedRecipients: [{ emailAddress: "Gone@B.com", diagnosticCode: "550 no such user" }] },
      }),
    )!;
    expect(e).toMatchObject({ sesMessageId: "ses-1", messageId: id, project: "shop", type: "bounce", status: "bounced", at: "2026-01-01T00:00:05Z" });
    expect(e.suppress).toEqual([{ address: "gone@b.com", reason: "bounce" }]);
  });

  test("transient and undetermined bounces are final for the message but don't suppress", () => {
    for (const bounceType of ["Transient", "Undetermined"]) {
      const e = mapSesEvent(JSON.stringify({ eventType: "Bounce", mail, bounce: { bounceType, bouncedRecipients: [{ emailAddress: "a@b.com" }] } }))!;
      expect(e.status).toBe("bounced");
      expect(e.suppress).toEqual([]);
    }
  });

  test("delivery, delay, complaint, click, and junk", () => {
    expect(mapSesEvent(JSON.stringify({ eventType: "Delivery", mail, delivery: { timestamp: "t", recipients: ["a@b.com"] } }))?.status).toBe("delivered");
    expect(mapSesEvent(JSON.stringify({ eventType: "DeliveryDelay", mail, deliveryDelay: { delayType: "MailboxFull" } }))?.type).toBe("delay");
    const c = mapSesEvent(JSON.stringify({ eventType: "Complaint", mail, complaint: { complainedRecipients: [{ emailAddress: "a@b.com" }] } }))!;
    expect(c.suppress).toEqual([{ address: "a@b.com", reason: "complaint" }]);
    const click = mapSesEvent(JSON.stringify({ eventType: "Click", mail, click: { link: "https://x.com", ipAddress: "1.2.3.4", userAgent: "UA" } }))!;
    expect(click.detail).toEqual({ link: "https://x.com", userAgent: "UA" });
    expect(mapSesEvent("not json")).toBeNull();
    expect(mapSesEvent(JSON.stringify({ eventType: "Bounce" }))).toBeNull();
    expect(mapSesEvent(JSON.stringify({ eventType: "Delivery", mail: { ...mail, tags: { mybase_id: ["x'; drop"] } } }))?.messageId).toBeNull();
  });

  test("status never goes backwards", () => {
    expect(statusRank("delivered")).toBeGreaterThan(statusRank("delayed"));
    expect(statusRank("complained")).toBeGreaterThan(statusRank("bounced"));
    expect(statusRank("queued")).toBeLessThan(statusRank("sent"));
  });
});

describe("sizeAttachments", () => {
  const MB = 1024 * 1024;
  test("storage objects count toward the limit, alone and with base64", async () => {
    const big = parseAttachments([{ filename: "big.mp4", storageKey: "big.mp4" }]);
    await expect(sizeAttachments(big, async () => 11 * MB)).rejects.toThrow("over 10 MB");
    const mixed = parseAttachments([
      { filename: "a.bin", content: Buffer.alloc(6 * MB).toString("base64") },
      { filename: "b.pdf", storageKey: "b.pdf" },
    ]);
    await expect(sizeAttachments(mixed, async () => 5 * MB)).rejects.toThrow("over 10 MB");
    const ok = await sizeAttachments(mixed, async () => 1 * MB);
    expect(ok.map((a) => a.size)).toEqual([6 * MB, 1 * MB]);
    await expect(sizeAttachments(big, async () => null)).rejects.toThrow("isn't in this project's bucket");
  });
});

describe("heading text", () => {
  test("a heading's {{name}} yields only that variable", () => {
    const parts = { subject: "Welcome, {{name}}", html: "<h1>Hi {{name}}</h1>", text: "Hi {{name}}\n\nThanks" };
    expect(parseTemplateVariables([{ name: "name", sample: "Ann" }], parts)).toEqual([{ name: "name", sample: "Ann" }]);
    expect(fillTemplate(parts, { name: "Ann" }, ["name"]).text).toBe("Hi Ann\n\nThanks");
  });
});

describe("formatAddress", () => {
  test("non-ASCII names are encoded-words, quotes and backslashes escaped", () => {
    expect(formatAddress({ name: "José", email: "j@acme.com" })).toBe("=?UTF-8?B?Sm9zw6k=?= <j@acme.com>");
    expect(formatAddress({ name: "a\\", email: "a@acme.com" })).toBe('"a\\\\" <a@acme.com>');
    expect(formatAddress({ name: 'say "hi"', email: "a@acme.com" })).toBe('"say \\"hi\\"" <a@acme.com>');
    expect(formatAddress({ name: null, email: "a@acme.com" })).toBe("a@acme.com");
  });
});

describe("variables and prototype keys", () => {
  test("prototype names are refused and don't count as given", () => {
    expect(() => parseVariables({ constructor: "x" })).toThrow("isn't valid");
    expect(() => parseVariables({ __proto__: "x", ok: "y" } as unknown as Record<string, string>)).not.toThrow();
    expect(() => fillTemplate({ subject: "s", html: "{{toString}}", text: "" }, parseVariables({}), [])).toThrow("missing variables: toString");
    expect(() => parseVariables({ name: { a: 1 } })).toThrow("must be a string");
    expect(() => parseVariables([1])).toThrow("object of strings");
  });
});

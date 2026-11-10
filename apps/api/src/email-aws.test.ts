import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SES_IAM_POLICY } from "@mybase/shared";
import { AwsError, awsEmailClient, configurationSetName, mergeTopicPolicy, SES_PUBLISH_SID, sesConfigFromEnv } from "./email-aws";

const config = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", region: "us-east-1" };

/** Records signed requests; answers with `reply(req)`. */
function fake(reply: (req: Request, body: string) => Response | Promise<Response>) {
  const calls: { method: string; url: string; target: string | null; body: string; auth: string | null }[] = [];
  const fetcher = (async (input: Request) => {
    const body = await input.clone().text();
    calls.push({ method: input.method, url: input.url, target: input.headers.get("x-amz-target"), body, auth: input.headers.get("authorization") });
    return reply(input, body);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

describe("sesConfigFromEnv", () => {
  test("needs all three values and a real region", () => {
    expect(sesConfigFromEnv({})).toBeNull();
    expect(sesConfigFromEnv({ MYBASE_SES_ACCESS_KEY_ID: "a", MYBASE_SES_SECRET_ACCESS_KEY: "b" })).toBeNull();
    expect(sesConfigFromEnv({ MYBASE_SES_ACCESS_KEY_ID: "a", MYBASE_SES_SECRET_ACCESS_KEY: "b", MYBASE_SES_REGION: "nope" })).toBeNull();
    expect(sesConfigFromEnv({ MYBASE_SES_ACCESS_KEY_ID: "a", MYBASE_SES_SECRET_ACCESS_KEY: "b", MYBASE_SES_REGION: "eu-west-2" })).toEqual({
      accessKeyId: "a",
      secretAccessKey: "b",
      region: "eu-west-2",
    });
  });
});

describe("configurationSetName", () => {
  test("one set per tracking combination", () => {
    expect(configurationSetName({ opens: false, clicks: false })).toBe("mybase");
    expect(configurationSetName({ opens: true, clicks: false })).toBe("mybase-track-opens");
    expect(configurationSetName({ opens: false, clicks: true })).toBe("mybase-track-clicks");
    expect(configurationSetName({ opens: true, clicks: true })).toBe("mybase-track-all");
  });
});

describe("awsEmailClient", () => {
  test("sendEmail signs a SES v2 request with the right shape", async () => {
    const { calls, fetcher } = fake(() => json({ MessageId: "m-1" }));
    const client = awsEmailClient(config, fetcher);
    const res = await client.sendEmail({
      from: "hi@acme.com",
      to: ["a@b.com"],
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      tags: { mybase_project: "shop", mybase_id: "x" },
      attachments: [{ FileName: "a.txt", ContentType: "text/plain", RawContent: "aGk=" }],
      configurationSet: "mybase",
    });
    expect(res).toEqual({ messageId: "m-1" });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(call.auth).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
    expect(call.auth).toContain("/us-east-1/ses/aws4_request");
    const body = JSON.parse(call.body);
    expect(body.FromEmailAddress).toBe("hi@acme.com");
    expect(body.Destination.ToAddresses).toEqual(["a@b.com"]);
    expect(body.Content.Simple.Subject.Data).toBe("Hello");
    expect(body.Content.Simple.Body.Html.Data).toBe("<p>hi</p>");
    expect(body.Content.Simple.Attachments[0]).toMatchObject({ FileName: "a.txt", RawContent: "aGk=", ContentDisposition: "ATTACHMENT" });
    expect(body.EmailTags).toEqual([
      { Name: "mybase_project", Value: "shop" },
      { Name: "mybase_id", Value: "x" },
    ]);
    expect(body.ConfigurationSetName).toBe("mybase");
  });

  test("SES errors become AwsError with the error type", async () => {
    const { fetcher } = fake(() => json({ message: "Email address is not verified." }, 400, { "x-amzn-ErrorType": "MessageRejected:http://internal" }));
    const err = await awsEmailClient(config, fetcher)
      .sendEmail({ from: "a@b.com", to: ["c@d.com"], subject: "s", text: "t" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect(err.code).toBe("MessageRejected");
    expect(err.message).toBe("Email address is not verified.");
    expect(err.retryable).toBe(false);
    expect(new AwsError("ses", 429, "TooManyRequestsException", "").retryable).toBe(true);
    expect(new AwsError("ses", 503, "x", "").retryable).toBe(true);
  });

  test("getIdentity returns null when SES doesn't know the domain", async () => {
    const { fetcher } = fake(() => json({ message: "nope" }, 404, { "x-amzn-ErrorType": "NotFoundException" }));
    expect(await awsEmailClient(config, fetcher).getIdentity("acme.com")).toBeNull();
  });

  test("ensureResources creates topic, queue, policy, subscription and four configuration sets", async () => {
    const topicArn = "arn:aws:sns:us-east-1:123:mybase-email-events";
    const queueArn = "arn:aws:sqs:us-east-1:123:mybase-email-events";
    // The topic already has the default statement plus one added by hand; both must stay.
    const existing = {
      Version: "2008-10-17",
      Id: "__default_policy_ID",
      Statement: [
        { Sid: "__default_statement_ID", Effect: "Allow", Principal: { AWS: "*" }, Action: ["SNS:Publish"], Resource: topicArn, Condition: { StringEquals: { "AWS:SourceOwner": "123" } } },
        { Sid: "by-hand", Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sns:Publish", Resource: topicArn },
      ],
    };
    const xmlEscape = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const { calls, fetcher } = fake((req, body) => {
      if (req.url.startsWith("https://sns.")) {
        if (body.includes("Action=CreateTopic")) return new Response(`<CreateTopicResponse><CreateTopicResult><TopicArn>${topicArn}</TopicArn></CreateTopicResult></CreateTopicResponse>`);
        if (body.includes("Action=GetTopicAttributes")) {
          return new Response(
            `<GetTopicAttributesResponse><GetTopicAttributesResult><Attributes><entry><key>Owner</key><value>123</value></entry><entry><key>Policy</key><value>${xmlEscape(JSON.stringify(existing))}</value></entry></Attributes></GetTopicAttributesResult></GetTopicAttributesResponse>`,
          );
        }
        return new Response("<SubscribeResponse/>");
      }
      const target = req.headers.get("x-amz-target");
      if (target === "AmazonSQS.CreateQueue") return json({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/mybase-email-events" });
      if (target === "AmazonSQS.GetQueueAttributes") return json({ Attributes: { QueueArn: queueArn } });
      if (target) return json({});
      // Second set already exists: its destination gets updated instead.
      if (req.url.endsWith("/configuration-sets") && body.includes('"mybase-track-opens"')) return json({ message: "exists" }, 400, { "x-amzn-ErrorType": "AlreadyExistsException" });
      if (req.url.includes("mybase-track-opens/event-destinations") && req.method === "POST") return json({ message: "exists" }, 400, { "x-amzn-ErrorType": "AlreadyExistsException" });
      return json({});
    });
    const res = await awsEmailClient(config, fetcher).ensureResources();
    expect(res).toEqual({ queueUrl: "https://sqs.us-east-1.amazonaws.com/123/mybase-email-events", topicArn, topicPolicyError: null });

    // SES may publish to the topic, only from mybase's configuration sets in this account.
    const set = new URLSearchParams(calls.find((c) => c.body.includes("Action=SetTopicAttributes"))!.body);
    expect(set.get("TopicArn")).toBe(topicArn);
    expect(set.get("AttributeName")).toBe("Policy");
    const topicPolicy = JSON.parse(set.get("AttributeValue")!);
    expect(topicPolicy.Version).toBe("2008-10-17");
    expect(topicPolicy.Statement.map((st: { Sid: string }) => st.Sid)).toEqual(["__default_statement_ID", "by-hand", SES_PUBLISH_SID]);
    const sesSt = topicPolicy.Statement[2];
    expect(sesSt).toMatchObject({ Effect: "Allow", Principal: { Service: "ses.amazonaws.com" }, Action: "sns:Publish", Resource: topicArn });
    expect(sesSt.Condition.StringEquals["AWS:SourceAccount"]).toBe("123");
    expect(sesSt.Condition.StringEquals["AWS:SourceArn"]).toEqual([
      "arn:aws:ses:us-east-1:123:configuration-set/mybase",
      "arn:aws:ses:us-east-1:123:configuration-set/mybase-track-opens",
      "arn:aws:ses:us-east-1:123:configuration-set/mybase-track-clicks",
      "arn:aws:ses:us-east-1:123:configuration-set/mybase-track-all",
    ]);

    const policy = JSON.parse(JSON.parse(calls.find((c) => c.target === "AmazonSQS.SetQueueAttributes")!.body).Attributes.Policy);
    expect(policy.Statement[0].Condition.ArnEquals["aws:SourceArn"]).toBe(topicArn);

    const subscribe = new URLSearchParams(calls.find((c) => c.body.includes("Action=Subscribe"))!.body);
    expect(subscribe.get("Endpoint")).toBe(queueArn);
    expect(subscribe.get("Attributes.entry.1.key")).toBe("RawMessageDelivery");

    const destinations = calls.filter((c) => c.url.includes("/event-destinations"));
    const types = (name: string) => {
      const c = destinations.find((d) => d.url.includes(`/configuration-sets/${name}/`) && d.method === "POST")!;
      return JSON.parse(c.body).EventDestination.MatchingEventTypes as string[];
    };
    expect(types("mybase")).not.toContain("OPEN");
    expect(types("mybase")).not.toContain("CLICK");
    expect(types("mybase-track-all")).toContain("OPEN");
    expect(types("mybase-track-all")).toContain("CLICK");
    expect(types("mybase-track-clicks")).not.toContain("OPEN");
    expect(destinations.some((d) => d.method === "PUT" && d.url.endsWith("/mybase-track-opens/event-destinations/mybase-events"))).toBe(true);
  });

  test("ensureResources finishes and reports it when the topic policy can't be set (old IAM policy)", async () => {
    const topicArn = "arn:aws:sns:us-east-1:123:mybase-email-events";
    const { calls, fetcher } = fake((req, body) => {
      if (req.url.startsWith("https://sns.")) {
        if (body.includes("Action=CreateTopic")) return new Response(`<CreateTopicResponse><CreateTopicResult><TopicArn>${topicArn}</TopicArn></CreateTopicResult></CreateTopicResponse>`);
        if (body.includes("Action=GetTopicAttributes")) {
          return new Response("<ErrorResponse><Error><Code>AuthorizationError</Code><Message>not authorized to perform: SNS:GetTopicAttributes</Message></Error></ErrorResponse>", { status: 403 });
        }
        return new Response("<SubscribeResponse/>");
      }
      const target = req.headers.get("x-amz-target");
      if (target === "AmazonSQS.CreateQueue") return json({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/mybase-email-events" });
      if (target === "AmazonSQS.GetQueueAttributes") return json({ Attributes: { QueueArn: "arn:aws:sqs:us-east-1:123:mybase-email-events" } });
      return json({});
    });
    const res = await awsEmailClient(config, fetcher).ensureResources();
    expect(res.topicPolicyError).toContain("SNS:GetTopicAttributes");
    expect(calls.some((c) => c.body.includes("Action=SetTopicAttributes"))).toBe(false);
    expect(calls.some((c) => c.body.includes("Action=Subscribe"))).toBe(true);
  });

  test("mergeTopicPolicy is idempotent and replaces an outdated mybase statement", () => {
    const topicArn = "arn:aws:sns:eu-west-1:999:mybase-email-events";
    const first = mergeTopicPolicy(undefined, topicArn)!;
    expect(JSON.parse(first).Statement).toHaveLength(1);
    expect(mergeTopicPolicy(first, topicArn)).toBeNull();
    const stale = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: SES_PUBLISH_SID, Effect: "Allow", Action: "sns:Publish" }] });
    const fixed = JSON.parse(mergeTopicPolicy(stale, topicArn)!);
    expect(fixed.Statement).toHaveLength(1);
    expect(fixed.Statement[0].Condition.StringEquals["AWS:SourceAccount"]).toBe("999");
  });

  test("the IAM policy in docs/email.md is SES_IAM_POLICY", () => {
    const md = readFileSync(resolve(import.meta.dir, "../../../docs/email.md"), "utf8");
    const block = /```json\n([\s\S]*?)```/.exec(md)![1]!;
    expect(JSON.parse(block)).toEqual(SES_IAM_POLICY);
    const sns = SES_IAM_POLICY.Statement.find((st) => st.Action.some((a) => a.startsWith("sns:")))!;
    expect(sns.Action).toContain("sns:GetTopicAttributes");
    expect(sns.Action).toContain("sns:SetTopicAttributes");
  });

  test("SQS errors carry the short error type", async () => {
    const { fetcher } = fake(() => json({ __type: "com.amazonaws.sqs#QueueDoesNotExist", message: "gone" }, 400));
    const err = await awsEmailClient(config, fetcher)
      .receiveEvents("https://sqs.us-east-1.amazonaws.com/1/q", 1)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AwsError);
    expect(err.code).toBe("QueueDoesNotExist");
  });
});

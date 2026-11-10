// AWS calls for the email service: SES v2 (JSON REST), SNS (query API) and SQS (JSON 1.0),
// signed with SigV4 by aws4fetch (already used for Garage). No AWS SDK.
//
// Credentials come from MYBASE_SES_ACCESS_KEY_ID / MYBASE_SES_SECRET_ACCESS_KEY / MYBASE_SES_REGION.
// Never log them, and never log request bodies (they hold recipients and email content).
import { AwsClient } from "aws4fetch";

export interface SesConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** Reads the SES settings from the environment; null when email isn't configured. */
export function sesConfigFromEnv(env: Record<string, string | undefined> = process.env): SesConfig | null {
  const accessKeyId = env.MYBASE_SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.MYBASE_SES_SECRET_ACCESS_KEY?.trim();
  const region = env.MYBASE_SES_REGION?.trim();
  if (!accessKeyId || !secretAccessKey || !region) return null;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return null;
  return { accessKeyId, secretAccessKey, region };
}

/** An error answer from AWS. `code` is AWS's error type, e.g. `NotFoundException` or `Throttling`. */
export class AwsError extends Error {
  constructor(
    readonly service: "ses" | "sns" | "sqs",
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** Worth retrying later: throttling, AWS-side failures. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || /throttl|toomanyrequests|limitexceeded|serviceunavailable/i.test(this.code);
  }
}

// ---- wire types (only the fields mybase reads) ----

export interface SesAccount {
  ProductionAccessEnabled?: boolean;
  SendingEnabled?: boolean;
  EnforcementStatus?: string;
  SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
}

export interface SesIdentity {
  VerifiedForSendingStatus?: boolean;
  DkimAttributes?: { Status?: string; Tokens?: string[]; SigningEnabled?: boolean };
  MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string };
}

export interface SesAttachment {
  FileName: string;
  ContentType?: string;
  /** Base64. */
  RawContent: string;
  ContentDisposition?: "ATTACHMENT" | "INLINE";
  ContentId?: string;
}

export interface SesSendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: SesAttachment[];
  tags?: Record<string, string>;
  configurationSet?: string;
}

/** SES event types mybase subscribes to. */
export const SES_EVENT_TYPES = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "OPEN", "CLICK", "RENDERING_FAILURE", "DELIVERY_DELAY"] as const;

/** Names of what `ensureSesResources` creates. Instance-wide (one SES account per mybase). */
export const SES_RESOURCES = {
  topic: "mybase-email-events",
  queue: "mybase-email-events",
  destination: "mybase-events",
} as const;

/**
 * Configuration set for a tracking choice. SES tracks opens/clicks when the set publishes
 * OPEN/CLICK events, so there's one set per combination, shared by all projects.
 */
export function configurationSetName(tracking: { opens: boolean; clicks: boolean }): string {
  if (tracking.opens && tracking.clicks) return "mybase-track-all";
  if (tracking.opens) return "mybase-track-opens";
  if (tracking.clicks) return "mybase-track-clicks";
  return "mybase";
}

const CONFIG_SETS = [
  { name: "mybase", opens: false, clicks: false },
  { name: "mybase-track-opens", opens: true, clicks: false },
  { name: "mybase-track-clicks", opens: false, clicks: true },
  { name: "mybase-track-all", opens: true, clicks: true },
];

/** Sid of the topic-policy statement that lets SES publish events to the topic. */
export const SES_PUBLISH_SID = "mybase-ses-publish";

/**
 * The topic-policy statement that lets SES publish events from mybase's configuration sets.
 * Account, partition, and region come from the topic ARN (`arn:<partition>:sns:<region>:<account>:<name>`).
 */
export function sesPublishStatement(topicArn: string) {
  const [, partition, , region, account] = topicArn.split(":");
  if (!partition || !region || !account) throw new Error(`unexpected SNS topic ARN: ${topicArn}`);
  return {
    Sid: SES_PUBLISH_SID,
    Effect: "Allow",
    Principal: { Service: "ses.amazonaws.com" },
    Action: "sns:Publish",
    Resource: topicArn,
    Condition: {
      StringEquals: {
        "AWS:SourceAccount": account,
        "AWS:SourceArn": CONFIG_SETS.map((c) => `arn:${partition}:ses:${region}:${account}:configuration-set/${c.name}`),
      },
    },
  };
}

/**
 * The topic policy with the SES statement added (or replaced, by Sid); every other statement is
 * kept. Null when the policy already has exactly that statement.
 */
export function mergeTopicPolicy(current: string | undefined, topicArn: string): string | null {
  const statement = sesPublishStatement(topicArn);
  let policy: { Version?: string; Statement?: unknown } = {};
  if (current) {
    try {
      policy = JSON.parse(current) as typeof policy;
    } catch {
      throw new Error("the SNS topic's policy isn't valid JSON");
    }
  }
  const list = Array.isArray(policy.Statement) ? (policy.Statement as Record<string, unknown>[]) : policy.Statement ? [policy.Statement as Record<string, unknown>] : [];
  const existing = list.find((st) => st?.Sid === SES_PUBLISH_SID);
  if (existing && JSON.stringify(existing) === JSON.stringify(statement)) return null;
  const others = list.filter((st) => st?.Sid !== SES_PUBLISH_SID);
  return JSON.stringify({ ...policy, Version: policy.Version ?? "2012-10-17", Statement: [...others, statement] });
}

const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

const decodeXml = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export interface AwsEmailClient {
  readonly region: string;
  getAccount(): Promise<SesAccount>;
  sendEmail(input: SesSendInput): Promise<{ messageId: string }>;
  createIdentity(domain: string): Promise<SesIdentity>;
  getIdentity(domain: string): Promise<SesIdentity | null>;
  deleteIdentity(domain: string): Promise<void>;
  /** Null turns the custom MAIL FROM off (SES's default amazonses.com one). */
  setMailFrom(domain: string, mailFromDomain: string | null): Promise<void>;
  /**
   * Creates (or finds) the SNS topic, SQS queue, subscription and configuration sets, and lets SES
   * publish to the topic. Returns the queue URL; `topicPolicyError` when the topic policy couldn't be
   * set (e.g. an IAM policy from before sns:Get/SetTopicAttributes), so no events will arrive.
   */
  ensureResources(): Promise<{ queueUrl: string; topicArn: string; topicPolicyError: string | null }>;
  receiveEvents(queueUrl: string, waitSeconds: number, signal?: AbortSignal): Promise<{ id: string; receipt: string; body: string }[]>;
  deleteEvents(queueUrl: string, receipts: { id: string; receipt: string }[]): Promise<void>;
}

/** `fetcher` is swappable for tests; it gets already-signed requests. */
export function awsEmailClient(config: SesConfig, fetcher: typeof fetch = fetch): AwsEmailClient {
  const { region } = config;
  const aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region });
  const sesBase = `https://email.${region}.amazonaws.com/v2/email`;
  const snsUrl = `https://sns.${region}.amazonaws.com/`;
  const sqsUrl = `https://sqs.${region}.amazonaws.com/`;

  async function send(service: "ses" | "sns" | "sqs", url: string, init: RequestInit): Promise<Response> {
    const signed = await aws.sign(url, { ...init, aws: { service, region } });
    return fetcher(signed);
  }

  async function ses<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await send("ses", `${sesBase}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string; Message?: string };
        message = parsed.message ?? parsed.Message ?? message;
      } catch {}
      const code = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0] || `HTTP${res.status}`;
      throw new AwsError("ses", res.status, code, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function sns(params: Record<string, string>): Promise<string> {
    const res = await send("sns", snsUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, Version: "2010-03-31" }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AwsError("sns", res.status, xmlValue(text, "Code") ?? `HTTP${res.status}`, decodeXml(xmlValue(text, "Message") ?? text.slice(0, 300)));
    }
    return text;
  }

  async function sqs<T>(action: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await send("sqs", sqsUrl, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `AmazonSQS.${action}` },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP${res.status}`;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { __type?: string; message?: string };
        code = parsed.__type?.split("#").pop() ?? code;
        message = parsed.message ?? message;
      } catch {}
      throw new AwsError("sqs", res.status, code, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  const ignoreExists = (err: unknown) => {
    if (err instanceof AwsError && /AlreadyExists/.test(err.code)) return;
    throw err;
  };

  const id = (domain: string) => `/identities/${encodeURIComponent(domain)}`;

  return {
    region,
    getAccount: () => ses<SesAccount>("GET", "/account"),

    async sendEmail(input) {
      const tags = Object.entries(input.tags ?? {}).map(([Name, Value]) => ({ Name, Value }));
      const body = {
        FromEmailAddress: input.from,
        Destination: { ToAddresses: input.to, CcAddresses: input.cc ?? [], BccAddresses: input.bcc ?? [] },
        ReplyToAddresses: input.replyTo ?? [],
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: {
              ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
              ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
            },
            ...(input.attachments?.length ? { Attachments: input.attachments.map((a) => ({ ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64", ...a })) } : {}),
          },
        },
        EmailTags: tags,
        ...(input.configurationSet ? { ConfigurationSetName: input.configurationSet } : {}),
      };
      const res = await ses<{ MessageId: string }>("POST", "/outbound-emails", body);
      return { messageId: res.MessageId };
    },

    createIdentity: (domain) => ses<SesIdentity>("POST", "/identities", { EmailIdentity: domain }),

    async getIdentity(domain) {
      try {
        return await ses<SesIdentity>("GET", id(domain));
      } catch (err) {
        if (err instanceof AwsError && err.code === "NotFoundException") return null;
        throw err;
      }
    },

    async deleteIdentity(domain) {
      try {
        await ses("DELETE", id(domain));
      } catch (err) {
        if (err instanceof AwsError && err.code === "NotFoundException") return;
        throw err;
      }
    },

    async setMailFrom(domain, mailFromDomain) {
      await ses("PUT", `${id(domain)}/mail-from`, mailFromDomain ? { MailFromDomain: mailFromDomain, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" } : {});
    },

    async ensureResources() {
      // SNS CreateTopic is idempotent and returns the existing ARN.
      const topicXml = await sns({ Action: "CreateTopic", Name: SES_RESOURCES.topic });
      const topicArn = xmlValue(topicXml, "TopicArn");
      if (!topicArn) throw new Error("SNS CreateTopic returned no TopicArn");

      // SES needs the topic's own policy to allow it to publish (the default only covers this account's
      // principals). Merged in, so statements added by hand stay. A failure here doesn't stop the
      // rest of the setup; the caller reports it and retries.
      let topicPolicyError: string | null = null;
      try {
        const attrsXml = await sns({ Action: "GetTopicAttributes", TopicArn: topicArn });
        const raw = /<entry>\s*<key>Policy<\/key>\s*<value>([^<]*)<\/value>\s*<\/entry>/.exec(attrsXml)?.[1];
        const next = mergeTopicPolicy(raw === undefined ? undefined : decodeXml(raw), topicArn);
        if (next) await sns({ Action: "SetTopicAttributes", TopicArn: topicArn, AttributeName: "Policy", AttributeValue: next });
      } catch (err) {
        topicPolicyError = (err as Error).message;
      }

      // SQS CreateQueue returns the existing queue when the attributes match.
      const { QueueUrl: queueUrl } = await sqs<{ QueueUrl: string }>("CreateQueue", {
        QueueName: SES_RESOURCES.queue,
        Attributes: { ReceiveMessageWaitTimeSeconds: "20", MessageRetentionPeriod: "1209600", VisibilityTimeout: "60" },
      });
      const attrs = await sqs<{ Attributes: { QueueArn: string } }>("GetQueueAttributes", { QueueUrl: queueUrl, AttributeNames: ["QueueArn"] });
      const queueArn = attrs.Attributes.QueueArn;

      // Only this topic may write to the queue.
      const policy = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "mybase-email-events",
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: queueArn,
            Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
          },
        ],
      };
      await sqs("SetQueueAttributes", { QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify(policy) } });

      // Raw delivery: the queue gets SES's event JSON as is. Subscribe is idempotent.
      await sns({
        Action: "Subscribe",
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
        ReturnSubscriptionArn: "true",
        "Attributes.entry.1.key": "RawMessageDelivery",
        "Attributes.entry.1.value": "true",
      });

      for (const set of CONFIG_SETS) {
        await ses("POST", "/configuration-sets", { ConfigurationSetName: set.name }).catch(ignoreExists);
        const types = SES_EVENT_TYPES.filter((t) => (t !== "OPEN" || set.opens) && (t !== "CLICK" || set.clicks));
        const destination = { Enabled: true, MatchingEventTypes: types, SnsDestination: { TopicArn: topicArn } };
        const path = `/configuration-sets/${set.name}/event-destinations`;
        try {
          await ses("POST", path, { EventDestinationName: SES_RESOURCES.destination, EventDestination: destination });
        } catch (err) {
          if (!(err instanceof AwsError && /AlreadyExists/.test(err.code))) throw err;
          await ses("PUT", `${path}/${SES_RESOURCES.destination}`, { EventDestination: destination });
        }
      }
      return { queueUrl, topicArn, topicPolicyError };
    },

    async receiveEvents(queueUrl, waitSeconds, signal) {
      const res = await sqs<{ Messages?: { MessageId: string; ReceiptHandle: string; Body: string }[] }>(
        "ReceiveMessage",
        { QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds },
        signal,
      );
      return (res.Messages ?? []).map((m) => ({ id: m.MessageId, receipt: m.ReceiptHandle, body: m.Body }));
    },

    async deleteEvents(queueUrl, receipts) {
      if (!receipts.length) return;
      await sqs("DeleteMessageBatch", {
        QueueUrl: queueUrl,
        Entries: receipts.map((r, i) => ({ Id: String(i), ReceiptHandle: r.receipt })),
      });
    },
  };
}

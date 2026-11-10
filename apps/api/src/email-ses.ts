// The instance's SES connection for the email service: the client (from MYBASE_SES_*), the account
// state (sandbox, quota, rate; refreshed hourly), and the event pipeline (SNS topic → SQS queue,
// made at boot and retried every 10 minutes until it works). Sends work without the pipeline;
// only delivery events are missing.
import type { EmailServerStatus } from "@mybase/shared";
import { createLogger } from "@mybase/shared/logger";
import { awsEmailClient, sesConfigFromEnv, type AwsEmailClient, type SesAccount } from "./email-aws";
import { ServiceUnavailableError } from "./errors";

const log = createLogger("email");

const config = sesConfigFromEnv();
let client: AwsEmailClient | null = config ? awsEmailClient(config) : null;

let account: SesAccount | null = null;
let accountAt = 0;
let queueUrl: string | null = null;
/** SES may publish to the topic (the topic policy step worked). */
let topicReady = false;
let lastError: string | null = null;
const ACCOUNT_TTL = 3_600_000;
const RETRY_SETUP_MS = 10 * 60_000;

export const NOT_SET_UP = "email isn't set up on this server: run `mybase server email` with your AWS SES keys";

/** The SES client; 503 when MYBASE_SES_* aren't set. */
export function ses(): AwsEmailClient {
  if (!client) throw new ServiceUnavailableError(NOT_SET_UP);
  return client;
}

export const sesConfigured = () => client !== null;
export const sesRegion = () => config?.region ?? null;
export const eventsQueueUrl = () => queueUrl;

/** For tests. */
export function setSesClientForTests(c: AwsEmailClient | null) {
  client = c;
  account = null;
  accountAt = 0;
}

/** Cached account (≤ 1 h old unless `refresh`). Null when SES can't be reached. */
export async function sesAccount(refresh = false): Promise<SesAccount | null> {
  if (!client) return null;
  if (!refresh && account && Date.now() - accountAt < ACCOUNT_TTL) return account;
  try {
    account = await client.getAccount();
    accountAt = Date.now();
    if (lastError?.startsWith("SES:")) lastError = null;
  } catch (err) {
    lastError = `SES: ${(err as Error).message}`;
    log.warn("ses account check failed", { err });
  }
  return account;
}

/** Sends per second SES allows (1 in the sandbox). */
export async function maxSendRate(): Promise<number> {
  const a = await sesAccount();
  return Math.max(1, Math.floor(a?.SendQuota?.MaxSendRate ?? 1));
}

/** Notes `recipients` sent against the cached 24 h count (SES counts recipients, not messages). */
export function countSent(recipients = 1) {
  if (account?.SendQuota) account.SendQuota.SentLast24Hours = (account.SendQuota.SentLast24Hours ?? 0) + recipients;
}

export async function serverStatus(refresh = false): Promise<EmailServerStatus> {
  if (!client) {
    return { configured: false, region: null, eventsReady: false, error: null, sandbox: null, sendingEnabled: null, quota: null };
  }
  const a = await sesAccount(refresh);
  const q = a?.SendQuota;
  return {
    configured: true,
    region: config?.region ?? null,
    eventsReady: queueUrl !== null && topicReady,
    error: lastError,
    sandbox: a ? !a.ProductionAccessEnabled : null,
    sendingEnabled: a ? a.SendingEnabled !== false : null,
    quota: q ? { max24Hour: q.Max24HourSend ?? 0, sentLast24Hours: q.SentLast24Hours ?? 0, maxPerSecond: q.MaxSendRate ?? 0 } : null,
  };
}

let setupTimer: ReturnType<typeof setTimeout> | null = null;

/** Makes the SNS/SQS/configuration-set pipeline; retries until it works. `onReady` starts the poller. */
export async function setUpEvents(onReady: (queueUrl: string) => void): Promise<void> {
  if (!client) return;
  try {
    const res = await client.ensureResources();
    queueUrl = res.queueUrl;
    topicReady = res.topicPolicyError === null;
    // The queue works either way (a grant added by hand still delivers), so poll it.
    onReady(res.queueUrl);
    if (res.topicPolicyError) {
      lastError = `event pipeline: SES can't publish to the SNS topic (${res.topicPolicyError}). Update the IAM policy with sns:GetTopicAttributes and sns:SetTopicAttributes (mybase server email prints it)`;
      log.warn("email events: couldn't let SES publish to the SNS topic; update the IAM policy (mybase server email prints it). Retrying in 10 minutes", {
        error: res.topicPolicyError,
      });
      setupTimer = setTimeout(() => void setUpEvents(onReady), RETRY_SETUP_MS);
      return;
    }
    lastError = null;
    log.info("email events pipeline ready", { region: config?.region });
  } catch (err) {
    lastError = `event pipeline: ${(err as Error).message}`;
    log.warn("email events pipeline setup failed, retrying in 10 minutes", { err });
    setupTimer = setTimeout(() => void setUpEvents(onReady), RETRY_SETUP_MS);
  }
}

export function stopSes() {
  if (setupTimer) clearTimeout(setupTimer);
}

/** Records a failure the dashboard should show (e.g. the sender found sending paused). */
export function noteSesError(message: string | null) {
  lastError = message;
}

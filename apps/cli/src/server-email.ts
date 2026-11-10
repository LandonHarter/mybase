// `mybase server email`: gives this server Amazon SES keys (MYBASE_SES_* in .env), restarts the
// API, and waits until it reports the SES account (sandbox, quota) and the delivery-event pipeline.
// The secret key is never printed or passed on the command line (prompt or --secret-access-key-stdin).
import * as p from "@clack/prompts";
import { join } from "node:path";
import { styleText } from "node:util";
import { SES_IAM_POLICY, type EmailServerStatus } from "@mybase/shared";
import { api } from "./api";
import { CliError, jsonMode, print, usageError } from "./output";
import { mergeEnv, parseEnv } from "./server-env";
import { flag, localUrl, serverDir, startStack, ui, writeCompose } from "./server-setup";

export const SES_KEYS = ["MYBASE_SES_ACCESS_KEY_ID", "MYBASE_SES_SECRET_ACCESS_KEY", "MYBASE_SES_REGION"] as const;

const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "sa-east-1",
  "me-south-1",
  "af-south-1",
];

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const dim = (s: string) => styleText("dim", s);

function cancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled");
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
}

export async function setupEmailServer(args: string[]) {
  const dir = await serverDir(args);
  const envFile = Bun.file(join(dir, ".env"));
  if (!(await envFile.exists())) throw new CliError(`no mybase server in ${dir}. Run \`mybase server setup\` (or pass --dir).`, 4);
  const text = await envFile.text();
  const values = parseEnv(text);
  const interactive = !jsonMode && process.stdin.isTTY === true;
  if (!jsonMode) p.intro(`${styleText("bold", " mybase ")} ${dim("server email")}`);

  if (args.includes("--off")) {
    await Bun.write(join(dir, ".env"), mergeEnv(text, Object.fromEntries(SES_KEYS.map((k) => [k, null]))));
    await startStack(dir, values);
    return print({ dir, email: false }, () =>
      p.outro("Email off: sends answer 503. Projects keep their templates and logs; AWS resources (SES identities, the SNS topic, the SQS queue) stay in your account."),
    );
  }

  let accessKeyId = flag(args, "--access-key-id");
  let region = flag(args, "--region");
  let secret: string | undefined;
  if (args.includes("--secret-access-key-stdin")) secret = (await Bun.stdin.text()).trim();

  if (!accessKeyId || !secret || !region) {
    if (!interactive) throw usageError("without a terminal, pass --access-key-id <id> --region <region> --secret-access-key-stdin (secret on stdin)");
    ui.note(
      [
        "1. AWS console → IAM → Users → Create user (e.g. mybase-ses), no console access.",
        "2. Permissions → Create inline policy → JSON, paste the policy below.",
        "3. Security credentials → Create access key → \"Application running outside AWS\".",
        "",
        dim(JSON.stringify(SES_IAM_POLICY)),
      ].join("\n"),
      "AWS keys for SES",
    );
    accessKeyId ??= cancelled(
      await p.text({ message: "Access key ID", placeholder: "AKIA…", initialValue: values.MYBASE_SES_ACCESS_KEY_ID ?? "", validate: (v) => (/^[A-Z0-9]{16,128}$/.test(v ?? "") ? undefined : "Looks like AKIA… (letters and digits)") }),
    );
    secret ??= cancelled(await p.password({ message: "Secret access key", validate: (v) => ((v ?? "").length >= 20 ? undefined : "Too short") }));
    region ??= cancelled(
      await p.select({
        message: "SES region (send from the one closest to your users; production access is per region)",
        initialValue: values.MYBASE_SES_REGION || "us-east-1",
        options: REGIONS.map((r) => ({ value: r, label: r })),
      }),
    );
  }
  if (!REGION_PATTERN.test(region!)) throw usageError(`"${region}" isn't an AWS region (like us-east-1)`);

  await Bun.write(
    join(dir, ".env"),
    mergeEnv(text, { MYBASE_SES_ACCESS_KEY_ID: accessKeyId!.trim(), MYBASE_SES_SECRET_ACCESS_KEY: secret!.trim(), MYBASE_SES_REGION: region! }),
  );
  // An older compose.yml doesn't pass MYBASE_SES_* to the API.
  if (await writeCompose(dir, interactive, true)) ui.success("compose.yml updated to this CLI's");
  const version = await startStack(dir, values);
  const status = await waitForEmail(localUrl(values));
  if (jsonMode) return print({ dir, version, status }, () => {});
  if (status?.sandbox) {
    ui.warn(
      `SES is in the sandbox in ${region}: email only reaches addresses you verify in SES, 200 a day. Request production access: AWS console → SES (${region}) → Account dashboard → Request production access.`,
    );
  }
  p.outro("Email is ready. Next: mybase email enable <project>, then mybase email domains add <domain> -p <project>.");
}

/** Polls `/email/status` until the API has talked to SES (or gives up after ~90 s). */
async function waitForEmail(url: string): Promise<EmailServerStatus | null> {
  const s = ui.spinner();
  s.start("Checking the keys with SES and setting up delivery events (SNS → SQS)");
  const deadline = Date.now() + 90_000;
  let last: EmailServerStatus | null = null;
  for (;;) {
    try {
      last = await api<EmailServerStatus>("/email/status?refresh=1", { url });
    } catch (err) {
      const status = (err as CliError).status;
      if (status === 401 || status === 403) {
        s.stop("Can't check: this CLI isn't signed in to the server as admin");
        return null;
      }
      if (status !== 404) throw err;
      s.error("The server doesn't support email");
      throw new CliError("the running mybase image is older than this CLI. Run `mybase server update`, then this command again.");
    }
    if (!last.configured) {
      s.error("The API didn't get the keys");
      throw new CliError("MYBASE_SES_* aren't reaching the API. Check that compose.yml passes them (`mybase server update` refreshes it).");
    }
    if (last.quota && last.eventsReady) {
      s.stop(`SES ${last.region}: ${last.quota.maxPerSecond}/s, ${last.quota.max24Hour} per 24 h${last.sandbox ? " (sandbox)" : ""}; delivery events on`);
      return last;
    }
    if (Date.now() > deadline) {
      s.error(last.error ?? "SES didn't answer yet");
      ui.info(
        last.quota
          ? "Sending works. Delivery events need sns:CreateTopic, sns:Subscribe and the sqs:* actions in the IAM policy; mybase retries every 10 minutes."
          : "Check the keys and the IAM policy (mybase docs email), then run this again.",
      );
      return last;
    }
    await Bun.sleep(3000);
  }
}

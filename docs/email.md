---
title: Email
summary: Send email from your own domains with React templates, through your Amazon SES account, with logs of who got what.
section: Services
order: 25
---

# Email

Transactional email (sign-up confirmations, password resets, receipts) from domains you own. mybase sends through **your Amazon SES account** (about $0.10 per 1,000 emails), because mail sent straight from a home connection lands in spam or is refused. Templates are [React Email](https://react.email) components, made in the dashboard with a live preview or kept in your repo. Apps send them by id with the SDK, and the dashboard shows every email: who got it, the exact content, and what happened (delivered, bounced, opened, clicked).

```sh
mybase server email                       # once, on the server: your AWS keys
mybase email enable shop
mybase email domain add shop acme.com     # DNS records go into Cloudflare when the server can
```

```ts
import { createEmailClient } from "@mybase-dev/sdk/email";

const email = createEmailClient({ apiUrl: "{{MYBASE_URL}}", project: "shop", apiKey: process.env.MYBASE_API_KEY! }); // email:write
await email.send({ template: "welcome", to: "ann@example.com", variables: { name: "Ann" } });
```

## Set up SES (once per server)

1. **AWS account.** Sign up at aws.amazon.com (a card is needed; SES has no monthly fee).
2. **Pick a region** close to your users, for example `us-east-1` or `eu-west-1`. SES settings, limits, and production access are per region.
3. **IAM user.** IAM → Users → Create user (`mybase-ses`, no console access) → Permissions → Create inline policy → JSON:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Resource": "*", "Action": [
           "ses:GetAccount", "ses:SendEmail", "ses:SendRawEmail",
           "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity",
           "ses:PutEmailIdentityMailFromAttributes", "ses:CreateConfigurationSet",
           "ses:CreateConfigurationSetEventDestination", "ses:UpdateConfigurationSetEventDestination"] },
       { "Effect": "Allow", "Action": ["sns:CreateTopic", "sns:Subscribe"], "Resource": "arn:aws:sns:*:*:mybase-email-events" },
       { "Effect": "Allow", "Action": ["sqs:CreateQueue", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:ReceiveMessage", "sqs:DeleteMessage"],
         "Resource": "arn:aws:sqs:*:*:mybase-email-events" }
     ]
   }
   ```

   Then Security credentials → Create access key → "Application running outside AWS".
4. **On the server:** `mybase server email` asks for the key id, secret, and region, writes them to `.env` (`MYBASE_SES_ACCESS_KEY_ID`, `MYBASE_SES_SECRET_ACCESS_KEY`, `MYBASE_SES_REGION`), restarts the API, and waits until SES answers. Without a terminal: `--access-key-id <id> --region <r> --secret-access-key-stdin`. `--off` removes the keys.
5. **Production access.** New SES accounts are in the **sandbox**: email only reaches addresses you verified in SES, at most 200 a day, 1 a second. In the AWS console: SES → Account dashboard → Request production access (describe your app and how people sign up). The dashboard and `mybase email status` show which mode you're in.

At startup, mybase creates (or finds) an SNS topic and an SQS queue named `mybase-email-events` and four configuration sets (`mybase`, `mybase-track-opens`, `mybase-track-clicks`, `mybase-track-all`). SES publishes delivery events to the topic, and the API long-polls the queue, so events arrive without a public URL. If that setup fails (missing IAM actions), sending still works and mybase retries every 10 minutes.

## Domains

Each project verifies its own domains: `mybase email domain add shop acme.com` or Email → Domains → Add domain. A domain belongs to one project. You can send from any address at a verified domain (`hello@acme.com`, `"Acme" <billing@acme.com>`); a subdomain like `mail.acme.com` is a separate domain to add.

SES needs these DNS records:

| Record | Name | Value | For |
|---|---|---|---|
| CNAME ×3 | `<token>._domainkey.acme.com` | `<token>.dkim.amazonses.com` | DKIM: SES signs your email |
| MX | `bounce.acme.com` | `10 feedback-smtp.<region>.amazonses.com` | Custom MAIL FROM: bounces come back to SES |
| TXT | `bounce.acme.com` | `v=spf1 include:amazonses.com ~all` | SPF for the MAIL FROM domain |
| TXT | `_dmarc.acme.com` | `v=DMARC1; p=none;` | Only if the domain has no DMARC record |

With `MYBASE_DNS_TOKEN` on the server (a Cloudflare token with DNS edit + zone read, the same one hosting and public Postgres use), mybase adds them in Cloudflare (never proxied) and shows which were added, already there, or in conflict. It never replaces a record that's there. Without it, the dashboard and CLI list the records to add yourself. SES usually sees them within minutes; mybase re-checks pending domains every 10 minutes for 72 hours (or press Re-check). Removing a domain deletes it from SES and deletes only the records mybase added.

## Templates

A template is a React Email component plus a subject. Anything in `PreviewProps` becomes a **variable**: mybase renders the template with `{{name}}` placeholders, and fills them per send (HTML-escaped in the HTML part, line breaks removed in the subject).

```tsx
import { Body, Button, Heading, Html, Text } from "@react-email/components";

export const subject = "Welcome, {{name}}";
export const from = "Acme <hello@acme.com>";          // optional default
export const PreviewProps = { name: "Ann", url: "https://acme.com/start" };

export default function Welcome({ name, url }: { name: string; url: string }) {
  return (
    <Html>
      <Body>
        <Heading>Hi {name}</Heading>
        <Text>Thanks for signing up.</Text>
        <Button href={url}>Get started</Button>
      </Body>
    </Html>
  );
}
```

**In the dashboard** (Email → Templates → New template): edit the TSX on the left, see it rendered on the right (desktop/mobile width, HTML or plain text), change sample values, Save (⌘S), Send test. The code runs only in your browser, in a sandboxed frame; templates may import `react` and `@react-email/components`.

**In your repo:** put each template in `emails/<id>.tsx` (files starting with `_` are skipped), point `mybase.config.ts` at the folder, and sync. The CLI renders them on your machine with your project's own `react` and `@react-email/render`:

```ts
// mybase.config.ts
import { defineConfig } from "@mybase-dev/sdk/config";
export default defineConfig({ project: "shop", email: { templates: "./emails" } });
```

```sh
bun add react react-dom @react-email/components @react-email/render
mybase email sync --dry-run     # then without --dry-run
```

Sync replaces the project's code templates (it asks before deleting any) and never touches dashboard ones. Code templates are read-only in the dashboard.

**Limits of stored templates:** values are strings, so a template can't loop over a list or branch on a variable. For an email like that (an order with line items), render it in your app with `@react-email/render` and send `html` and `text` directly.

## Sending

```ts
await email.send({
  template: "receipt",                     // or: from + subject + html/text
  to: ["ann@example.com"],                 // to + cc + bcc ≤ 50
  cc, bcc, replyTo,
  variables: { name: "Ann", total: "$42" },
  from: "Acme <billing@acme.com>",         // else the template's, else the project default
  attachments: [
    { filename: "invoice.pdf", content: base64 },            // ≤ 10 files, 10 MB total
    { filename: "terms.pdf", storageKey: "legal/terms.pdf" }, // from this project's bucket
  ],
  sendAt: new Date(Date.now() + 3_600_000), // up to 30 days ahead; cancel(id) until then
  idempotencyKey: `receipt-${orderId}`,     // same key within 24 h → same message, sent once
  tags: { kind: "receipt" },
});
```

`send` answers at once with `{ id, status: "queued" }`; mybase sends at your account's rate (1/s in the sandbox), retries throttling and AWS errors (10 s, 60 s, 5 min), and waits out a reached daily quota. `email.get(id)` returns the status and events; `email.cancel(id)` stops a queued or scheduled email. From the CLI: `mybase email send shop --template welcome --to ann@example.com --var name=Ann`.

Statuses: `queued`, `sending`, `sent` (SES accepted it), `delivered`, `delayed`, `bounced`, `complained` (marked as spam), `failed`, `canceled`. A status never moves backwards.

## Logs, bounces, and tracking

Email → Sent lists every email with its recipients, subject, template, and status; open one for its events (bounce diagnostics, clicked links) and the exact HTML and text that went out. `mybase email logs shop [--status bounced] [--follow]` and `mybase email show shop <id>` do the same. Emails are kept for 30 days by default (1–365, Email → Settings), then deleted with their content.

Addresses that **bounce permanently** or **mark your email as spam** are added to the project's suppression list, and sends that include one are refused (400, naming the addresses), which protects your SES reputation. Remove an address in Settings to email it again.

**Open and click tracking** are off by default. Turn them on per project in Settings: SES adds an invisible image and rewrites links through its own domain. Opens are approximate (Apple Mail and Gmail fetch images through proxies).

## Security

- **The API key sends as your domains.** Keep `MYBASE_API_KEY` server-side, limited to the project (`mybase token create … --perm email:write --project shop`). Anyone with it can email anyone from your verified addresses.
- **The AWS keys can send for every project** on the server. Give the IAM user only the policy above, and rotate the key in IAM if `.env` leaks (then `mybase server email` again).
- **Keep bounce and complaint rates low.** SES reviews accounts above 5% bounces or 0.1% complaints and can pause sending for the whole server. Only email people who asked for it, confirm addresses at sign-up, and never import purchased lists. `mybase doctor` warns when a project's rates climb.
- Template code never runs on the server: dashboard templates render in a sandboxed frame in your browser, code templates on your machine. Variables are HTML-escaped when filled in.
- Logs hold recipients and full email content until retention deletes them. Lower the retention if that's sensitive. mybase never writes recipients, subjects, or bodies to its own logs or the audit log.

More: [Security best practices](security-best-practices.md#email).

## Agent notes

- Apps send with `@mybase-dev/sdk/email` and an API key with `email:write`; `email:read` is enough for `get`. There are no MCP tools that send to arbitrary addresses: `send_test_email` sends a template's sample to one address the user gives.
- Templates are made in the dashboard or as `emails/<id>.tsx` + `mybase email sync`. Prefer the repo for apps you're building, so templates are versioned with the code.
- Every variable a template declares (its `PreviewProps`) is required when sending; a missing one is a 400 naming it.
- `from` must be at a verified domain of the same project. Check `list_email_domains` (or `mybase email domains <p>`) before sending; a pending domain can't send.
- In the SES sandbox, only verified recipient addresses get email. `mybase email status` says which mode the server is in.

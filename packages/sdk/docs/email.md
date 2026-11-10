# Email

Send email from your app with `@mybase-dev/sdk/email`: templates by id with variables, or HTML you rendered yourself, from domains verified for the project. Turn it on with `mybase email enable <project>` (the server needs SES keys: `mybase server email`).

## Send a template

```ts
import { createEmailClient } from "@mybase-dev/sdk/email";

const email = createEmailClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!, // email:write for this project; server-side only
});

const { id } = await email.send({ template: "welcome", to: "ann@example.com", variables: { name: "Ann" } });
```

Every variable the template declares is required. `from` defaults to the template's, then the project's default; it must be at a verified domain of the project.

## Send your own content

For emails a stored template can't express (lists, conditionals), render in your app and send the result:

```ts
import { render } from "@react-email/render";
import Receipt from "./emails/_receipt";

const el = <Receipt order={order} />;
await email.send({
  from: "Shop <orders@shop.com>",
  to: order.email,
  subject: `Receipt for order ${order.number}`,
  html: await render(el),
  text: await render(el, { plainText: true }),
});
```

## Options

```ts
await email.send({
  template: "invoice",
  to: ["ann@example.com"], cc: [], bcc: [], replyTo: "billing@shop.com",
  variables: { name: "Ann" },
  attachments: [
    { filename: "invoice.pdf", content: pdfBase64 },                 // base64
    { filename: "terms.pdf", storageKey: "legal/terms.pdf" },        // a file in the project's bucket
  ],
  sendAt: new Date(Date.now() + 24 * 3_600_000),                     // schedule, up to 30 days
  idempotencyKey: `invoice-${invoiceId}`,                            // retries within 24 h send once
  tags: { kind: "invoice" },
});
```

Limits (`EMAIL_LIMITS`): 50 recipients (to + cc + bcc), 10 attachments and 10 MB per email, 10 tags.

## Status and cancel

```ts
const msg = await email.get(id);   // status, recipients, events: delivery, bounce, open, click…
await email.cancel(id);            // queued or scheduled only; 409 once it's being sent
```

Statuses: `queued`, `sending`, `sent`, `delivered`, `delayed`, `bounced`, `complained`, `failed`, `canceled`. Addresses that bounced for good or marked your email as spam are refused (400) until removed from the project's suppression list.

Errors throw `MybaseApiError` with the HTTP `status` and mybase's message.

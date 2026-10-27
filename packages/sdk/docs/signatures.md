# Signatures and verification

mybase signs every cron call. `cronHandler` verifies automatically. If you need to inspect a request yourself, use `verifyCronRequest` before trusting its body.

## Verify a request

```ts
import { verifyCronRequest, CronVerificationError } from "@mybase/sdk/cron";

try {
  const run = await verifyCronRequest(request, process.env.MYBASE_CRON_SECRET!);
  // run.job, run.runId, run.payload, run.trigger ...
} catch (error) {
  if (error instanceof CronVerificationError) return new Response("Unauthorized", { status: 401 });
  throw error;
}
```

`verifyCronRequest` consumes the Fetch API request body. If your framework gives you the raw body and header instead, use `verifyCronSignature({ body, signature, secret })`. Pass the **exact raw body**; parsing and re-serializing JSON changes the signature. Both helpers accept an array of secrets during rotation and default to a five-minute timestamp tolerance.

## Wire format

### Cron calls

Cron calls include this header:

```text
X-Mybase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

The body is JSON with `job`, `runId`, `attempt`, `trigger`, `scheduledAt`, `firedAt`, and `payload`. Task calls may also carry `key`. `X-Mybase-Job` and `X-Mybase-Run` carry the job name and run ID.

Calls from your app to mybase (`createCronClient`) aren't signed: they carry an API key as `Authorization: Bearer`. `signCronRequest` is exported from `@mybase/sdk/cron` for tests and integrations that need it.

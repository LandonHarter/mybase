# Captcha

Check forms for bots with mybase's self-hosted, proof-of-work captcha: no puzzles, no cookies, no third party. Turn it on with `mybase captcha enable <project>`.

## In the browser

The script tag wires up forms marked `data-mybase-captcha`:

```html
<script defer src="https://mybase.example.com/captcha.js" data-project="shop"></script>
<form method="post" data-mybase-captcha>…</form>
```

Or solve a challenge yourself (browser or Node, Web Crypto):

```ts
import { solveCaptcha } from "@mybase-dev/sdk/captcha";

const token = await solveCaptcha({ apiUrl: "https://mybase.example.com", project: "shop" });
await fetch("/signup", { method: "POST", headers: { "x-captcha-response": token }, body });
```

`solveChallenge(challenge, { signal })` solves a challenge you fetched (`GET /captcha/<project>/challenge`).

## On the server

```ts
import { createCaptchaClient } from "@mybase-dev/sdk/captcha";

const captcha = createCaptchaClient({ apiUrl: "https://mybase.example.com", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
const { success, error } = await captcha.verify(token);
```

The API key needs `captcha:write`. A token works once, within 5 minutes; `error` is `invalid`, `expired`, `used`, or `unavailable`. With Better Auth, use `mybaseCaptcha()` from [Better Auth](better-auth.md) instead.

`CAPTCHA_LIMITS` holds the expiry and difficulty bounds.

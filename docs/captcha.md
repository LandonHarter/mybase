---
title: Captcha
summary: Self-hosted proof-of-work bot checks for your forms, with no puzzles, cookies, or third party.
section: Services
order: 21
---

# Captcha

A bot check that doesn't ask people anything. The browser fetches a signed challenge from mybase and finds a number whose SHA-256 matches (a fraction of a second, done in the background). Your server then checks the answer once with mybase. Bots have to pay that work for every submission, and a token can't be reused. Nothing is loaded from Google or Cloudflare, and no cookies are set.

```sh
mybase captcha enable shop        # prints the script tag and the secret
```

## On a form

```html
<script defer src="{{MYBASE_URL}}/captcha.js" data-project="shop"></script>

<form method="post" action="/signup" data-mybase-captcha>
  <input name="email" type="email" required>
  <span class="mybase-captcha-status"></span>
  <button>Sign up</button>
</form>
```

On submit, the script holds the form, solves a challenge, and submits it with a hidden `mybase-captcha` field. For forms you send with `fetch`, call `await window.mybase.captcha.solve()` and send the token yourself.

## On your server

```ts
import { createCaptchaClient } from "@mybase-dev/sdk/captcha";

const captcha = createCaptchaClient({ apiUrl: "{{MYBASE_URL}}", project: "shop", apiKey: process.env.MYBASE_API_KEY! }); // captcha:write
const { success, error } = await captcha.verify(form.get("mybase-captcha"));
```

`error` is `invalid`, `expired` (tokens last 5 minutes), `used` (each works once), or `unavailable` (the cache is down: tokens are refused rather than let through).

## With Better Auth

Better Auth's own captcha plugin works with mybase: `mybaseCaptcha()` points it at mybase's Turnstile-compatible check.

```ts
import { captcha } from "better-auth/plugins";
import { mybaseCaptcha } from "@mybase-dev/sdk/better-auth";

plugins: [captcha(mybaseCaptcha({ apiUrl: "{{MYBASE_URL}}", project: "shop", secretKey: process.env.MYBASE_CAPTCHA_SECRET! }))];
```

The browser sends the token in the `x-captcha-response` header (`authClient.signUp.email(data, { headers: { "x-captcha-response": token } })`).

Any client for Cloudflare Turnstile's siteverify can use `POST {{MYBASE_URL}}/captcha/<project>/siteverify` with `{ secret, response }`.

## Settings

- **Secret** (`mybase captcha key shop [--rotate]`): for siteverify and Better Auth. It can only check tokens, not make them.
- **Difficulty** (`mybase captcha difficulty shop 100000`): how many numbers a browser may try, 1,000–1,000,000 (default 50,000, about 0.1–0.5 s). Raise it if bots get through; slow phones take longer.

## Agent notes

- Challenges (`GET /captcha/<p>/challenge`) are public and limited to 60 per minute per IP.
- Verify each token on the server; the widget alone proves nothing.
- Combine with [rate limits](rate-limits.md) on sign-up and sign-in routes.

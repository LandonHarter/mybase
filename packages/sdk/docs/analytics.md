# Analytics

Count page views and visitors, see which routes, referrers, countries, and browsers they come from, and collect errors and custom events from your apps. Results show on the project's Analytics page in the mybase dashboard.

No cookies or local storage are used, and IP addresses are never stored.

## Turn it on

Turn on Analytics on the project's page in the dashboard, or run:

```sh
mybase analytics enable shop
```

Both give you the project's **write key** (`mba_…`). The write key is public: put it in browser code. It can only add events, never read them. If someone abuses it, rotate it on the Setup tab or with `mybase analytics key shop --rotate`.

## Script tag

For any website, add one tag. It records page views (including client-side route changes in single-page apps) and uncaught errors.

```html
<script defer src="https://mybase.example.com/analytics.js"
  data-project="shop" data-key="mba_…"></script>
```

Send custom events from anywhere on the page after it loads:

```js
mybase.track("signup", { plan: "pro" });
mybase.captureError(new Error("payment failed"), { provider: "stripe" });
```

| Attribute | Default | Meaning |
| --- | --- | --- |
| `data-project` | required | The mybase project |
| `data-key` | required | The project's write key |
| `data-api` | where the script came from | The mybase API URL |
| `data-pageviews="false"` | on | Don't record page views automatically |
| `data-errors="false"` | on | Don't record uncaught errors |
| `data-keep-query` | off | Keep query strings in paths (`/search?q=x`) |
| `data-respect-dnt` | off | Send nothing when Do Not Track is on |

## npm

For bundled apps, use the same client from `@mybase-dev/sdk/analytics`:

```ts
// analytics.ts
import { createAnalytics } from "@mybase-dev/sdk/analytics";

export const analytics = createAnalytics({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  key: "mba_…", // public; fine in browser code
});
```

```ts
import { analytics } from "./analytics";

analytics.track("checkout", { items: 3, total: 42.5 });

try {
  await pay();
} catch (err) {
  analytics.captureError(err, { step: "pay" });
  throw err;
}
```

Create the client once, when your app starts. In a browser it records the first page view right away, then one per route change: it listens to `history.pushState`, `replaceState`, and `popstate`, so React Router, Next.js, Vue Router, and other history-based routers work without extra code. A route change that only changes the query string isn't a new page view unless you set `keepQuery`.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | required | Where the mybase API is reachable |
| `project` | required | The mybase project |
| `key` | required | The write key |
| `autoPageviews` | `true` | Record page views on load and route changes (browser) |
| `captureErrors` | `true` | Record uncaught errors and unhandled rejections (browser) |
| `keepQuery` | `false` | Keep query strings in paths |
| `respectDoNotTrack` | `false` | Send nothing when Do Not Track is on |
| `flushIntervalMs` | `5000` | How long to collect events before sending |
| `batchSize` | `20` | Send right away once this many are queued (max 50) |
| `onError` | none | Called when a send fails |
| `fetch` | `globalThis.fetch` | A custom fetch |

### Methods

| Method | Does |
| --- | --- |
| `pageview(path?, props?)` | Records a page view. For routers that don't use the History API, set `autoPageviews: false` and call this yourself |
| `track(name, props?)` | Records a custom event |
| `captureError(error, props?)` | Records an error with its stack trace |
| `flush()` | Sends everything queued now |
| `stop()` | Sends what's queued and removes the client's listeners |

The client never throws into your app. Events are queued and sent in batches; when the page is hidden or closed, the queue goes out with `navigator.sendBeacon`. A failed send is dropped and reported to `onError`.

## Custom events

An event has a name and optional props:

- **Name:** 1–64 letters, digits, spaces, or `_ . : -`. For example `signup`, `checkout:done`, `Video played`.
- **Props:** up to 20 keys, each up to 64 characters. Values are strings (up to 256 characters), numbers, booleans, or `null`. Nested objects aren't allowed. The client drops props that break these rules, so the rest of the event still arrives.

The Overview tab counts events by name. The Events tab lists recent events with their props.

## Errors

In a browser the client records `window` errors and unhandled promise rejections. It sends the error's name, message, stack, and the current route. The same error is sent once per page load, and at most 20 distinct errors are sent per page load, so a crash loop can't flood your project.

mybase groups errors by message and top stack frame (line and column numbers are ignored, so a new deploy doesn't split a group). Open a group on the Errors tab to see its latest stack trace.

## Server-side

The same client works in Node 20+, Bun, Deno, and edge runtimes. With no `window`, nothing is recorded automatically. Call `flush()` before a short-lived process exits:

```ts
import { createAnalytics } from "@mybase-dev/sdk/analytics";

const analytics = createAnalytics({ apiUrl: process.env.MYBASE_URL!, project: "shop", key: process.env.MYBASE_ANALYTICS_KEY! });

analytics.track("invoice.paid", { amount: 1200 });
await analytics.flush();
```

Server-side events count toward event and error totals. They all come from your server's address, so they don't tell you about visitors.

## Visitors and privacy

mybase counts visitors without cookies. Each event's visitor is a hash of a random salt, the project, the client's IP address, and its user agent. The salt changes every day (UTC) and old salts are deleted, so:

- A visitor can't be followed from one day to the next, or traced back to an IP address.
- The visitor count for a range of several days counts each person once per day they visited.
- People behind one shared IP with the same browser count as one visitor.

Known crawlers and link previewers (Googlebot, headless Chrome, social-media previews) are accepted but not recorded.

## Countries

mybase doesn't ship a GeoIP database. A visitor's country comes from:

1. Cloudflare's `CF-IPCountry` header, when mybase runs behind a Cloudflare Tunnel with `MYBASE_TRUST_PROXY=cloudflare`.
2. Otherwise, the country of the browser's time zone (the client sends it), for example `Europe/Berlin` → Germany. This is right for most visitors, but travellers and VPN users count where their clock says they are.

Server-side events usually have no country.

## Settings

On the Analytics page's Setup tab:

- **Allowed origins:** when set, browsers can send events only from these origins, for example `https://shop.example.com`. Others get `403`. Requests without an `Origin` header (servers) aren't affected.
- **Retention:** events older than this many days (1–365, default 90) are deleted every hour.
- **Delete events** removes every event and keeps the key and settings. **Turn off analytics** removes everything.

New events show on the dashboard within about 10 seconds.

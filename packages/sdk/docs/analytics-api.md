# Analytics API

Send events from any language, or read a project's analytics from scripts. The [SDK](analytics.md) wraps the ingest route.

## Send events

```
POST /analytics/<project>/events
Content-Type: text/plain   (or application/json)
```

```json
{
  "key": "mba_…",
  "events": [
    { "type": "pageview", "path": "/pricing", "referrer": "https://news.ycombinator.com/", "tz": "Europe/Berlin" },
    { "type": "event", "name": "signup", "props": { "plan": "pro" } },
    { "type": "error", "name": "TypeError: x is undefined", "stack": "TypeError: x is undefined\n    at Cart (app.js:10:5)", "path": "/cart" }
  ]
}
```

No admin token is needed: the write key in the body is the credential. The route allows cross-origin requests from any site (CORS `*`, no cookies). A `text/plain` body skips the CORS preflight and works with `navigator.sendBeacon`.

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `pageview`, `event`, or `error` |
| `path` | page views | The route. Up to 512 characters; a leading `/` is added if missing |
| `name` | events, errors | Event name (1–64 letters, digits, spaces, `_ . : -`), or the error message (up to 512 characters) |
| `referrer` | no | Page views only. Only the host is kept, and only when it's another site |
| `props` | no | Up to 20 keys (64 characters each); string (256), number, boolean, or `null` values |
| `stack` | no | Errors only. Up to 4 KB |
| `tz` | no | The browser's IANA time zone, used to guess the country |
| `ts` | no | When it happened (ISO 8601). Kept if within the last hour, otherwise replaced with the time mybase received it |

mybase adds the visitor hash, country, browser, operating system, and device class from the request. See [Visitors and privacy](analytics.md).

### Responses

| Status | Meaning |
| --- | --- |
| `202` | `{ "accepted": 3 }`. Crawlers get `202` with `accepted: 0` |
| `400` | An event is invalid, more than 50 events were sent, or the body isn't JSON. The whole batch is rejected, and the error names the event (`events[2]: …`) |
| `401` | Wrong write key, unknown project, or analytics is off. All three get the same answer |
| `403` | The request's `Origin` isn't in the project's allowed origins |
| `413` | The body is over 64 KB |
| `429` | More than 300 events in a minute from one IP address. Retry after `Retry-After` seconds |

### Example

```sh
curl -X POST https://mybase.example.com/analytics/shop/events \
  -H 'Content-Type: application/json' \
  -d '{"key":"mba_…","events":[{"type":"event","name":"deploy","props":{"version":"1.4.0"}}]}'
```

## Script

`GET /analytics.js` serves the [script-tag](analytics.md) build of the client (about 5 KB). It's public and cached for an hour.

## Read analytics

These routes need an admin API token (`Authorization: Bearer mb_…`, from `mybase login` or Settings in the dashboard). Never put an admin token in an app.

| Route | Returns |
| --- | --- |
| `GET /projects/<project>/analytics?range=7d&tz=America/Chicago` | Totals, the previous period's totals, a page-view series, and top routes, referrers, countries, browsers, operating systems, devices, custom events, and errors |
| `GET /projects/<project>/analytics/events?type=error&name=…&fingerprint=…&limit=50` | Recent events, newest first. Every filter is optional; `limit` is 1–200 |
| `DELETE /projects/<project>/analytics/events` | Deletes every event |
| `GET /projects/<project>/analytics/settings` | Write key, allowed origins, retention, and the ingest and script URLs |
| `PATCH /projects/<project>/analytics/settings` | Body `{ "allowedOrigins": ["https://shop.example.com"], "retentionDays": 30 }`; either field |
| `POST /projects/<project>/analytics/key/rotate` | Replaces the write key and returns the settings |
| `PUT` / `DELETE /projects/<project>/services/analytics` | Turns analytics on or off. Turning it off deletes every event |

`range` is `24h` (hourly buckets), `7d`, `30d`, or `90d` (daily buckets); the default is `7d`. Buckets follow `tz` (default `UTC`), so "today" matches your clock. The types are exported from `@mybase/shared` in the mybase repo: `AnalyticsOverview`, `AnalyticsEventRecord`, `AnalyticsSettings`.

From the terminal:

```sh
mybase analytics stats shop --range 30d
```

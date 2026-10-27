---
title: Analytics
summary: Cookieless page views, custom events, and errors from your app, with a script tag or the SDK.
section: Services
order: 16
---

# Analytics

```sh
mybase analytics enable shop     # prints the public write key and a script tag
mybase analytics stats shop --range 7d
```

Add the script tag, or `createAnalytics` from `@mybase/sdk/analytics`:

```html
<script defer src="{{MYBASE_URL}}/analytics.js" data-project="shop" data-key="mba_…"></script>
```

It records page views (including client-side route changes) and uncaught errors; `track("signup", { plan })` adds custom events. No cookies; visitors are a daily-rotating hash and IPs are never stored. Guides: [SDK analytics](sdk/analytics.md), [wire format](sdk/analytics-api.md).

## Agent notes

- The write key (`mba_…`) is public and only adds events: fine in browser code. Never put an `mb_…` API key in the browser.
- Events are buffered and written every 10 s, so new data shows up after a short delay.

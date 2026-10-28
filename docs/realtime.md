---
title: Realtime
summary: WebSocket channels for live updates, chat, and presence, for apps on hosts that can't hold sockets.
section: Services
order: 22
---

# Realtime

Serverless hosts (Vercel, Netlify, …) can't keep a WebSocket open. mybase can: browsers connect to mybase and subscribe to channels, your backend publishes over HTTP, and mybase fans the messages out. Like Pusher or Ably, on your own machine.

```sh
mybase realtime enable shop        # prints the socket URL and the secret
```

How it fits together:

1. **Your server signs a token** for each browser with `MYBASE_REALTIME_SECRET`: who the user is and which channels they may subscribe or publish to. No call to mybase.
2. **The browser connects** to `{{MYBASE_URL}}/realtime/shop` with `connectRealtime` and subscribes to channels.
3. **Your server publishes** with an API key (`realtime:write`), or browsers publish to each other where their token allows.
4. **Optionally, a webhook** tells your server what browsers did (messages, presence changes).

## Tokens (your server)

```ts
import { createRealtimeToken } from "@mybase-dev/sdk/realtime";

// e.g. GET /api/realtime-token, behind your own auth
const token = await createRealtimeToken(process.env.MYBASE_REALTIME_SECRET!, {
  project: "shop",
  userId: user.id,                 // shown to others in presence channels and on messages
  userInfo: { name: user.name },   // ≤ 1 KB, seen by presence members
  subscribe: [`user:${user.id}`, "presence:lobby", "orders:*"],
  publish: ["presence:lobby"],     // default: none (only your server publishes)
  ttl: 3600,                       // seconds, max 86400
});
```

Patterns are exact names, `prefix*`, or `*`.

## Browser

```ts
import { connectRealtime } from "@mybase-dev/sdk/realtime";

const rt = connectRealtime({
  apiUrl: "{{MYBASE_URL}}",
  project: "shop",
  token: () => fetch("/api/realtime-token").then((r) => r.text()),
});

const orders = rt.channel(`user:${userId}`);
orders.on("order.shipped", (data) => toast(`Order ${data.orderId} shipped`));
```

Pass `token` as a function: it's called on every (re)connect and again before the token expires. The client reconnects with backoff and resubscribes on its own.

## Publishing (your server)

```ts
import { createRealtimeClient } from "@mybase-dev/sdk/realtime";

const realtime = createRealtimeClient({ apiUrl: "{{MYBASE_URL}}", project: "shop", apiKey: process.env.MYBASE_API_KEY! });
await realtime.publish(`user:${userId}`, "order.shipped", { orderId });
await realtime.publishBatch([{ channel: "orders:42", event: "updated", data: { status: "paid" } }]); // ≤ 100, 64 KB
```

Or plain HTTP: `POST {{MYBASE_URL}}/realtime/shop/publish` with `Authorization: Bearer <key>` and `{ "channel", "event", "data" }` (or `{ "messages": [...] }`).

## Channels

- **Plain** (`orders:42`): need a token that allows them.
- **`public:…`**: browsers without a token may listen (never publish). Turn off with `mybase realtime settings shop --public off`.
- **`presence:…`**: track who's in them. Needs a token with a `userId`; several tabs of one user count once. `channel.members()` and `channel.onPresence(…)` in the browser, `realtime.members(channel)` on the server.

Names: letters, digits, and `_-:.=@`, up to 128 characters. Event names: up to 64 of letters, digits, `_-:.`.

## Webhooks

Set a URL to hear about browser activity on your server: messages browsers publish, presence joins and leaves, and channels becoming occupied or empty.

```sh
mybase realtime settings shop --webhook https://shop.example.com/api/realtime-webhook --events message,presence
```

```ts
import { verifyRealtimeWebhook } from "@mybase-dev/sdk/realtime";

export async function POST(req: Request) {
  const { events } = await verifyRealtimeWebhook(req, process.env.MYBASE_REALTIME_SECRET!);
  for (const e of events) if (e.type === "message") await saveChat(e.channel, e.uid, e.data);
  return new Response("ok");
}
```

Calls are batched (up to 100 events, about once a second), signed like cron calls, and retried after 10 s, 60 s, and 5 min on errors. Messages are delivered to browsers without waiting for the webhook.

## Settings and limits

`mybase realtime settings shop [--origins https://shop.example.com] [--max-connections 500] [--max-channels 100] [--max-message-bytes 32768] [--max-rate 20]`

- **Allowed origins**: sites whose pages may connect (empty = any). Browsers enforce `Origin`; other clients can fake it, so tokens are the real control.
- **Limits** (defaults): 500 connections per project, 100 channels per connection, 32 KB frames, 20 frames per second per connection. Past the rate, frames are refused; 5 s over closes the socket.
- **Secret** (`mybase realtime key shop [--rotate]`): rotating closes every connection; SDK clients reconnect with fresh tokens.

## Agent notes

- Never send `MYBASE_REALTIME_SECRET` or an API key to the browser: tokens are signed on the server.
- Give each token the narrowest channel patterns that work (`user:<id>`, not `*`).
- State lives in memory on one mybase instance: no message history. If a browser is offline when a message goes out, it misses it; keep the source of truth in the database and use realtime to say "something changed".
- Through a Cloudflare Tunnel, sockets work as-is; the SDK pings every 25 s so idle ones stay open.
- MCP tools: `realtime_stats`, `list_realtime_channels`, `realtime_publish`.

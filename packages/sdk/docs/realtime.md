# Realtime

Live updates, chat, and presence over WebSockets, for apps on hosts that can't hold sockets (Vercel, Netlify, …): browsers connect to mybase, your server publishes over HTTP. Turn it on with `mybase realtime enable <project>`.

## Sign a token (server)

Browsers never see the secret. Your server signs a short-lived token saying who the user is and which channels they may use:

```ts
import { createRealtimeToken } from "@mybase-dev/sdk/realtime";

// app/api/realtime-token/route.ts (Next.js), behind your auth
export async function GET(req: Request) {
  const user = await currentUser(req);
  const token = await createRealtimeToken(process.env.MYBASE_REALTIME_SECRET!, {
    project: "shop",
    userId: user.id,
    userInfo: { name: user.name },
    subscribe: [`user:${user.id}`, "presence:*"],
    publish: ["presence:*"],
    ttl: 3600,
  });
  return new Response(token);
}
```

Channel patterns: exact names, `prefix*`, or `*`. Channels named `public:…` need no token to listen (if the project allows it).

## Connect (browser, or any runtime with WebSocket)

```ts
import { connectRealtime } from "@mybase-dev/sdk/realtime";

const rt = connectRealtime({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  token: () => fetch("/api/realtime-token").then((r) => r.text()),
});

rt.on("state", (s) => console.log(s)); // connecting | open | closed
rt.on("error", (err) => console.warn(err.code, err.message));

const room = rt.channel("presence:room-1");
await room.ready();                              // subscribed (again after each reconnect)
const off = room.on("chat", (data, meta) => {    // meta: { channel, event, uid, id, at }
  console.log(meta.uid, data);
});
room.on("*", (data, meta) => {});                // every event
await room.publish("chat", { text: "hi" });      // to everyone else in the channel

room.members();                                  // [{ uid, info }], you included
room.onPresence(({ action, member }) => {});     // join | leave

room.unsubscribe();
rt.close();
```

- `token` as a function is called on every connect and again a minute before the token expires.
- Reconnects with backoff (up to 30 s) and resubscribes every channel.
- A fixed `token` string that's refused or expires closes the connection for good; pass a function to recover.
- Your own messages don't come back to you.

## Publish (server)

```ts
import { createRealtimeClient } from "@mybase-dev/sdk/realtime";

const realtime = createRealtimeClient({
  apiUrl: "https://mybase.example.com",
  project: "shop",
  apiKey: process.env.MYBASE_API_KEY!, // realtime:write (realtime:read for channels/members)
});

await realtime.publish("user:42", "order.shipped", { orderId: "o_1" }); // → message id
await realtime.publishBatch([{ channel: "orders", event: "new", data: {} }]); // ≤ 100, 64 KB
await realtime.channels({ prefix: "presence:" }); // [{ channel, subscribers, members? }]
await realtime.members("presence:room-1");        // [{ uid, info }]
```

## Webhooks (server)

With a webhook URL set (dashboard or `mybase realtime settings <p> --webhook <url>`), mybase POSTs what browsers do:

```ts
import { verifyRealtimeWebhook } from "@mybase-dev/sdk/realtime";

export async function POST(req: Request) {
  const { events } = await verifyRealtimeWebhook(req, process.env.MYBASE_REALTIME_SECRET!);
  for (const e of events) {
    if (e.type === "message") {}  // { channel, event, data, uid, id, at }
    if (e.type === "presence") {} // { channel, action: "join" | "leave", member, at }
    if (e.type === "channel") {}  // { channel, action: "occupied" | "vacated", at }
  }
  return new Response("ok");
}
```

Batches of up to 100 events, signed with `X-Mybase-Signature` (see [signatures](signatures.md)); non-2xx answers are retried after 10 s, 60 s, and 5 min.

## Errors

Refused actions reject with `RealtimeError` (`err.code`): `forbidden` (token doesn't allow the channel), `bad_channel`, `bad_event`, `too_large`, `too_many_channels`, `rate_limited`, `unauthorized`, `timeout`, `closed`. Close codes: 4001 bad token, 4002 secret rotated, 4003 token expired, 4004 realtime turned off, 4008 sent too fast.

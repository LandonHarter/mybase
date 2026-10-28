import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { REALTIME_WEBHOOK_EVENTS, type Project, type RealtimeSettings, type RealtimeWebhookEventType } from "@mybase/shared";
import { formatCount, LoadError, LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { ProjectGate } from "@/components/project-gate";
import { Row } from "@/components/row";
import { SERVICE_PAGES } from "@/components/service-card";
import { ServiceOff } from "@/components/service-off";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessage, useLoad } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href, navigate } from "@/lib/router";

// Same bounds as REALTIME_LIMITS in the SDK; the API checks them.
const LIMITS = {
  maxConnections: { label: "Connections", hint: "Open sockets for this project", min: 1, max: 10_000 },
  maxChannels: { label: "Channels per connection", hint: "Subscriptions one socket may hold", min: 1, max: 1_000 },
  maxMessageBytes: { label: "Frame size (bytes)", hint: "Largest message a browser may send", min: 1024, max: 1024 * 1024 },
  maxRate: { label: "Frames per second", hint: "Per socket; past it, frames are refused", min: 1, max: 1_000 },
} as const;

const EVENT_LABELS: Record<RealtimeWebhookEventType, string> = {
  message: "Messages browsers publish",
  presence: "Presence joins and leaves",
  channel: "Channels occupied and vacated",
};

const code = (text: string) => <pre className="overflow-x-auto rounded-md border bg-accent/40 p-3 font-mono text-xs">{text}</pre>;

const tokenSnippet = (apiUrl: string, project: string) => `// Your server (e.g. app/api/realtime-token/route.ts on Vercel)
import { createRealtimeToken } from "@mybase-dev/sdk/realtime";

export async function GET(req: Request) {
  const user = await currentUser(req); // your auth
  const token = await createRealtimeToken(process.env.MYBASE_REALTIME_SECRET!, {
    project: "${project}",
    userId: user.id,
    userInfo: { name: user.name },
    subscribe: [\`user:\${user.id}\`, "presence:lobby"],
    publish: ["presence:lobby"],
  });
  return new Response(token);
}`;

const browserSnippet = (apiUrl: string, project: string) => `import { connectRealtime } from "@mybase-dev/sdk/realtime";

const rt = connectRealtime({
  apiUrl: "${apiUrl}",
  project: "${project}",
  token: () => fetch("/api/realtime-token").then((r) => r.text()),
});

const lobby = rt.channel("presence:lobby");
lobby.on("chat", (data, { uid }) => console.log(uid, data));
lobby.onPresence(() => console.log(lobby.members()));
await lobby.publish("chat", { text: "hi" });`;

const serverSnippet = (apiUrl: string, project: string) => `import { createRealtimeClient } from "@mybase-dev/sdk/realtime";

const realtime = createRealtimeClient({ apiUrl: "${apiUrl}", project: "${project}", apiKey: process.env.MYBASE_API_KEY! });

await realtime.publish(\`user:\${userId}\`, "order.shipped", { orderId });`;

const webhookSnippet = `import { verifyRealtimeWebhook } from "@mybase-dev/sdk/realtime";

export async function POST(req: Request) {
  const { events } = await verifyRealtimeWebhook(req, process.env.MYBASE_REALTIME_SECRET!);
  for (const e of events) if (e.type === "message") await saveChat(e.channel, e.uid, e.data);
  return new Response("ok");
}`;

function Live({ name }: { name: string }) {
  const stats = useLoad(`realtime-stats:${name}`, () => api.realtimeStats(name));
  const channels = useLoad(`realtime-channels:${name}`, () => api.realtimeChannels(name));
  const { refresh: refreshStats } = stats;
  const { refresh: refreshChannels } = channels;
  const refresh = () => {
    void refreshStats();
    void refreshChannels();
  };
  // Live numbers: refresh while the page is open.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshStats();
      void refreshChannels();
    }, 10_000);
    return () => clearInterval(timer);
  }, [refreshStats, refreshChannels]);

  const totals = stats.state.status === "ready" ? stats.state.data.hours.reduce((t, h) => ({ in: t.in + h.messagesIn, out: t.out + h.messagesOut }), { in: 0, out: 0 }) : null;

  return (
    <section aria-labelledby="realtime-live" className="mb-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="realtime-live" className="text-base font-semibold">
          Live
        </h2>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      {stats.state.status === "loading" && <LoadingLines label="Loading realtime stats" lines={2} />}
      {stats.state.status === "error" && <LoadError what="realtime stats" message={stats.state.message} onRetry={refresh} />}
      {stats.state.status === "ready" && totals && (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
            {[
              ["Connections", stats.state.data.connections],
              ["Peak", stats.state.data.peakConnections],
              ["Channels", stats.state.data.channels],
              ["Messages delivered (24 h)", totals.out],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold">{formatCount(value as number)}</dd>
              </div>
            ))}
          </dl>
          {stats.state.data.webhook.lastError && (
            <p role="alert" className="mb-4 text-destructive">
              Webhook failing: {stats.state.data.webhook.lastError} ({stats.state.data.webhook.queued} queued, {stats.state.data.webhook.dropped} dropped)
            </p>
          )}
        </>
      )}
      {channels.state.status === "ready" &&
        (channels.state.data.channels.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-muted-foreground">No one is connected. Channels show up here while a browser is subscribed to them.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Subscribers</TableHead>
                <TableHead className="text-right">Members</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.state.data.channels.map((c) => (
                <TableRow key={c.channel}>
                  <TableCell className="font-mono text-xs">{c.channel}</TableCell>
                  <TableCell className="text-right">{formatCount(c.subscribers)}</TableCell>
                  <TableCell className="text-right">{c.members === undefined ? "" : formatCount(c.members)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}

interface LogLine {
  id: number;
  at: string;
  text: string;
}

/** Connects like an app's browser would (same protocol as the SDK), with a 5-minute token for every channel. */
function TryIt({ name }: { name: string }) {
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState<"closed" | "connecting" | "open">("closed");
  const [channels, setChannels] = useState<string[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const add = (text: string) => setLog((l) => [{ id: ++seq.current, at: new Date().toLocaleTimeString(), text }, ...l].slice(0, 100));

  useEffect(() => () => socket.current?.close(), []);

  async function connect() {
    setError(null);
    setState("connecting");
    try {
      const { token } = await api.realtimeToken(name);
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/realtime/${name}`);
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data));
        if (frame.type === "ready") {
          setState("open");
          add("connected");
        } else if (frame.type === "message") add(`${frame.channel} · ${frame.event} ${JSON.stringify(frame.data)}`);
        else if (frame.type === "presence") add(`${frame.channel} · ${frame.member.uid} ${frame.action === "join" ? "joined" : "left"}`);
        else if (frame.type === "subscribed") {
          setChannels((c) => [...new Set([...c, frame.channel])]);
          add(`subscribed to ${frame.channel}${frame.members ? ` (${frame.members.length} here)` : ""}`);
        } else if (frame.type === "error") add(`error: ${frame.message}`);
      };
      ws.onclose = (e) => {
        if (socket.current !== ws) return;
        socket.current = null;
        setState("closed");
        setChannels([]);
        add(`closed${e.reason ? `: ${e.reason}` : ""}`);
      };
    } catch (err) {
      setState("closed");
      setError(errorMessage(err));
    }
  }

  function subscribe(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const channel = String(new FormData(e.currentTarget).get("channel") ?? "").trim();
    if (channel) socket.current?.send(JSON.stringify({ type: "subscribe", channel }));
  }

  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const raw = String(form.get("data") ?? "").trim();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    try {
      await api.realtimePublish(name, String(form.get("channel") ?? "").trim(), String(form.get("event") ?? "").trim(), data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section aria-labelledby="realtime-try" className="mb-10">
      <h2 id="realtime-try" className="mb-3 text-base font-semibold">
        Try it
      </h2>
      <Row title="Listen" hint="Opens a socket from this page, as a browser of your app would, and subscribes to channels. If you limit origins, add this dashboard's.">
        <div className="grid gap-3">
          {state === "closed" ? (
            <div>
              <Button variant="outline" onClick={() => void connect()}>
                Connect
              </Button>
            </div>
          ) : (
            <form onSubmit={subscribe} className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="rt-sub">Channel</Label>
                <Input id="rt-sub" name="channel" placeholder="presence:lobby" className="w-56 font-mono text-xs md:text-xs" disabled={state !== "open"} />
              </div>
              <Button type="submit" variant="outline" disabled={state !== "open"}>
                Subscribe
              </Button>
              <Button type="button" variant="ghost" onClick={() => socket.current?.close()}>
                Disconnect
              </Button>
            </form>
          )}
          {channels.length > 0 && <p className="text-muted-foreground">Listening on {channels.join(", ")}</p>}
          <ol aria-live="polite" aria-label="Received" className="max-h-64 overflow-y-auto rounded-md border font-mono text-xs empty:hidden">
            {log.map((l) => (
              <li key={l.id} className="border-b px-3 py-1.5 last:border-b-0">
                <span className="text-muted-foreground">{l.at}</span> {l.text}
              </li>
            ))}
          </ol>
        </div>
      </Row>
      <Row title="Publish" hint="Sends from the server side, like createRealtimeClient: everyone subscribed gets it, this page too.">
        <form onSubmit={publish} className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rt-pub-channel">Channel</Label>
              <Input id="rt-pub-channel" name="channel" required placeholder="presence:lobby" className="w-56 font-mono text-xs md:text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rt-pub-event">Event</Label>
              <Input id="rt-pub-event" name="event" required placeholder="chat" className="w-40 font-mono text-xs md:text-xs" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rt-pub-data">Data (JSON)</Label>
            <Textarea id="rt-pub-data" name="data" rows={3} placeholder='{ "text": "hello" }' className="font-mono text-xs md:text-xs" />
          </div>
          <div>
            <Button type="submit" variant="outline">
              Publish
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </form>
      </Row>
    </section>
  );
}

function Settings({ name, settings, onSaved }: { name: string; settings: RealtimeSettings; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [publicChannels, setPublicChannels] = useState(settings.publicChannels);
  const [events, setEvents] = useState<RealtimeWebhookEventType[]>(settings.webhookEvents);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      await api.updateRealtime(name, {
        maxConnections: Number(form.get("maxConnections")),
        maxChannels: Number(form.get("maxChannels")),
        maxMessageBytes: Number(form.get("maxMessageBytes")),
        maxRate: Number(form.get("maxRate")),
        publicChannels,
        allowedOrigins: String(form.get("allowedOrigins") ?? "")
          .split(/[\s,]+/)
          .filter(Boolean),
        webhookUrl: String(form.get("webhookUrl") ?? "").trim() || null,
        webhookEvents: events,
      });
      toast.success("Saved realtime settings");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={save}>
      <Row title="Public channels" hint="Browsers without a token may listen on channels named public:… (never publish).">
        <div className="flex items-center gap-2">
          <Switch id="rt-public" checked={publicChannels} onCheckedChange={setPublicChannels} />
          <Label htmlFor="rt-public">{publicChannels ? "On" : "Off"}</Label>
        </div>
      </Row>
      <Row title="Allowed origins" hint="Sites whose pages may connect, one per line. Empty allows any. Browsers enforce it; other clients can send any Origin.">
        <Textarea name="allowedOrigins" rows={3} defaultValue={settings.allowedOrigins.join("\n")} placeholder="https://shop.example.com" className="font-mono text-xs md:text-xs" aria-label="Allowed origins" />
      </Row>
      <Row title="Limits" hint="Keep these low on a small machine: every socket holds memory.">
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`rt-${key}`}>{LIMITS[key].label}</Label>
              <Input id={`rt-${key}`} name={key} type="number" min={LIMITS[key].min} max={LIMITS[key].max} defaultValue={settings[key]} required />
              <p className="text-xs text-muted-foreground">{LIMITS[key].hint}</p>
            </div>
          ))}
        </div>
      </Row>
      <Row title="Webhook" hint="mybase POSTs batches of what browsers did to this URL, signed with the secret. It doesn't wait for your answer to deliver messages.">
        <div className="grid gap-3">
          <Input name="webhookUrl" type="url" defaultValue={settings.webhookUrl ?? ""} placeholder="https://shop.example.com/api/realtime-webhook" aria-label="Webhook URL" />
          <fieldset className="grid gap-2">
            <legend className="sr-only">Events to send</legend>
            {REALTIME_WEBHOOK_EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={events.includes(ev)}
                  onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
                />
                {EVENT_LABELS[ev]}
              </label>
            ))}
          </fieldset>
        </div>
      </Row>
      <div className="flex flex-wrap items-center gap-3 border-t py-5">
        <Button type="submit" variant="outline">
          Save settings
        </Button>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function Realtime({ project }: { project: Project }) {
  const name = project.name;
  const { state, refresh } = useLoad(`realtime:${name}`, () => api.realtimeSettings(name));
  const [dialog, setDialog] = useState<"off" | "rotate" | null>(null);

  async function turnOff() {
    try {
      await api.disableService(name, "realtime");
      await refreshProjects();
      toast.success(`Turned off realtime for ${name}`);
      navigate({ page: "project", name });
    } catch (err) {
      toast.error(`Couldn't turn off realtime: ${errorMessage(err)}`);
    }
  }

  const apiUrl = state.status === "ready" ? state.data.publishUrl.replace(/\/realtime\/[^/]+\/publish$/, "") : "";

  return (
    <>
      <PageHeader
        title="Realtime"
        breadcrumb={{ label: name, href: href({ page: "project", name }) }}
        description="WebSocket channels for live updates, chat, and presence. Browsers connect here, so your app can run on a host that can't hold sockets."
      />
      {state.status === "loading" && <LoadingLines label="Loading realtime settings" lines={4} />}
      {state.status === "error" && <LoadError what="realtime settings" message={state.message} onRetry={() => void refresh()} />}
      {state.status === "ready" && (
        <>
          <Live name={name} />
          <section aria-labelledby="realtime-use" className="mb-10">
            <h2 id="realtime-use" className="mb-3 text-base font-semibold">
              Use it
            </h2>
            <Row title="Sign a token" hint="Your server decides what each browser may do. No call to mybase: it signs with MYBASE_REALTIME_SECRET.">
              {code(tokenSnippet(apiUrl, name))}
            </Row>
            <Row title="In the browser" hint="Reconnects and resubscribes by itself, and fetches a new token before the old one runs out.">
              {code(browserSnippet(apiUrl, name))}
            </Row>
            <Row title="Publish from your server" hint="With an API key that has realtime:write.">
              {code(serverSnippet(apiUrl, name))}
            </Row>
            <Row title="Hear from browsers" hint="Set a webhook below to get messages and presence changes on your server.">
              {code(webhookSnippet)}
            </Row>
          </section>
          <TryIt name={name} />
          <section aria-labelledby="realtime-settings" className="mb-10">
            <h2 id="realtime-settings" className="mb-3 text-base font-semibold">
              Settings
            </h2>
            <Row title="Secret" hint="Signs browser tokens and webhook calls. Server-side only.">
              <div className="grid gap-3">
                <CopyField id="realtime-secret" label="MYBASE_REALTIME_SECRET" value={state.data.secret} secret />
                <CopyField id="realtime-socket" label="Socket URL" value={state.data.socketUrl} />
                <div>
                  <Button variant="outline" size="sm" onClick={() => setDialog("rotate")}>
                    Rotate secret
                  </Button>
                </div>
              </div>
            </Row>
            <Settings key={JSON.stringify(state.data)} name={name} settings={state.data} onSaved={() => void refresh()} />
          </section>
        </>
      )}
      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-3 text-base font-semibold">
          Turn off realtime
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t py-5">
          <p className="max-w-prose text-muted-foreground">Closes every open connection. Pages listening for updates stop getting them.</p>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("off")}>
            Turn off realtime
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Rotate the realtime secret"
        description="Every open connection is closed, and tokens signed with the old secret stop working. Update MYBASE_REALTIME_SECRET wherever your server signs tokens; browsers using the SDK reconnect with a new token."
        confirm="Rotate secret"
        pendingLabel="Rotating…"
        onConfirm={async () => {
          await api.rotateRealtimeSecret(name);
          toast.success("Rotated the realtime secret");
          void refresh();
        }}
      />
      <ConfirmDialog
        open={dialog === "off"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Turn off realtime for ${name}`}
        description={SERVICE_PAGES.realtime.turnOff}
        confirm="Turn off realtime"
        pendingLabel="Turning off…"
        onConfirm={turnOff}
      />
    </>
  );
}

export function RealtimePage({ name }: { name: string }) {
  return (
    <ProjectGate name={name} title="Realtime" backToProject>
      {(project) => {
        if (!project.services.includes("realtime")) {
          return (
            <ServiceOff project={project} id="realtime">
              Turn it on to give your app live updates, chat, and presence over WebSockets, even when the app runs on a serverless host that can't hold a socket.
            </ServiceOff>
          );
        }
        return <Realtime project={project} />;
      }}
    </ProjectGate>
  );
}

// `mybase db proxy`: a local Postgres port that tunnels to the server's `/db` WebSocket (the same
// endpoint Neon's serverless driver uses, db-proxy.ts in the API). Lets `prisma migrate`, psql,
// and `mybase run` reach the database from anywhere the API is reachable, with the Postgres port
// closed to the internet. Each TCP connection gets its own WebSocket; the bytes are the plain
// Postgres protocol (TLS is the wss:// layer), so clients connect with `sslmode=disable`.
//
// The CLI token goes along as `Authorization`; Postgres still checks the project's password, and
// the server only lets a project role into its own database.
import type { Socket, TCPSocketListener } from "bun";
import { API_URL, apiToken, CLI_VERSION } from "./api";
import { flagInt, parseArgs } from "./cron";
import { CliError, jsonMode, print, usageError } from "./output";
import { expandShortFlags, target } from "./secrets";

export const dbUsage = `  db proxy [-p <project>] [--port 5432]  Postgres on 127.0.0.1:<port>, tunnelled over the API's
                                 WebSocket (wss://<api>/db): works with the Postgres port closed.
                                 Connect with ?sslmode=disable. \`mybase run\` starts one by itself`;

/** `https://x` → `wss://x/db`. */
export const proxyTarget = (apiUrl = API_URL) => `${apiUrl.replace(/^http/, "ws").replace(/\/$/, "")}/db`;

interface Conn {
  ws: WebSocket;
  open: boolean;
  /** Client bytes waiting for the WebSocket to open. */
  pending: Uint8Array[];
  /** Server bytes the TCP socket hasn't taken yet. */
  backlog: Uint8Array[];
}

/** Writes what the socket takes now; the rest waits for `drain`. */
function flush(socket: Socket<Conn>) {
  const c = socket.data;
  while (c.backlog.length) {
    const chunk = c.backlog[0]!;
    const n = socket.write(chunk);
    if (n < chunk.length) {
      c.backlog[0] = chunk.subarray(Math.max(n, 0));
      return;
    }
    c.backlog.shift();
  }
}

export interface DbProxy {
  port: number;
  stop(): void;
}

/** Starts the proxy on 127.0.0.1:`port` (0 = any free port). */
export async function startDbProxy(port: number, opts: { url?: string; token?: string | null; onError?: (message: string) => void } = {}): Promise<DbProxy> {
  const url = opts.url ?? proxyTarget();
  const token = opts.token === undefined ? apiToken() : opts.token;
  const headers: Record<string, string> = { "User-Agent": `mybase-cli/${CLI_VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let listener: TCPSocketListener<Conn>;
  try {
    listener = Bun.listen<Conn>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          // Bun's WebSocket takes headers (not in the DOM type).
          const ws = new WebSocket(url, { headers } as unknown as string[]);
          ws.binaryType = "arraybuffer";
          socket.data = { ws, open: false, pending: [], backlog: [] };
          ws.onopen = () => {
            socket.data.open = true;
            for (const chunk of socket.data.pending) ws.send(chunk);
            socket.data.pending = [];
          };
          ws.onmessage = (e) => {
            const chunk = typeof e.data === "string" ? new TextEncoder().encode(e.data) : new Uint8Array(e.data as ArrayBuffer);
            socket.data.backlog.push(chunk);
            flush(socket);
          };
          ws.onerror = () => opts.onError?.(`can't reach ${url}`);
          ws.onclose = () => socket.end();
        },
        data(socket, chunk) {
          const c = socket.data;
          // Copied: Bun reuses the buffer.
          if (c.open) c.ws.send(chunk.slice());
          else c.pending.push(chunk.slice());
        },
        drain(socket) {
          flush(socket);
        },
        close(socket) {
          socket.data?.ws.close();
        },
        error(socket) {
          socket.data?.ws.close();
        },
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new CliError(code === "EADDRINUSE" ? `port ${port} is in use (pass --port <another>)` : `can't listen on 127.0.0.1:${port}: ${(err as Error).message}`);
  }
  return { port: listener.port, stop: () => listener.stop(true) };
}

/** `mybase db <sub> …`. False when `sub` isn't a db command. */
export async function db(sub: string, args: string[]): Promise<boolean> {
  if (sub !== "proxy") return false;
  const { flags, positional } = parseArgs(expandShortFlags(args));
  if (positional.length) throw usageError(`unexpected ${positional[0]}\n\n${dbUsage}`);
  const { project } = await target(flags, false);
  const port = flagInt(flags, "port") ?? 5432;
  const proxy = await startDbProxy(port, { onError: (m) => console.error(`mybase db proxy: ${m}`) });
  const local = `postgres://${project}:<password>@127.0.0.1:${proxy.port}/${project}?sslmode=disable`;
  print({ project, port: proxy.port, target: proxyTarget(), url: local }, () => {
    console.log(`Postgres for "${project}" on 127.0.0.1:${proxy.port} → ${proxyTarget()}`);
    console.log(`  ${local}`);
    console.log("Ctrl-C to stop.");
  });
  if (jsonMode) console.error("listening; Ctrl-C to stop");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
  proxy.stop();
  return true;
}

import type { Subprocess } from "bun";

/** A CDP probe must fail on disconnect, not wait forever for a reply that can no longer arrive. */
export function probeBrowser(endpoint: string, headers: Record<string, string>, timeoutMs = 5000): Promise<string> {
  const WithHeaders = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new WithHeaders(endpoint, { headers });
  return new Promise((resolve, reject) => {
    let product: string | undefined;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(product!);
    };
    const timer = setTimeout(() => finish(new Error("CDP probe timed out waiting for browser version or disconnect")), timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })));
    socket.addEventListener("error", () => finish(new Error("CDP browser connection failed")));
    socket.addEventListener("close", () => finish(product ? undefined : new Error("CDP browser disconnected before answering Browser.getVersion")));
    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (typeof message.result?.product !== "string") throw new Error("CDP returned an invalid browser version");
        product = message.result.product;
        socket.close();
      } catch (err) { finish(err as Error); }
    });
  });
}

/** Preserve the original test failure even if a worker's graceful shutdown gets stuck. */
export async function stopTestWorker(child: Subprocess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), graceMs);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        // This deadline bounds even an abnormal failure to reap the killed worker.
        deadline = setTimeout(() => reject(new Error("sandbox test worker did not exit after SIGKILL")), graceMs + 2000);
      }),
    ]);
  } finally { clearTimeout(escalation); clearTimeout(deadline); }
}

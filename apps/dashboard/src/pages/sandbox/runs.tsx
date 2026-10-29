import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, Check, Circle, Play, Plus, RefreshCw, Square, Upload } from "lucide-react";
import { toast } from "sonner";
import type { Sandbox, SandboxArtifact, SandboxExecution, SandboxUsage } from "@mybase-dev/sdk/sandbox";
import { executionTerminal, sandboxPath, sandboxTerminal } from "@mybase/shared/sandbox";
import { LoadingLines } from "@/components/analytics-parts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { PageHeader } from "@/components/page-header";
import { Row } from "@/components/row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDate, formatDuration, timeAgo } from "@/lib/format";
import { errorMessage } from "@/lib/load";
import { href, navigate, type SandboxAction } from "@/lib/router";
import { cn } from "@/lib/utils";
import { routeFor, docLink, focus, codeClass, type SandboxRoute } from "./shared";

const selectClass = `h-9 rounded-md border bg-background px-3 text-sm ${focus}`;

/** One request at a time, no polling in hidden tabs, and no stale writes after navigation.
 * Keep the last result visible on a background failure so a running job doesn't disappear. */
function useSandboxPoll<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, keepPolling: (data: T) => boolean = () => true) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [pending, setPending] = useState(false);
  const latest = useRef({ fetcher, keepPolling });
  latest.current = { fetcher, keepPolling };
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let poll = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setState({});
    const load = async () => {
      if (disposed || busy) return;
      clearTimeout(timer);
      busy = true;
      setPending(true);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        const data = await latest.current.fetcher(signal);
        if (!disposed) {
          poll = latest.current.keepPolling(data);
          setState({ data });
        }
      } catch (err) {
        if (!disposed) setState((previous) => ({ ...previous, error: errorMessage(err) }));
      } finally {
        busy = false;
        if (!disposed) {
          setPending(false);
          if (poll && !document.hidden) timer = setTimeout(() => void load(), 3000);
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void load();
    };
    refreshRef.current = load;
    void load();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key]);
  return { ...state, pending, refresh: () => refreshRef.current() };
}

function Problem({ message, retry }: { message?: string; retry?: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
      <p className="text-destructive">{message}</p>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

const labels: Record<Sandbox["state"] | SandboxExecution["state"], string> = {
  queued: "Queued",
  provisioning: "Starting",
  ready: "Ready",
  stopping: "Stopping",
  terminated: "Terminated",
  expired: "Expired",
  failed: "Failed",
  running: "Running",
  success: "Succeeded",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

function State({ state }: { state: keyof typeof labels }) {
  const failed = state === "failed" || state === "timed_out";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {state === "success" ? (
        <Check className="size-3" />
      ) : (
        <Circle className={cn("size-2", ["ready", "running", "provisioning", "stopping"].includes(state) && "fill-current")} />
      )}
      {labels[state]}
    </span>
  );
}

function DateLabel({ date }: { date: string | null }) {
  return date ? (
    <time dateTime={date} title={formatDate(date)}>
      {timeAgo(date)}
    </time>
  ) : (
    <>–</>
  );
}

function UsageStat({ label, display }: { label: string; display: string }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap justify-between gap-2">
        <dt className="text-muted-foreground">{label}</dt>
        <dd>{display}</dd>
      </div>
    </div>
  );
}

function Usage({ usage }: { usage: SandboxUsage }) {
  return (
    <section aria-labelledby="sandbox-usage" className="mb-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sandbox-usage" className="text-base font-semibold">
          Usage today
        </h2>
        <p className="text-xs text-muted-foreground">
          UTC admission day · {usage.executionsToday} executions · {formatDuration(usage.runtimeMsToday)} runtime
        </p>
      </div>
      <dl className="grid gap-5 border-y py-4 sm:grid-cols-3">
        <UsageStat label="Active sandboxes" display={String(usage.active)} />
        <UsageStat label="Runtime today" display={formatDuration(usage.runtimeMsToday)} />
        <UsageStat label="Exported artifacts" display={formatBytes(usage.artifactBytesToday)} />
      </dl>
    </section>
  );
}

/** crypto.randomUUID isn't available on plain HTTP LAN origins. getRandomValues is. */
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.split("/").pop() || "download";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const SAMPLE = `import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const page = await browser.contexts()[0].newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
  await page.screenshot({ path: "page.png" });
  await page.close();
} finally {
  await browser.close();
}`;

function WorkDialog({
  action,
  route,
  onClose,
  onSaved,
}: {
  action: "create" | "execute" | "files" | "export";
  route: SandboxRoute;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState("code");
  const attempt = useRef({ input: "", key: newKey() });
  const titles = { create: "Create sandbox", execute: "Run code", files: "Workspace files", export: "Export artifact" };
  const hints = {
    create: "An isolated Node.js and Chromium workspace. Optional lifetime starts now, including startup time.",
    execute:
      "Runs in /workspace. Playwright is installed. Commands are argument arrays without an implicit shell. Cancellation or timeout destroys the entire sandbox.",
    files: "Upload or download a known relative path. Files are temporary; export them to keep them after the sandbox stops. Transfer size is configured by the host owner.",
    export: "Copy a workspace file into private storage for seven days. Transfer size is configured by the host owner.",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    const form = new FormData(e.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    setPending(true);
    try {
      let id: string | undefined;
      if (action === "create" || action === "execute") {
        const input =
          action === "create"
            ? { profile: "browser" as const, ttlSeconds: text("ttl") ? Number(text("ttl")) : null, idleSeconds: text("idle") ? Number(text("idle")) : null }
            : {
                timeoutMs: text("timeout") ? Number(text("timeout")) : null,
                ...(mode === "code" ? { code: String(form.get("code")) } : { command: JSON.parse(text("command")) as string[] }),
              };
        if ("command" in input && (!Array.isArray(input.command) || !input.command.every((v) => typeof v === "string")))
          throw new Error('Command must be a JSON array of strings, e.g. ["node","script.js"].');
        const fingerprint = JSON.stringify(input);
        if (attempt.current.input !== fingerprint) attempt.current = { input: fingerprint, key: newKey() };
        const request = { ...input, key: attempt.current.key };
        if (action === "create") id = (await api.createSandbox(route.name, request)).id;
        else id = (await api.executeSandbox(route.name, route.sandbox!, request)).id;
      } else {
        const path = sandboxPath(text("path"));
        if (action === "export") await api.exportSandboxArtifact(route.name, route.sandbox!, path, text("type") || undefined);
        else if (mode === "download") saveBlob(await api.downloadSandboxFile(route.name, route.sandbox!, path), path);
        else {
          const file = form.get("file") as File;
          if (!file || !file.name) throw new Error("Choose a file to upload.");
          await api.uploadSandboxFile(route.name, route.sandbox!, path, file);
        }
      }
      toast.success(
        action === "create"
          ? "Sandbox queued"
          : action === "execute"
            ? "Execution queued"
            : action === "export"
              ? "Exported artifact"
              : mode === "download"
                ? "Downloaded file"
                : "Uploaded file",
      );
      onSaved(id);
    } catch (err) {
      setError(err instanceof SyntaxError ? "Command must be a valid JSON argument array." : err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader className="text-left">
            <DialogTitle>{titles[action]}</DialogTitle>
            <DialogDescription>{hints[action]}</DialogDescription>
          </DialogHeader>
          {action === "create" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Lifetime (seconds)" id="ttl">
                <Input id="ttl" name="ttl" type="number" min={1} placeholder="No expiry" autoFocus />
                <p className="text-xs text-muted-foreground">Optional. Leave blank for no lifetime deadline.</p>
              </Field>
              <Field label="Idle timeout (seconds)" id="idle">
                <Input id="idle" name="idle" type="number" min={1} placeholder="No idle timeout" />
                <p className="text-xs text-muted-foreground">Optional. Inspections do not reset an idle timeout.</p>
              </Field>
            </div>
          )}
          {action === "create" && (
            <p className="text-muted-foreground">Browser profile · Resource controls configured by the host owner. No daily or sandbox-count quotas.</p>
          )}
          {action === "execute" && (
            <>
              <Field label="Run" id="run-mode">
                <select id="run-mode" className={selectClass} value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="code">JavaScript (ESM)</option>
                  <option value="command">Command (JSON argument array)</option>
                </select>
              </Field>
              {mode === "code" ? (
                <Field label="JavaScript" id="code">
                  <Textarea
                    id="code"
                    name="code"
                    rows={14}
                    required
                    maxLength={65536}
                    spellCheck={false}
                    autoFocus
                    defaultValue={SAMPLE}
                    className="font-mono text-xs md:text-xs"
                  />
                </Field>
              ) : (
                <Field label="Arguments" id="command">
                  <Textarea
                    id="command"
                    name="command"
                    required
                    spellCheck={false}
                    defaultValue={'["node", "--version"]'}
                    className="font-mono text-xs md:text-xs"
                  />
                </Field>
              )}
              <Field label="Timeout (milliseconds)" id="timeout">
                <Input id="timeout" name="timeout" type="number" min={1} placeholder="No timeout" className="max-w-40" />
                <p className="text-xs text-muted-foreground">Optional. Leave blank to run until completion or cancellation.</p>
              </Field>
            </>
          )}
          {(action === "files" || action === "export") && (
            <>
              {action === "files" && (
                <Field label="Transfer" id="file-mode">
                  <select id="file-mode" className={selectClass} value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="code">Upload file</option>
                    <option value="download">Download file</option>
                  </select>
                </Field>
              )}
              <Field label="Workspace path" id="path">
                <Input
                  id="path"
                  name="path"
                  placeholder={action === "export" ? "page.png" : "data/input.json"}
                  required
                  autoFocus
                  spellCheck={false}
                  maxLength={240}
                  className="font-mono text-xs md:text-xs"
                />
              </Field>
              {action === "files" && mode !== "download" && (
                <Field label="Local file" id="file">
                  <Input id="file" name="file" type="file" required />
                </Field>
              )}
              {action === "export" && (
                <Field label="MIME type (optional)" id="type">
                  <Input id="type" name="type" placeholder="image/png" className="font-mono text-xs md:text-xs" />
                </Field>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Working…" : action === "files" ? (mode === "download" ? "Download file" : "Upload file") : titles[action]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Lifecycle({ box }: { box: Sandbox }) {
  const terminal = sandboxTerminal(box.state);
  const current = terminal ? 3 : box.state === "stopping" ? 3 : box.state === "ready" ? 2 : box.state === "provisioning" ? 1 : 0;
  const steps = ["Queued", "Starting", "Ready", terminal ? labels[box.state] : box.state === "stopping" ? "Stopping" : "Stopped"];
  return (
    <ol aria-label="Sandbox lifecycle" className="my-6 grid grid-cols-4 gap-2">
      {steps.map((label, i) => {
        // A failed provision never reached Ready; don't invent successful transitions.
        const reached =
          i === 0 ||
          i === current ||
          (i === 1 && (box.startedAt !== null || box.state === "provisioning" || box.state === "ready")) ||
          (i === 2 && box.startedAt !== null);
        return (
          <li
            key={i}
            aria-current={i === current ? "step" : undefined}
            className={cn(
              "border-t-2 pt-2 text-xs sm:text-sm",
              reached ? "border-muted-foreground text-foreground" : "text-muted-foreground",
              i === current && box.state === "failed" && "border-destructive text-destructive",
            )}
          >
            <span className="flex items-center gap-1.5">
              {reached && i !== current ? <Check className="size-3" /> : <Circle className={cn("size-2", i === current && "fill-current")} />}
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Artifacts({ artifacts, name, sandbox }: { artifacts: SandboxArtifact[]; name: string; sandbox: string }) {
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState<string>();
  async function download(artifact: SandboxArtifact) {
    setError(undefined);
    setDownloading(artifact.id);
    try {
      saveBlob(await api.downloadSandboxArtifact(name, sandbox, artifact.id), artifact.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDownloading(undefined);
    }
  }
  return (
    <>
      <Problem message={error} />
      {artifacts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5 text-muted-foreground">
          No exported artifacts. Export screenshots, JSON, or other workspace files before the sandbox stops to keep them for seven days.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>
                <span className="sr-only">Download</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => (
              <TableRow key={artifact.id}>
                <TableCell className="max-w-64 whitespace-normal">
                  <span className="break-all font-mono text-xs">{artifact.name}</span>
                  <span className="block text-xs text-muted-foreground">{artifact.type}</span>
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className={cn("w-fit cursor-pointer rounded-sm", focus)}>SHA-256</summary>
                    <code className="mt-1 block break-all">{artifact.sha256}</code>
                  </details>
                </TableCell>
                <TableCell>{formatBytes(artifact.size)}</TableCell>
                <TableCell>
                  <DateLabel date={artifact.expiresAt} />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" disabled={!!downloading} onClick={() => void download(artifact)} aria-label={`Download ${artifact.name}`}>
                    <ArrowDownToLine />
                    {downloading === artifact.id ? "Downloading…" : "Download"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function Executions({ runs, route, onAction }: { runs: SandboxExecution[]; route: SandboxRoute; onAction: (action: SandboxAction) => void }) {
  const selected = route.execution ? runs.find((run) => run.id === route.execution) : (runs.find((run) => !executionTerminal(run.state)) ?? runs.at(-1));
  return (
    <>
      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5">
          <p className="font-medium">No executions yet</p>
          <p className="mt-1 text-muted-foreground">
            Run JavaScript or a command here, or submit work through the SDK. Sequential executions share this workspace and browser state.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Execution</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Exit code</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run, i) => (
              <TableRow key={run.id} className={cn(selected?.id === run.id && "bg-accent/50")}>
                <TableCell>
                  <a
                    href={href({ ...route, action: undefined, execution: run.id })}
                    aria-current={selected?.id === run.id ? "true" : undefined}
                    className={cn("rounded-sm hover:underline", focus)}
                  >
                    Execution {i + 1}
                    <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
                  </a>
                </TableCell>
                <TableCell>
                  <State state={run.state} />
                </TableCell>
                <TableCell>
                  <DateLabel date={run.startedAt} />
                </TableCell>
                <TableCell>{run.startedAt ? formatDuration(Math.max(0, +new Date(run.finishedAt ?? Date.now()) - +new Date(run.startedAt))) : "–"}</TableCell>
                <TableCell>{run.exitCode ?? "–"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {route.execution && !selected && <Problem message="Execution not found in this sandbox. Select one from the list." />}
      {selected && (
        <section aria-labelledby="execution-output" className="mt-5 rounded-lg border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 id="execution-output" className="font-medium">
              Execution output
            </h3>
            {!executionTerminal(selected.state) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (route.execution !== selected.id) navigate({ ...route, execution: selected.id, action: "cancel" });
                  else onAction("cancel");
                }}
              >
                <Square />
                Cancel execution
              </Button>
            )}
          </div>
          <p className="mb-3 break-all font-mono text-xs text-muted-foreground">{selected.id}</p>
          {!executionTerminal(selected.state) && (
            <p className="mb-3 text-muted-foreground">Output is collected when the execution finishes; it is not streamed live.</p>
          )}
          {selected.truncated && (
            <p role="status" className="mb-3 text-destructive">
              Output truncated at the host-configured stream limit. Export large results as files.
            </p>
          )}
          {(["stdout", "stderr"] as const).map((stream) => (
            <div key={stream} className="mt-3">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">{stream}</h4>
              <pre tabIndex={0} aria-label={stream} className={cn(codeClass, "max-h-80", focus)}>
                {selected[stream] || (executionTerminal(selected.state) ? "No output" : "Waiting for completion…")}
              </pre>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export function SandboxDetail({ route }: { route: SandboxRoute }) {
  const { name, sandbox: id } = route;
  const previous = useRef<{ box: Sandbox; runs: SandboxExecution[] } | null>(null);
  const detail = useSandboxPoll(
    `sandbox:${name}:${id}`,
    async (signal) => {
      const box = await api.sandbox(name, id!, signal);
      const cached = previous.current;
      // Histories can contain many large output streams. Reuse completed results and
      // poll only active executions until a new admission changes the count.
      const [runs, artifacts] = await Promise.all([
        !cached || cached.box.executions !== box.executions
          ? api.sandboxExecutions(name, id!, signal)
          : Promise.all(cached.runs.map((run) => (executionTerminal(run.state) ? run : api.sandboxExecution(name, id!, run.id, signal)))),
        api.sandboxArtifacts(name, id!, signal),
      ]);
      previous.current = { box, runs };
      return { box, runs, artifacts };
    },
    (data) => !sandboxTerminal(data.box.state) || data.runs.some((run) => !executionTerminal(run.state)),
  );
  const [error, setError] = useState<string>();
  const action = (value?: SandboxAction) => navigate({ ...route, action: value }, { replace: true });
  const box = detail.data?.box;
  const busy = detail.data?.runs.some((run) => !executionTerminal(run.state)) ?? false;
  const ready = box?.state === "ready" && !busy && (box.expiresAt === null || +new Date(box.expiresAt) > Date.now());
  const terminal = box ? sandboxTerminal(box.state) : false;
  const selected = route.execution
    ? detail.data?.runs.find((run) => run.id === route.execution)
    : detail.data?.runs.find((run) => !executionTerminal(run.state));
  async function stop(cancel: boolean) {
    try {
      if (cancel) {
        if (!selected) {
          setError("Select an execution from this sandbox before cancelling.");
          return;
        }
        await api.cancelSandboxExecution(name, id!, selected.id);
      } else await api.terminateSandbox(name, id!);
      toast.success(cancel ? "Execution cancellation requested" : "Sandbox termination requested");
      await detail.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <PageHeader
        title={`Sandbox ${id!.slice(0, 8)}`}
        breadcrumb={{ label: `${name} / Agent sandboxes`, href: href(routeFor(name)) }}
        description="Temporary browser workspace and its execution history."
        action={
          <Button disabled={!ready} onClick={() => action("execute")}>
            <Play />
            Run code
          </Button>
        }
      />
      <Problem message={detail.error} retry={() => void detail.refresh()} />
      <Problem message={error} />
      {!box && !detail.error && <LoadingLines label="Loading sandbox" />}
      {box && detail.data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <State state={box.state} />
              <span className="text-muted-foreground">
                Created <DateLabel date={box.createdAt} />
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={detail.pending} onClick={() => void detail.refresh()}>
                <RefreshCw />
                Refresh
              </Button>
              {!terminal && (
                <Button variant="outline" size="sm" disabled={box.state === "stopping"} onClick={() => action("terminate")}>
                  <Square />
                  Terminate
                </Button>
              )}
            </div>
          </div>
          <Lifecycle box={box} />
          {box.reason && (
            <p className={cn("mb-5 rounded-md border p-3", box.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
              Reason: <code className="break-all font-mono text-xs">{box.reason}</code>
            </p>
          )}
          <dl className="mb-8 grid grid-cols-2 gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-4">
            {[
              ["Runtime", formatDuration(box.runtimeMs)],
              [
                terminal ? "Finished" : "Lifetime remaining",
                terminal ? <DateLabel date={box.finishedAt} /> : box.expiresAt === null ? "No expiry" : formatDuration(Math.max(0, +new Date(box.expiresAt) - Date.now())),
              ],
              ["Executions", String(box.executions)],
              ["Artifacts", formatBytes(box.artifactBytes)],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="mb-1 text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="sandbox-executions" className="mb-8">
            <h2 id="sandbox-executions" className="mb-3 text-base font-semibold">
              Executions
            </h2>
            <Executions runs={detail.data.runs} route={route} onAction={action} />
          </section>
          <section aria-labelledby="sandbox-artifacts" className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="sandbox-artifacts" className="text-base font-semibold">
                Artifacts
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={!ready} onClick={() => action("files")}>
                  <Upload />
                  Workspace files
                </Button>
                <Button variant="outline" size="sm" disabled={!ready} onClick={() => action("export")}>
                  <ArrowDownToLine />
                  Export artifact
                </Button>
              </div>
            </div>
            <Artifacts artifacts={detail.data.artifacts} name={name} sandbox={id!} />
          </section>
          <section aria-labelledby="sandbox-resources" className="mb-8">
            <h2 id="sandbox-resources" className="mb-3 text-base font-semibold">
              Workspace
            </h2>
            <Row title="Sandbox ID" hint="Use this ID with the SDK or CLI.">
              <CopyField id="sandbox-id" label="ID" value={box.id} />
            </Row>
            <Row title="Browser profile" hint="Host-configured resource controls, not measured utilization.">
              {box.resources.cpus} CPU · {box.resources.memoryMb} MiB RAM · {box.resources.workspaceMb} MiB workspace · {box.resources.pids} processes
            </Row>
            <Row title="Lifetime deadline" hint="Idle timeout can stop the guest earlier. Looking at this page does not keep it alive.">
              {box.expiresAt ? <time dateTime={box.expiresAt}>{formatDate(box.expiresAt)}</time> : "No expiry"}
            </Row>
            <Row title="Browser automation" hint="Chromium runs inside the sandbox. External Playwright connects through authenticated CDP.">
              <a href={docLink("sandboxes", true)} className={cn("rounded-sm underline underline-offset-4", focus)}>
                Browser connection guide
              </a>
            </Row>
          </section>
        </>
      )}
      {box && (route.action === "execute" || route.action === "files" || route.action === "export") && (
        <WorkDialog
          key={route.action}
          action={route.action}
          route={route}
          onClose={() => action()}
          onSaved={(execution) => {
            navigate({ ...route, action: undefined, execution: execution ?? route.execution }, { replace: true });
            void detail.refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={route.action === "terminate" || route.action === "cancel"}
        onOpenChange={(open) => !open && action()}
        title={route.action === "cancel" ? "Cancel execution and stop sandbox" : "Terminate sandbox"}
        description="Destroys the entire guest, browser, process tree, and temporary workspace. Exported artifacts and execution history remain for seven days. This cannot be undone."
        confirm={route.action === "cancel" ? "Cancel execution" : "Terminate sandbox"}
        pendingLabel="Requesting stop…"
        onConfirm={() => stop(route.action === "cancel")}
      />
    </>
  );
}

export function SandboxList({ route }: { route: SandboxRoute }) {
  const data = useSandboxPoll(`sandboxes:${route.name}`, async (signal) => {
    const [boxes, usage] = await Promise.all([api.sandboxes(route.name, signal), api.sandboxUsage(route.name, signal)]);
    return { boxes, usage };
  });
  const query = route.query.trim().toLowerCase();
  const shown = data.data?.boxes.filter((box) => `${box.id} ${box.state} ${labels[box.state]} ${box.reason ?? ""}`.toLowerCase().includes(query)) ?? [];
  return (
    <>
      <Problem message={data.error} retry={() => void data.refresh()} />
      {!data.data && !data.error && <LoadingLines label="Loading sandboxes and usage" />}
      {data.data && (
        <>
          <Usage usage={data.data.usage} />
          <section aria-labelledby="sandbox-runs" className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="sandbox-runs" className="text-base font-semibold">
                Sandboxes
              </h2>
              <Button variant="ghost" size="sm" disabled={data.pending} onClick={() => void data.refresh()}>
                <RefreshCw />
                Refresh
              </Button>
            </div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Input
                aria-label="Filter sandboxes"
                placeholder="Filter by ID, state, or reason"
                className="max-w-sm"
                value={route.query}
                onChange={(e) => navigate({ ...route, query: e.target.value }, { replace: true })}
              />
              <p className="text-xs text-muted-foreground">Refreshes every 3s while visible · latest 100 · seven-day history</p>
            </div>
            {data.data.boxes.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5">
                <p className="font-medium">No sandboxes yet</p>
                <p className="mt-1 max-w-prose text-muted-foreground">
                  Create a temporary workspace to run agent code or browse with Chromium. Runs from your SDK and CLI appear here too. Open a sandbox to inspect
                  executions, output, and artifacts.
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate({ ...route, action: "create" }, { replace: true })}>
                  <Plus />
                  Create sandbox
                </Button>
              </div>
            ) : shown.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-muted-foreground">
                No sandboxes match this filter. Try an ID, status, or terminal reason.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sandbox</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead className="text-right">Executions</TableHead>
                    <TableHead className="text-right">Artifacts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((box) => (
                    <TableRow key={box.id}>
                      <TableCell>
                        <a href={href(routeFor(route.name, box.id))} className={cn("rounded-sm font-mono text-xs hover:underline", focus)} title={box.id}>
                          {box.id.slice(0, 8)}
                        </a>
                        <span className="block text-xs text-muted-foreground">Node.js + Chromium</span>
                      </TableCell>
                      <TableCell>
                        <State state={box.state} />
                        {box.reason && (
                          <span className="mt-1 block max-w-48 truncate text-xs text-muted-foreground" title={box.reason}>
                            {box.reason}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <DateLabel date={box.createdAt} />
                      </TableCell>
                      <TableCell>{formatDuration(box.runtimeMs)}</TableCell>
                      <TableCell className="text-right">{box.executions}</TableCell>
                      <TableCell className="text-right">{formatBytes(box.artifactBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
      {route.action === "create" && (
        <WorkDialog
          action="create"
          route={route}
          onClose={() => navigate({ ...route, action: undefined }, { replace: true })}
          onSaved={(id) => {
            navigate({ ...route, action: undefined }, { replace: true });
            navigate(routeFor(route.name, id!));
          }}
        />
      )}
    </>
  );
}

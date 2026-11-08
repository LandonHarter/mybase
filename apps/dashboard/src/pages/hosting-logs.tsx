import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Download, Eraser, RefreshCw } from "lucide-react";
import type { HostingDeploy } from "@mybase/shared";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { hostingLogsUrl } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { errorMessage } from "@/lib/load";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Lines kept in the browser; older ones drop off the top. */
const MAX_LINES = 10_000;
const TAILS = [100, 500, 1000, 5000] as const;

type Level = "error" | "warn" | "info" | "mybase";
type Line = { id: number; time: string | null; text: string; level: Level };
type LevelFilter = "all" | "warn" | "error";
type Status = "connecting" | "live" | "done" | "ended" | "error";

// `docker logs --timestamps` puts an RFC 3339 time (nanoseconds) before every line.
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;
// Color and cursor codes (Next.js and most CLIs print them).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR = /\b(error|errors?:|fatal|panic|exception|uncaught|unhandled|ERR!)\b|"level":\s*"(error|fatal)"|\blevel=(error|fatal)\b/i;
const WARN = /\b(warn|warning)\b|"level":\s*"warn(ing)?"|\blevel=warn/i;

let nextId = 0;

function parseLine(raw: string): Line {
  const clean = raw.replace(ANSI, "").replace(/\r$/, "");
  const m = TIMESTAMP.exec(clean);
  const text = m ? clean.slice(m[0].length) : clean;
  const level: Level = text.startsWith("[mybase]") ? "mybase" : ERROR.test(text) ? "error" : WARN.test(text) ? "warn" : "info";
  return { id: nextId++, time: m?.[1] ?? null, text, level };
}

const mybaseLine = (text: string): Line => ({ id: nextId++, time: new Date().toISOString(), text: `[mybase] ${text}`, level: "mybase" });

// Date parsing is only reliable to milliseconds.
const toDate = (iso: string) => new Date(iso.replace(/(\.\d{3})\d+/, "$1"));
const clock = (iso: string) => {
  const d = toDate(iso);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(
      <mark key={i} className="rounded-sm bg-primary/25 text-foreground">
        {text.slice(i, i + query.length)}
      </mark>,
    );
    at = i + query.length;
  }
  parts.push(text.slice(at));
  return parts;
}

const LEVEL_STYLE: Record<Level, string> = {
  error: "text-destructive",
  warn: "text-foreground font-medium",
  info: "",
  mybase: "text-muted-foreground italic",
};

const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting…",
  live: "Live",
  done: "Snapshot",
  ended: "Stream ended",
  error: "Disconnected",
};

/**
 * Full-page container output for one site: follows the live deploy (and the next one after a
 * redeploy) or shows any earlier deploy that still has its container.
 */
export function SiteLogs({
  project,
  site,
  liveDeploy,
  deploys,
  deploy: picked,
  onStreamEnd,
}: {
  project: string;
  site: string;
  liveDeploy: string | null;
  deploys: HostingDeploy[];
  /** From the URL; null follows whichever deploy is live. */
  deploy: string | null;
  /** Called when a followed stream closes, so the page can check for a new live deploy. */
  onStreamEnd: () => void;
}) {
  const target = picked ?? liveDeploy;
  const [follow, setFollow] = useState(true);
  const [tail, setTail] = useState<(typeof TAILS)[number]>(500);
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [timestamps, setTimestamps] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onEnd = useRef(onStreamEnd);
  onEnd.current = onStreamEnd;

  const shown = useRef<{ target: string | null; picked: string | null }>({ target: null, picked: null });

  useEffect(() => {
    // Following the live deploy across a redeploy keeps the old lines and marks the switch;
    // anything else (another deploy, tail, reconnect) starts over, since the tail comes again.
    const prev = shown.current;
    shown.current = { target, picked };
    if (prev.target && target && prev.target !== target && !picked && !prev.picked) {
      setLines((l) => [...l, mybaseLine(`deploy ${target.slice(0, 8)} is live now`)].slice(-MAX_LINES));
    } else {
      setLines([]);
      setUnseen(0);
    }
    if (!target) return;
    const controller = new AbortController();
    setStatus("connecting");
    setError(null);
    // Batch chunks into one render per frame: a chatty app can send hundreds of lines a second.
    let pending: Line[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      setLines((l) => (l.length + batch.length > MAX_LINES ? [...l, ...batch].slice(-MAX_LINES) : [...l, ...batch]));
      if (!stick.current) setUnseen((n) => n + batch.length);
    };
    const push = (line: Line) => {
      pending.push(line);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    void (async () => {
      let partial = "";
      try {
        const res = await fetch(hostingLogsUrl(project, site, target, follow, tail), { signal: controller.signal });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
        setStatus(follow ? "live" : "done");
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const parts = (partial + decoder.decode(chunk, { stream: true })).split("\n");
          partial = parts.pop() ?? "";
          for (const raw of parts) if (raw) push(parseLine(raw));
        }
        if (partial) push(parseLine(partial));
        cancelAnimationFrame(frame);
        flush();
        if (follow) {
          setStatus("ended");
          onEnd.current();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        cancelAnimationFrame(frame);
        flush();
        setStatus("error");
        setError(err instanceof Error && !(err instanceof TypeError) ? err.message : errorMessage(err));
      }
    })();
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [project, site, target, follow, tail, attempt]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      lines.filter((l) => {
        if (levelFilter === "error" && l.level !== "error") return false;
        if (levelFilter === "warn" && l.level !== "error" && l.level !== "warn") return false;
        return !q || l.text.toLowerCase().includes(q);
      }),
    [lines, levelFilter, q],
  );
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const l of lines) {
      if (l.level === "error") errors++;
      else if (l.level === "warn") warnings++;
    }
    return { errors, warnings };
  }, [lines]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible, timestamps, wrap]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (stick.current) setUnseen(0);
  };
  const jump = () => {
    const el = box.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setUnseen(0);
  };

  const download = () => {
    const text = lines.map((l) => (l.time ? `${l.time} ${l.text}` : l.text)).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${site}-${(target ?? "logs").slice(0, 8)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pickDeploy = (id: string) => navigate({ page: "hosting", name: project, site, tab: "logs", deploy: id || null }, { replace: true });
  const pickedDeploy = deploys.find((d) => d.id === target);

  if (!target) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
        Nothing is live yet, so there's no output to show. Deploy with mybase deploy and the container's output streams in here.
      </p>
    );
  }

  return (
    <section aria-label="Logs">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={picked ?? ""} onChange={(e) => pickDeploy(e.target.value)} aria-label="Deploy" className={"max-w-full min-w-0"}>
          <option value="">{liveDeploy ? `Live deploy (${liveDeploy.slice(0, 8)})` : "Live deploy"}</option>
          {deploys
            .filter((d) => d.id !== liveDeploy || picked === d.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.id.slice(0, 8)} · {d.status} · {timeAgo(d.createdAt)}
              </option>
            ))}
        </Select>
        <Select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LevelFilter)} aria-label="Level">
          <option value="all">All lines</option>
          <option value="warn">Warnings and errors ({counts.warnings + counts.errors})</option>
          <option value="error">Errors ({counts.errors})</option>
        </Select>
        <Select value={tail} onChange={(e) => setTail(Number(e.target.value) as (typeof TAILS)[number])} aria-label="Earlier lines to load">
          {TAILS.map((t) => (
            <option key={t} value={t}>
              Last {t.toLocaleString()} lines
            </option>
          ))}
        </Select>
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter lines" aria-label="Filter lines" className="w-auto min-w-48 flex-1" />
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-2" role="status">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              status === "live" ? "animate-pulse bg-primary" : status === "error" ? "bg-destructive" : "bg-muted-foreground/50",
            )}
          />
          <span className={cn(status === "error" ? "text-destructive" : "text-muted-foreground")}>
            {STATUS_LABEL[status]}
            {pickedDeploy && pickedDeploy.id !== liveDeploy && ` · deploy ${pickedDeploy.id.slice(0, 8)} (${pickedDeploy.status})`}
          </span>
          {(status === "ended" || status === "error") && (
            <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw />
              Reconnect
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground">
          <label className="flex items-center gap-2">
            <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow new output" />
            Live
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={timestamps} onCheckedChange={setTimestamps} aria-label="Show timestamps" />
            Timestamps
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={wrap} onCheckedChange={setWrap} aria-label="Wrap long lines" />
            Wrap
          </label>
          <Button variant="outline" size="sm" onClick={() => setLines([])} disabled={!lines.length}>
            <Eraser />
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={download} disabled={!lines.length}>
            <Download />
            Download
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-destructive">
          {error}
        </p>
      )}
      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label={`Output of ${site}`}
          className="h-[min(70vh,48rem)] min-h-80 overflow-auto rounded-md border bg-accent/40 py-2 font-mono text-xs leading-5"
        >
          {visible.length === 0 ? (
            <p className="px-3 text-muted-foreground">
              {status === "connecting" ? "Connecting…" : lines.length ? "No lines match the filter." : follow ? "No output yet. New lines show up here as the site prints them." : "No output."}
            </p>
          ) : (
            visible.map((l) => (
              <div key={l.id} className={cn("flex gap-3 px-3 hover:bg-accent", l.level === "error" && "bg-destructive/5")}>
                {timestamps && (
                  <time dateTime={l.time ?? undefined} title={l.time ? toDate(l.time).toLocaleString() : undefined} className="shrink-0 text-muted-foreground select-none">
                    {l.time ? clock(l.time) : "".padEnd(12, " ")}
                  </time>
                )}
                <span className={cn("min-w-0", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre", LEVEL_STYLE[l.level])}>{highlight(l.text, q)}</span>
              </div>
            ))
          )}
        </div>
        {unseen > 0 && (
          <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md" onClick={jump}>
            <ArrowDown />
            {unseen.toLocaleString()} new line{unseen === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {visible.length === lines.length ? `${lines.length.toLocaleString()} lines` : `${visible.length.toLocaleString()} of ${lines.length.toLocaleString()} lines`}
        {lines.length >= MAX_LINES && ` (only the newest ${MAX_LINES.toLocaleString()} are kept)`}. Stdout and stderr, as the container printed them.
      </p>
    </section>
  );
}

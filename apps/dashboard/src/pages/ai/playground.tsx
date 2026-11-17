import { useRef, useState, type FormEvent } from "react";
import { Send, Square, Trash2 } from "lucide-react";
import type { ChatUsage } from "@mybase-dev/sdk/ai";
import { SegmentedControl } from "@/components/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { errorMessage, useLoad } from "@/lib/load";
import { usd } from "./parts";

type Mode = "chat" | "embeddings" | "image";
interface Turn {
  role: "user" | "assistant";
  content: string;
}
interface Result {
  model: string | null;
  usage: { input: number; output: number; cached: number } | null;
  cost: number | null;
  ms: number;
}

/** Reads an OpenAI-format SSE stream from the dashboard's playground route. */
async function streamChat(
  project: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onText: (t: string) => void,
): Promise<{ usage: ChatUsage | null; model: string | null }> {
  const res = await fetch(`/projects/${project}/ai/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string | { message?: string } } | null;
    throw new Error((typeof data?.error === "string" ? data.error : data?.error?.message) ?? `The gateway answered ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let usage: ChatUsage | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: ChatUsage; error?: { message?: string } };
      if (chunk.error) throw new Error(chunk.error.message ?? "The stream failed");
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) onText(text);
      if (chunk.usage) usage = chunk.usage;
    }
  }
  return { usage, model: res.headers.get("X-Mybase-Model") };
}

export function AiPlayground({ project }: { project: string }) {
  const [mode, setMode] = useState<Mode>("chat");
  const models = useLoad(`ai-models:${project}:configured`, () => api.aiModels(project));
  const aliases = useLoad(`ai-aliases:${project}`, () => api.aiAliases(project));
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [output, setOutput] = useState<{ kind: "vector"; dims: number; head: number[] } | { kind: "image"; src: string; key?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const type = mode === "chat" ? "chat" : mode === "embeddings" ? "embedding" : "image";
  const options = [
    ...(mode === "chat" ? (aliases.data ?? []).map((a) => ({ id: a.name, label: `${a.name} (alias)` })) : []),
    ...(models.data ?? []).filter((m) => m.type === type).map((m) => ({ id: m.id, label: m.id })),
  ];

  async function run(e: FormEvent) {
    e.preventDefault();
    const chosen = model.trim() || options[0]?.id;
    if (!chosen || !input.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const start = performance.now();
    try {
      if (mode === "chat") {
        const history: Turn[] = [...turns, { role: "user", content: input.trim() }];
        setTurns([...history, { role: "assistant", content: "" }]);
        setInput("");
        abort.current = new AbortController();
        const messages = [...(system.trim() ? [{ role: "system", content: system.trim() }] : []), ...history];
        const { usage, model: answered } = await streamChat(project, { model: chosen, messages, mybase: { tags: ["playground"] } }, abort.current.signal, (t) =>
          setTurns((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, content: x.content + t } : x))),
        );
        // The stream has no cost header: the call's log row has it.
        const logs = await api.aiLogs(project, { tag: "playground", limit: 1 }).catch(() => null);
        setResult({
          model: answered,
          usage: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens, cached: usage.prompt_tokens_details?.cached_tokens ?? 0 } : null,
          cost: logs?.logs[0]?.costUsd ?? null,
          ms: performance.now() - start,
        });
      } else if (mode === "embeddings") {
        const res = await api.aiEmbed(project, { model: chosen, input: input.trim(), mybase: { tags: ["playground"] } });
        const v = res.data[0]?.embedding ?? [];
        setOutput({ kind: "vector", dims: v.length, head: v.slice(0, 8) });
        setResult({ model: chosen, usage: res.usage ? { input: res.usage.prompt_tokens, output: 0, cached: 0 } : null, cost: null, ms: performance.now() - start });
      } else {
        const res = await api.aiImage(project, { model: chosen, prompt: input.trim(), n: 1, mybase: { tags: ["playground"] } });
        const img = res.data[0];
        if (img?.b64_json) setOutput({ kind: "image", src: `data:image/png;base64,${img.b64_json}` });
        else if (img?.url) setOutput({ kind: "image", src: img.url });
        setResult({ model: chosen, usage: null, cost: null, ms: performance.now() - start });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  const noModels = models.state.status === "ready" && options.length === 0;

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl
          label="Mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setOutput(null);
            setResult(null);
            setModel("");
          }}
          options={[
            { value: "chat", label: "Chat" },
            { value: "embeddings", label: "Embeddings" },
            { value: "image", label: "Image" },
          ]}
        />
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label htmlFor="pg-model">Model</Label>
          <Input
            id="pg-model"
            list="pg-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={options[0]?.id ?? "openai/gpt-5-mini"}
            className="font-mono"
          />
          <datalist id="pg-models">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </datalist>
        </div>
        {mode === "chat" && turns.length > 0 && (
          <Button variant="ghost" onClick={() => (setTurns([]), setResult(null))}>
            <Trash2 />
            Clear
          </Button>
        )}
      </div>
      {noModels && <p className="text-muted-foreground">No {type} models yet: set a provider key on the Providers tab, or type any model id.</p>}

      {mode === "chat" && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="pg-system">System prompt</Label>
            <Textarea id="pg-system" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} placeholder="Optional" />
          </div>
          {turns.length > 0 && (
            <ol className="grid gap-3 rounded-lg border p-4" aria-live="polite">
              {turns.map((t, i) => (
                <li key={i} className="grid gap-0.5">
                  <span className="text-xs font-medium text-muted-foreground">{t.role === "user" ? "You" : "Model"}</span>
                  <p className="whitespace-pre-wrap">{t.content || (busy && i === turns.length - 1 ? "…" : "")}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <form onSubmit={run} className="grid gap-2">
        <Label htmlFor="pg-input">{mode === "chat" ? "Message" : mode === "embeddings" ? "Text to embed" : "Prompt"}</Label>
        <Textarea
          id="pg-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }}
        />
        <div className="flex items-center gap-2">
          {busy && mode === "chat" ? (
            <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
              <Square />
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={busy || !input.trim()}>
              <Send />
              {busy ? "Running…" : mode === "chat" ? "Send" : mode === "embeddings" ? "Embed" : "Generate"}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">⌘↵ to send · calls are logged with the tag playground</span>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {output?.kind === "vector" && (
        <p className="font-mono text-[13px]">
          {output.dims} dimensions: [{output.head.map((n) => n.toFixed(4)).join(", ")}, …]
        </p>
      )}
      {output?.kind === "image" && <img src={output.src} alt="Generated" className="max-w-sm rounded-lg border" />}
      {result && (
        <p className="text-muted-foreground" aria-live="polite">
          {result.model && <span className="font-mono text-[13px]">{result.model} · </span>}
          {result.usage &&
            `${formatCount(result.usage.input)} in${result.usage.cached ? ` (${formatCount(result.usage.cached)} cached)` : ""} · ${formatCount(result.usage.output)} out · `}
          {result.cost !== null && `${usd(result.cost)} · `}
          {formatCount(Math.round(result.ms))} ms
        </p>
      )}
    </div>
  );
}

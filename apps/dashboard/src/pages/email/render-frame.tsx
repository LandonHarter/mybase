import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderRequest, RenderResult } from "../../email-render/frame";
import { cn } from "@/lib/utils";

export type Rendered = Extract<RenderResult, { ok: true }>;

const TIMEOUT_MS = 10_000;

/**
 * The sandboxed render frame (`/email-render.html`, served by the API): it runs the template's TSX
 * in an opaque origin and shows the preview. `render` resolves with the placeholder HTML to save.
 * A frame that hangs (an endless loop in the template) is replaced after 10 s.
 */
export function useRenderFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const pending = useRef(new Map<number, { resolve: (r: RenderResult) => void; timer: ReturnType<typeof setTimeout> }>());
  const nextId = useRef(1);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Opaque origin ("null"): match by window, not origin.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { type?: string } | RenderResult;
      if (data?.type === "ready") setReady(true);
      if (data?.type === "rendered") {
        const r = data as RenderResult;
        const p = pending.current.get(r.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.current.delete(r.id);
        p.resolve(r);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const render = useCallback(
    (source: string, view: "html" | "text", samples?: Record<string, string>) =>
      new Promise<RenderResult>((resolve) => {
        const win = frame.current?.contentWindow;
        const id = nextId.current++;
        if (!win || !ready) return resolve({ type: "rendered", id, ok: false, error: "The preview is still loading" });
        const timer = setTimeout(() => {
          pending.current.delete(id);
          setReady(false);
          setGeneration((g) => g + 1);
          resolve({ type: "rendered", id, ok: false, error: "Rendering took over 10 seconds (an endless loop?). The preview restarted." });
        }, TIMEOUT_MS);
        pending.current.set(id, { resolve, timer });
        win.postMessage({ type: "render", id, source, samples, view } satisfies RenderRequest, "*");
      }),
    [ready],
  );

  const Frame = useCallback(
    ({ className, width }: { className?: string; width?: number }) => (
      <iframe
        key={generation}
        ref={frame}
        src="/email-render.html"
        // allow-scripts only: no allow-same-origin, so the template can't reach cookies or the API.
        sandbox="allow-scripts"
        title="Email preview"
        className={cn("h-full rounded-md border bg-white", className)}
        style={width ? { width, maxWidth: "100%" } : { width: "100%" }}
      />
    ),
    [generation],
  );

  return { Frame, render, ready };
}

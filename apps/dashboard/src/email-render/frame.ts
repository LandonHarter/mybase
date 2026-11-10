// The email template render frame: `/email-render.html`, loaded by the dashboard's template editor
// in `<iframe sandbox="allow-scripts">` (no allow-same-origin → an opaque origin: no cookies, no
// dashboard storage, no API). Its CSP allows only this script (plus eval for the template) and no
// network (`connect-src 'none'`). The API serves the page and this bundle (email-render.ts there).
//
// It runs the user's TSX: sucrase strips types and JSX, the module may import only `react` and
// `@react-email/components`, and @react-email/render turns it into HTML twice: with the sample
// values (the preview shown here) and with `{{name}}` placeholders (what the server stores and
// fills per send). Template code never runs on the server.
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as components from "@react-email/components";
import { render } from "@react-email/render";
import { transform } from "sucrase";

export interface RenderRequest {
  type: "render";
  id: number;
  source: string;
  /** Overrides for PreviewProps samples. */
  samples?: Record<string, string>;
  view: "html" | "text";
}

export type RenderResult =
  | {
      type: "rendered";
      id: number;
      ok: true;
      /** With `{{name}}` placeholders: what gets saved. */
      html: string;
      text: string;
      subject: string;
      from: string | null;
      variables: { name: string; sample: string }[];
    }
  | { type: "rendered"; id: number; ok: false; error: string };

const MODULES: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxRuntime,
  "@react-email/components": components,
};

type Mod = { default?: unknown; subject?: unknown; from?: unknown; PreviewProps?: unknown; [k: string]: unknown };

function load(source: string): Mod {
  const { code } = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true });
  const module = { exports: {} as Mod };
  const require = (name: string) => {
    if (name in MODULES) return MODULES[name];
    throw new Error(`templates can import only react and @react-email/components (not "${name}")`);
  };
  new Function("require", "exports", "module", code)(require, module.exports, module);
  return module.exports;
}

const preview = document.getElementById("preview") as HTMLIFrameElement;
const textView = document.getElementById("text") as HTMLPreElement;
const errorView = document.getElementById("error") as HTMLPreElement;

function show(view: "html" | "text" | "error", content: string) {
  preview.hidden = view !== "html";
  textView.hidden = view !== "text";
  errorView.hidden = view !== "error";
  if (view === "html") preview.srcdoc = content;
  else if (view === "text") textView.textContent = content;
  else errorView.textContent = content;
}

async function handle(req: RenderRequest): Promise<RenderResult> {
  try {
    const mod = load(req.source);
    const Component = mod.default;
    if (typeof Component !== "function") throw new Error("export default your email component: export default function Email(props) { … }");
    const subject = mod.subject ?? (Component as unknown as Mod).subject;
    if (typeof subject !== "string" || !subject.trim()) throw new Error('export the subject: export const subject = "Welcome, {{name}}"');
    const raw = (mod.PreviewProps ?? (Component as unknown as Mod).PreviewProps ?? {}) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("PreviewProps must be an object of sample values");
    const variables = Object.entries(raw).map(([name, sample]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`PreviewProps.${name}: variable names are letters, digits, and _`);
      if (typeof sample === "object" && sample !== null) {
        throw new Error(`PreviewProps.${name} is an object or array. Saved templates take strings; for lists, render in your app and send html`);
      }
      return { name, sample: String(sample ?? "") };
    });
    const samples = Object.fromEntries(variables.map((v) => [v.name, req.samples?.[v.name] ?? v.sample]));
    const placeholders = Object.fromEntries(variables.map((v) => [v.name, `{{${v.name}}}`]));
    const C = Component as React.ComponentType<Record<string, string>>;

    const [html, text, previewHtml, previewText] = await Promise.all([
      render(React.createElement(C, placeholders)),
      render(React.createElement(C, placeholders), { plainText: true }),
      render(React.createElement(C, samples)),
      render(React.createElement(C, samples), { plainText: true }),
    ]);
    show(req.view, req.view === "html" ? previewHtml : previewText);
    const from = mod.from ?? (Component as unknown as Mod).from;
    return { type: "rendered", id: req.id, ok: true, html, text, subject: subject.trim(), from: typeof from === "string" ? from : null, variables };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    show("error", message);
    return { type: "rendered", id: req.id, ok: false, error: message };
  }
}

window.addEventListener("message", (e: MessageEvent) => {
  // Only the dashboard page that embeds this frame.
  if (e.source !== window.parent) return;
  const req = e.data as RenderRequest;
  if (req?.type !== "render" || typeof req.source !== "string" || typeof req.id !== "number") return;
  void handle(req).then((res) => window.parent.postMessage(res, "*"));
});

window.parent.postMessage({ type: "ready" }, "*");

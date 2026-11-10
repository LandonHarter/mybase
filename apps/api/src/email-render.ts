// `/email-render.html`: the sandboxed frame the dashboard's template editor renders React Email
// templates in (source: apps/dashboard/src/email-render/frame.ts). Static and public: it holds no
// data, and only runs inside `<iframe sandbox="allow-scripts">` (opaque origin, so it can't use the
// admin's cookies or read the dashboard). Its script is inlined and allowed by hash, since `'self'`
// doesn't reliably match from an opaque origin; `'unsafe-eval'` runs the template module; no
// network (`connect-src 'none'`), and only the dashboard may embed it.
//
// The Docker image ships the script prebuilt (EMAIL_RENDER_SCRIPT); in development it's built on
// first request.

let page: Promise<{ html: string; csp: string }> | null = null;

async function script(): Promise<string> {
  if (process.env.EMAIL_RENDER_SCRIPT) return Bun.file(process.env.EMAIL_RENDER_SCRIPT).text();
  const result = await Bun.build({
    entrypoints: [new URL("../../dashboard/src/email-render/frame.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    // Not minify.syntax: Bun's syntax minifier emits duplicate labels in react-dom's server
    // build here ("Label 'u' has already been declared"), which browsers refuse to parse.
    minify: { whitespace: true, identifiers: true, syntax: false },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "email-render build failed");
  return result.outputs[0].text();
}

/** `</script` can't appear inside the inline script. */
const inlineSafe = (js: string) => js.replaceAll("</script", "<\\/script");

export function emailRenderPage(): Promise<{ html: string; csp: string }> {
  page ??= (async () => {
    const js = inlineSafe(await script());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(js));
    const hash = `'sha256-${Buffer.from(digest).toString("base64")}'`;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preview</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}pre{margin:0;padding:16px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}#error{color:#b42318;background:#fef3f2}</style>
</head><body>
<iframe id="preview" sandbox="" title="Email preview"></iframe>
<pre id="text" hidden></pre>
<pre id="error" hidden></pre>
<script>${js}</script>
</body></html>`;
    const csp = [
      "default-src 'none'",
      `script-src ${hash} 'unsafe-eval'`,
      "style-src 'unsafe-inline' https:",
      "img-src https: http: data:",
      "font-src https: data:",
      "connect-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
    return { html, csp };
  })().catch((err) => {
    page = null;
    throw err;
  });
  return page;
}

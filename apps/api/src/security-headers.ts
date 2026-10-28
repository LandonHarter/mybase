// Response headers that keep browsers from treating our responses as something they aren't.
// The dashboard, the API, and public storage files share one origin, so a file that a browser
// renders as a page (HTML, SVG) could script the dashboard with the admin's cookie. Public
// files are therefore sandboxed and "active" types are downloaded, never rendered.
// Pure functions only, so they're easy to test (security-headers.test.ts).

/** Sent with every stored object we serve (public route and the dashboard's file browser). */
export const OBJECT_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  // `sandbox` without allow-scripts: even if a browser renders the file, it can't run script
  // or reach the origin's cookies.
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  // Public files are meant to be embedded from other sites (img tags, fonts).
  "Cross-Origin-Resource-Policy": "cross-origin",
};

// Types a browser may run or render as a document. Everything else (images, video, fonts, PDFs,
// plain text, JSON) is safe to show inline with nosniff + the sandbox CSP.
const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/wasm",
  "multipart/x-mixed-replace",
  "application/octet-stream",
]);

/** Whether a stored type must be downloaded instead of shown. Unknown/empty types count as active. */
export function activeType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type || !type.includes("/")) return true;
  return ACTIVE_TYPES.has(type) || type.endsWith("+xml");
}

/** Headers for an object served inline when safe, as a download when not. */
export function objectHeaders(contentType: string | null | undefined, filename: string): Record<string, string> {
  if (!activeType(contentType)) return OBJECT_HEADERS;
  return {
    ...OBJECT_HEADERS,
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}

/** Sent with every API response unless the handler set the header itself. */
export const API_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

/** sha256 CSP sources (`'sha256-…'`) for every inline `<script>` in an HTML page. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[2]!));
    hashes.push(`'sha256-${Buffer.from(digest).toString("base64")}'`);
  }
  return hashes;
}

/** CSP for the built dashboard. `scriptHashes` cover its inline scripts (the theme snippet). */
export function dashboardCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    // Radix/shadcn and charts set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Headers for dashboard pages and assets. `csp` is null in dev (HMR injects scripts). */
export function dashboardHeaders(csp: string | null, https: boolean): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(csp ? { "Content-Security-Policy": csp } : {}),
    ...(https ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}

/** Sets each header the response doesn't already have. */
export function setMissing(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) if (!res.headers.has(name)) res.headers.set(name, value);
}

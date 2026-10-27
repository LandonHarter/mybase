// Reads a web page for the search service and turns its main content into markdown.
//
// Apps hand us any URL, and the API sits next to Postgres, Garage's admin API, Valkey, and the
// LAN, so only public addresses are allowed: every hop (redirects included) is resolved and
// checked before it's requested. Fetch resolves the name again when it connects, so a DNS
// server that answers differently the second time (rebinding) can still slip through; closing
// that needs connecting to the checked IP, which Bun's fetch can't do for https.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MYBASE_VERSION } from "@mybase/shared";
import { Readability } from "@mozilla/readability";
import type { FetchResponse } from "@mybase-dev/sdk/search";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { BadRequestError, UnsupportedMediaError, UpstreamError } from "./errors";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
/** Raw bytes read per page. The rest is dropped (a page this long is cut anyway). */
const MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = `Mozilla/5.0 (compatible; mybase-fetch/${MYBASE_VERSION}; +https://github.com/LandonHarter/mybase)`;

// ---- address checks ---------------------------------------------------------

/**
 * Whether an IP is on the public internet. False for loopback, private, link-local, CGNAT
 * (Tailscale), multicast, reserved, documentation, and IPv6 forms of those.
 */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return publicV4(ip.split(".").map(Number) as [number, number, number, number]);
  if (kind !== 6) return false;
  const h = expandV6(ip);
  if (!h) return false;
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64): judge the IPv4 inside.
  const embedded = [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff] as [number, number, number, number];
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return publicV4(embedded);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return publicV4(embedded);
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return false; // documentation
  // Global unicast only (2000::/3).
  return (first & 0xe000) === 0x2000;
}

function publicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, Tailscale
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return a < 224; // multicast and reserved above
}

/** Eight 16-bit groups, or null if it isn't IPv6 we understand. */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  // A trailing dotted IPv4 becomes two groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split(".").map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Parses an app-supplied URL and makes sure its host resolves only to public addresses. */
export async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError("url must be an absolute http(s) URL");
  if (url.username || url.password) throw new BadRequestError("url can't contain a username or password");
  url.hash = "";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new BadRequestError(`couldn't resolve ${host}`);
    }
  }
  // Every address must be public: fetch may connect to any of them.
  if (addresses.length === 0 || !addresses.every(isPublicIp)) {
    throw new BadRequestError(`${host} isn't a public address; only pages on the public internet can be read`);
  }
  return url;
}

// ---- fetching ---------------------------------------------------------------

export type Page = Omit<FetchResponse, "cached">;

/** Fetches `raw` (following checked redirects) and converts it to markdown, cut at `maxChars`. */
export async function readPage(raw: string, maxChars: number): Promise<Page> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = await checkUrl(raw);
  let res: Response;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,application/json;q=0.8,*/*;q=0.1",
          "Accept-Language": "en;q=0.9,*;q=0.5",
        },
      });
    } catch (err) {
      if (signal.aborted) throw new UpstreamError(`${url.host} took longer than ${TIMEOUT_MS / 1000}s`);
      throw new UpstreamError(`couldn't connect to ${url.host}`, { cause: err });
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new UpstreamError(`more than ${MAX_REDIRECTS} redirects`);
    url = await checkUrl(new URL(location, url).href);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new UpstreamError(`${url.host} answered ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const mime = contentType.split(";")[0]!.trim();
  const kind = mime === "text/html" || mime === "application/xhtml+xml" ? "html" : mime === "application/json" || mime.endsWith("+json") ? "json" : mime.startsWith("text/") ? "text" : null;
  if (!kind) {
    res.body?.cancel().catch(() => {});
    throw new UnsupportedMediaError(`can't read ${mime || "pages without a content type"}; only HTML, text, and JSON`);
  }
  const charset = contentType.match(/charset=["']?([\w-]+)/)?.[1];
  const body = await readCapped(res, MAX_BYTES, charset, signal);

  let title: string | null = null;
  let markdown: string;
  if (kind === "html") ({ title, markdown } = htmlToMarkdown(body, url.href));
  else if (kind === "json") markdown = "```json\n" + prettyJson(body) + "\n```";
  else markdown = body;

  markdown = markdown.trim();
  const truncated = markdown.length > maxChars;
  if (truncated) markdown = markdown.slice(0, maxChars);
  return { url: url.href, title, markdown, truncated, contentType: mime };
}

async function readCapped(res: Response, limit: number, charset: string | undefined, signal: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (err) {
    if (signal.aborted) throw new UpstreamError(`the page took longer than ${TIMEOUT_MS / 1000}s`);
    throw new UpstreamError("the page stopped sending", { cause: err });
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c.subarray(0, bytes.length - offset), offset);
    offset += c.byteLength;
    if (offset >= bytes.length) break;
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder();
  }
  return decoder.decode(bytes);
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ---- HTML → markdown --------------------------------------------------------

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
turndown.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "button", "picture", "video", "audio"] as (keyof HTMLElementTagNameMap)[]);
// Images cost tokens and say little as text. A rule, because the built-in image rule beats remove().
turndown.addRule("image", { filter: "img", replacement: () => "" });
// Links left empty (they wrapped an image) and heading anchors (`#`, `¶`) are noise.
turndown.addRule("link", {
  filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
  replacement(content, node) {
    const text = content.trim();
    if (!text || /^[#¶§]$/.test(text)) return "";
    const href = (node as HTMLElement).getAttribute("href")!.replace(/[()]/g, (c) => `\\${c}`);
    return `[${content}](${href})`;
  },
});

/** Below this much text, Readability probably picked the wrong part of the page. */
const MIN_ARTICLE_CHARS = 200;

export function htmlToMarkdown(html: string, pageUrl: string): { title: string | null; markdown: string } {
  const { document } = parseHTML(html);
  // Readability resolves links against the document's URL, which linkedom doesn't know: do it first.
  for (const el of Array.from(document.querySelectorAll("a[href]"))) {
    try {
      el.setAttribute("href", new URL(el.getAttribute("href")!, pageUrl).href);
    } catch {
      el.removeAttribute("href");
    }
  }
  const pageTitle = document.querySelector("title")?.textContent?.trim() || null;

  // Readability changes the document it reads, so give it its own copy for the fallback's sake.
  const article = new Readability(parseHTML(document.toString()).document as unknown as Document, { keepClasses: false }).parse();
  let content: string;
  let title = pageTitle;
  if (article?.content && (article.textContent?.trim().length ?? 0) >= MIN_ARTICLE_CHARS) {
    content = article.content;
    title = article.title?.trim() || pageTitle;
  } else {
    for (const el of Array.from(document.querySelectorAll("nav, header, footer, aside, [role=navigation], [aria-hidden=true]"))) el.remove();
    content = document.querySelector("main")?.innerHTML ?? document.body?.innerHTML ?? html;
  }
  const markdown = turndown
    .turndown(content)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return { title, markdown };
}

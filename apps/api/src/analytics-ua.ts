// A small user-agent parser for analytics: browser, OS, device class, and whether it's a bot.
// Regex tables, no dependencies; good enough for "which browsers do my visitors use".

export interface UserAgentInfo {
  browser: string | null;
  os: string | null;
  device: "desktop" | "mobile" | "tablet";
  bot: boolean;
}

// Crawlers, link previewers, and headless browsers. Plain HTTP clients (curl, node) aren't
// here: server-side events from an app's backend are real events.
const BOT = /bot\b|bot\/|crawl|spider|slurp|mediapartners|headlesschrome|lighthouse|pagespeed|facebookexternalhit|embedly|quora link preview|whatsapp|preview|scanner|monitor|uptime|phantomjs/i;

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/YaBrowser\//, "Yandex"],
  [/Vivaldi\//, "Vivaldi"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\/|Chromium\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/^Bun\//, "Bun"],
  [/^node$|^Node\.js|undici/, "Node.js"],
  [/^curl\//, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
  [/Windows NT|Windows Phone/, "Windows"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux|X11/, "Linux"],
];

const match = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function parseUserAgent(ua: string | null | undefined): UserAgentInfo {
  const s = (ua ?? "").slice(0, 512);
  let device: UserAgentInfo["device"] = "desktop";
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/.test(s)) device = "tablet";
  else if (/Mobi|iPhone|iPod|Android|Windows Phone/.test(s)) device = "mobile";
  return { browser: match(s, BROWSERS), os: match(s, SYSTEMS), device, bot: BOT.test(s) };
}

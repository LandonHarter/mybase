// Server-side logger shared by every mybase service. Not for browser code.
//
// Env:
//   LOG_LEVEL   debug | info | warn | error   (default: info)
//   LOG_FORMAT  pretty | json                 (default: pretty; use json in containers)
//   NO_COLOR / FORCE_COLOR                    standard color overrides
//   MYBASE_LOG_PREFIXED=1                     set by scripts/dev.ts, which already
//                                             prefixes every line with the service name

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const ansi = (code: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  dim: ansi(2),
  bold: ansi(1),
  red: ansi(31),
  green: ansi(32),
  yellow: ansi(33),
  blue: ansi(34),
  magenta: ansi(35),
  cyan: ansi(36),
  gray: ansi(90),
};

const LEVEL_STYLE: Record<LogLevel, (s: string) => string> = {
  debug: color.gray,
  info: color.green,
  warn: color.yellow,
  error: color.red,
};

// Fixed colors for known services so a service always looks the same; others hash.
const SERVICE_COLORS: Record<string, (s: string) => string> = {
  api: color.cyan,
  dashboard: color.magenta,
  cli: color.blue,
  cron: color.yellow,
  analytics: color.green,
  cache: color.red,
  ratelimit: color.magenta,
  queue: color.blue,
  dev: color.gray,
};
const FALLBACK_COLORS = [color.cyan, color.magenta, color.blue, color.yellow, color.green];

export function serviceColor(service: string): (s: string) => string {
  const known = SERVICE_COLORS[service];
  if (known) return known;
  let hash = 0;
  for (const ch of service) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

function minLevel(): number {
  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[level] ?? LEVELS.info;
}

function serializeError(err: Error) {
  return { name: err.name, message: err.message, stack: err.stack };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /\s|=|"/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  return JSON.stringify(value);
}

function formatPretty(service: string, level: LogLevel, msg: string, fields: LogFields): string {
  const time = color.dim(new Date().toISOString().slice(11, 23));
  const lvl = LEVEL_STYLE[level](level.toUpperCase().padEnd(5));
  const tag = process.env.MYBASE_LOG_PREFIXED ? "" : `${serviceColor(service)(`[${service}]`)} `;

  let errorStack = "";
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error && value.stack) errorStack = `\n${color.dim(value.stack)}`;
    pairs.push(`${color.gray(`${key}=`)}${formatValue(value)}`);
  }

  return `${time} ${lvl} ${tag}${msg}${pairs.length ? ` ${pairs.join(" ")}` : ""}${errorStack}`;
}

function formatJson(service: string, level: LogLevel, msg: string, fields: LogFields): string {
  const entry: LogFields = { time: new Date().toISOString(), level, service, msg };
  for (const [key, value] of Object.entries(fields)) {
    entry[key] = value instanceof Error ? serializeError(value) : value;
  }
  return JSON.stringify(entry);
}

export function createLogger(service: string, baseFields: LogFields = {}): Logger {
  const write = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LEVELS[level] < minLevel()) return;
    const all = { ...baseFields, ...fields };
    const line =
      process.env.LOG_FORMAT === "json"
        ? formatJson(service, level, msg, all)
        : formatPretty(service, level, msg, all);
    // warn/error go to stderr so they survive `> file` redirects and CLI pipes.
    (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger(service, { ...baseFields, ...fields }),
  };
}

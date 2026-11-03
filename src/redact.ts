/**
 * Secret redaction and a stderr-only logger.
 *
 * IMPORTANT: an MCP stdio server uses stdout for protocol messages, so all
 * diagnostics go to stderr. Everything logged passes through `redact()`.
 */

const SENSITIVE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "client_secret",
  "clientsecret",
  "code",
  "code_verifier",
  "codeverifier",
  "authorization",
  "token",
  "password",
  "secret",
  "key",
  "api_key",
  "apikey",
]);

const PATTERNS: Array<[RegExp, string]> = [
  // Google OAuth access tokens
  [/ya29\.[0-9A-Za-z\-_.]+/g, "ya29.[REDACTED]"],
  // Google OAuth refresh tokens
  [/1\/\/[0-9A-Za-z\-_]{20,}/g, "1//[REDACTED]"],
  // Google OAuth client secrets
  [/GOCSPX-[0-9A-Za-z\-_]+/g, "GOCSPX-[REDACTED]"],
  // Google API keys
  [/AIza[0-9A-Za-z\-_]{35}/g, "AIza[REDACTED]"],
  // Bearer headers
  [/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  // key=value pairs in URLs / form bodies
  [
    /((?:access_token|refresh_token|id_token|client_secret|code_verifier|code|key)=)[^&\s"']+/gi,
    "$1[REDACTED]",
  ],
  // JSON "key": "value" pairs
  [
    /("(?:access_token|refresh_token|id_token|client_secret|code_verifier|code|authorization)"\s*:\s*")[^"]*(")/gi,
    "$1[REDACTED]$2",
  ],
];

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]" as T;
  seen.add(value as object);
  if (value instanceof Error) {
    const e = new Error(redactString(value.message));
    e.name = value.name;
    return e as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, seen);
  }
  return out as T;
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.YT_MCP_LOG_LEVEL || "info").toLowerCase() as Level;
  return ORDER[lvl] ?? ORDER.info;
}

function emit(level: Level, msg: string, meta?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const line = meta === undefined ? msg : `${msg} ${safeJson(redact(meta))}`;
  process.stderr.write(`[youtube-channel-mcp] ${level.toUpperCase()} ${redactString(line)}\n`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { name: val.name, message: val.message } : val));
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, meta?: unknown) => emit("debug", m, meta),
  info: (m: string, meta?: unknown) => emit("info", m, meta),
  warn: (m: string, meta?: unknown) => emit("warn", m, meta),
  error: (m: string, meta?: unknown) => emit("error", m, meta),
};

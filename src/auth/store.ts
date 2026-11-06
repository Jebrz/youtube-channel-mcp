import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors.js";
import { log } from "../redact.js";

export interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  /** Epoch milliseconds when access_token expires. */
  expiry_date?: number;
  /** Space-separated list of scopes actually granted by the user. */
  scope?: string;
  token_type?: string;
  /** When the user last completed Google sign-in (ISO). Used by `doctor` to warn about Testing-mode expiry. */
  obtained_at?: string;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
  source: string;
}

/** Walk up from `p` looking for a `.git` directory. Used to warn about secrets inside a repo. */
export function findEnclosingGitRepo(p: string): string | undefined {
  let dir = path.resolve(p);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readTokenFile(file: string): StoredToken | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredToken;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    log.warn(`Token file at ${file} is not valid JSON; ignoring it.`);
    return undefined;
  }
}

/** Atomically write the token file with owner-only permissions. */
export function writeTokenFile(file: string, token: StoredToken): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const repo = findEnclosingGitRepo(dir);
  if (repo) {
    log.warn(
      `The token file ${file} is inside a git working tree (${repo}). Make sure it is git-ignored, or set YT_MCP_CONFIG_DIR to a directory outside the repository.`,
    );
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX permissions */
  }
}

export function deleteTokenFile(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

export type ClientSecretKind = "desktop" | "web" | "unknown";

export interface ClientSecretInspection {
  ok: boolean;
  kind: ClientSecretKind;
  clientId?: string;
  hasClientSecret: boolean;
  /** Plain-language problem, safe to print (never contains the secret). */
  problem?: string;
  /** Non-blocking concern (e.g. an unusual client ID format). */
  warning?: string;
  hint?: string;
}

const CLIENT_ID_RE = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;

/**
 * Validate the contents of an OAuth client JSON downloaded from Google Cloud
 * Console. Only "Desktop app" clients (the `installed` section) work with the
 * loopback sign-in flow this project uses. Nothing secret is returned.
 */
export function inspectClientSecretJson(text: string): ClientSecretInspection {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, kind: "unknown", hasClientSecret: false, problem: "The file is not valid JSON.", hint: "Download the OAuth client JSON again from Google Cloud Console and do not edit it." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, kind: "unknown", hasClientSecret: false, problem: "The file does not contain a JSON object." };
  }
  const obj = raw as { installed?: Record<string, unknown>; web?: Record<string, unknown>; type?: unknown };
  if (obj.type === "service_account") {
    return {
      ok: false,
      kind: "unknown",
      hasClientSecret: false,
      problem: "This is a service-account key, not an OAuth client.",
      hint: "Service accounts can't read a personal YouTube channel. Create an OAuth client ID of type 'Desktop app' instead.",
    };
  }
  if (obj.web && !obj.installed) {
    return {
      ok: false,
      kind: "web",
      clientId: typeof obj.web.client_id === "string" ? obj.web.client_id : undefined,
      hasClientSecret: typeof obj.web.client_secret === "string",
      problem: "This is a 'Web application' OAuth client.",
      hint: "Create an OAuth client of type 'Desktop app' instead; sign-in uses a loopback (127.0.0.1) redirect that Web clients don't allow.",
    };
  }
  const section = obj.installed;
  if (!section || typeof section !== "object") {
    return { ok: false, kind: "unknown", hasClientSecret: false, problem: "The file has no 'installed' section, so it isn't a Desktop app OAuth client.", hint: "In Google Cloud Console create an OAuth client ID with Application type 'Desktop app' and download its JSON." };
  }
  const clientId = typeof section.client_id === "string" ? section.client_id : undefined;
  const hasClientSecret = typeof section.client_secret === "string" && section.client_secret.length > 0;
  if (!clientId) {
    return { ok: false, kind: "desktop", hasClientSecret, problem: "The file does not contain installed.client_id." };
  }
  const warning = CLIENT_ID_RE.test(clientId)
    ? undefined
    : "installed.client_id doesn't look like a Google OAuth client ID (…apps.googleusercontent.com). Sign-in will fail if it was edited.";
  return { ok: true, kind: "desktop", clientId, hasClientSecret, ...(warning ? { warning } : {}) };
}

/** Show enough of a client ID to recognise it, without the whole value. */
export function maskClientId(clientId: string): string {
  const m = /^([0-9]+)-[A-Za-z0-9_]+(\.apps\.googleusercontent\.com)$/.exec(clientId);
  if (m) return `${m[1]!.slice(0, 4)}…${m[2]!.slice(1)}`;
  return clientId.length > 8 ? `${clientId.slice(0, 4)}…` : "…";
}

/**
 * Load the OAuth client ID/secret. Order:
 *   1. YT_MCP_CLIENT_ID (+ optional YT_MCP_CLIENT_SECRET) environment variables
 *   2. The client secret JSON file downloaded from Google Cloud Console
 */
export function loadClientCredentials(clientSecretFile: string, env: NodeJS.ProcessEnv = process.env): ClientCredentials {
  if (env.YT_MCP_CLIENT_ID) {
    return { clientId: env.YT_MCP_CLIENT_ID, clientSecret: env.YT_MCP_CLIENT_SECRET, source: "environment" };
  }
  if (!fs.existsSync(clientSecretFile)) {
    throw new ConfigError(
      `No OAuth client configuration found at ${clientSecretFile}.`,
      "Run `youtube-channel-mcp setup` to import the 'Desktop app' OAuth client JSON you downloaded from Google Cloud Console (or set YT_MCP_CLIENT_SECRET_FILE).",
    );
  }
  const text = fs.readFileSync(clientSecretFile, "utf8");
  const info = inspectClientSecretJson(text);
  if (!info.ok) {
    throw new ConfigError(`${clientSecretFile}: ${info.problem}`, info.hint);
  }
  const section = (JSON.parse(text.replace(/^\uFEFF/, "")) as { installed: Record<string, unknown> }).installed;
  const clientSecret = typeof section.client_secret === "string" ? section.client_secret : undefined;
  return { clientId: info.clientId!, clientSecret, source: clientSecretFile };
}

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
      "Create a 'Desktop app' OAuth client in Google Cloud Console, download its JSON, and save it to that path (or set YT_MCP_CLIENT_SECRET_FILE). See README 'Google Cloud setup'.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(clientSecretFile, "utf8"));
  } catch {
    throw new ConfigError(`${clientSecretFile} is not valid JSON.`);
  }
  const obj = raw as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
  if (obj.web && !obj.installed) {
    throw new ConfigError(
      `${clientSecretFile} is a 'Web application' OAuth client.`,
      "Create an OAuth client of type 'Desktop app' instead; the sign-in flow uses a loopback (127.0.0.1) redirect.",
    );
  }
  const section = obj.installed;
  const clientId = typeof section?.client_id === "string" ? section.client_id : undefined;
  if (!clientId) {
    throw new ConfigError(`${clientSecretFile} does not contain installed.client_id.`);
  }
  const clientSecret = typeof section?.client_secret === "string" ? section.client_secret : undefined;
  return { clientId, clientSecret, source: clientSecretFile };
}

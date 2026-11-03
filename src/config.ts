import os from "node:os";
import path from "node:path";

/**
 * OAuth scopes requested by this server. All are read-only.
 *
 * - youtube.readonly: YouTube Data API v3 (channel, uploads, video metadata).
 * - yt-analytics.readonly: YouTube Analytics API (views, watch time, etc.).
 * - yt-analytics-monetary.readonly: OPTIONAL, only requested when the user runs
 *   `auth --monetary`. Needed for revenue / ad metrics, and only works for
 *   channels in the YouTube Partner Program.
 */
export const SCOPES = {
  youtubeReadonly: "https://www.googleapis.com/auth/youtube.readonly",
  analyticsReadonly: "https://www.googleapis.com/auth/yt-analytics.readonly",
  analyticsMonetaryReadonly: "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
} as const;

export const BASE_SCOPES = [SCOPES.youtubeReadonly, SCOPES.analyticsReadonly];

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_DATA_BASE_URL = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_ANALYTICS_BASE_URL = "https://youtubeanalytics.googleapis.com/v2";

export interface AppConfig {
  /** Directory holding the client secret and token. Always outside the repo by default. */
  configDir: string;
  /** Path to the OAuth client JSON downloaded from Google Cloud Console. */
  clientSecretFile: string;
  /** Path where OAuth tokens are persisted (file mode 0600). */
  tokenFile: string;
}

function defaultConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.YT_MCP_CONFIG_DIR) return path.resolve(env.YT_MCP_CONFIG_DIR);
  if (process.platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "youtube-channel-mcp");
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "youtube-channel-mcp");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = defaultConfigDir(env);
  return {
    configDir,
    clientSecretFile: env.YT_MCP_CLIENT_SECRET_FILE
      ? path.resolve(env.YT_MCP_CLIENT_SECRET_FILE)
      : path.join(configDir, "client_secret.json"),
    tokenFile: env.YT_MCP_TOKEN_FILE
      ? path.resolve(env.YT_MCP_TOKEN_FILE)
      : path.join(configDir, "token.json"),
  };
}

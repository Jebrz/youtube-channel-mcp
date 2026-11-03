import path from "node:path";
import { loadConfig } from "../config.js";
import { ConfigError } from "../errors.js";
import { isValidPasswordHash } from "./password.js";

export interface RemoteConfig {
  /** Public HTTPS origin users/Claude reach, e.g. https://yt-mcp.example.com */
  publicUrl: URL;
  /** The MCP endpoint (protected resource). Always <publicUrl>/mcp. */
  resourceUrl: URL;
  port: number;
  host: string;
  ownerPasswordHash: string;
  /** The ONLY channel this deployment will serve. */
  expectedChannelId: string;
  stateFile?: string;
  trustProxy: boolean | number;
  allowedHosts: string[];
  extraRedirectUris: string[];
  dashboardTtlMs: number;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const missing = ["YT_MCP_PUBLIC_URL", "YT_MCP_OWNER_PASSWORD_HASH", "YT_MCP_EXPECTED_CHANNEL_ID"].filter((k) => !env[k]);
  if (missing.length) {
    throw new ConfigError(`Remote mode needs: ${missing.join(", ")}.`, "See docs/HOSTED_SETUP.md.");
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.YT_MCP_PUBLIC_URL!);
  } catch {
    throw new ConfigError("YT_MCP_PUBLIC_URL is not a valid URL.");
  }
  const isLocal = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
  if (publicUrl.protocol !== "https:" && !isLocal) {
    throw new ConfigError("YT_MCP_PUBLIC_URL must use https:// (Claude only connects to HTTPS servers).");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new ConfigError("YT_MCP_PUBLIC_URL must be an origin only, e.g. https://yt-mcp.example.com (no path).");
  }
  if (!isValidPasswordHash(env.YT_MCP_OWNER_PASSWORD_HASH!)) {
    throw new ConfigError("YT_MCP_OWNER_PASSWORD_HASH is not a valid hash.", "Generate one with `youtube-channel-mcp hash-password`.");
  }
  const channel = env.YT_MCP_EXPECTED_CHANNEL_ID!;
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channel)) {
    throw new ConfigError("YT_MCP_EXPECTED_CHANNEL_ID must be a channel ID like UCxxxxxxxxxxxxxxxxxxxxxx.");
  }
  const trust = env.YT_MCP_TRUST_PROXY;
  const stateFile =
    env.YT_MCP_STATE_FILE === "memory" ? undefined : path.resolve(env.YT_MCP_STATE_FILE || path.join(loadConfig(env).configDir, "remote-oauth-state.json"));
  return {
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    port: Number(env.PORT || 8787),
    host: env.YT_MCP_HTTP_HOST || "127.0.0.1",
    ownerPasswordHash: env.YT_MCP_OWNER_PASSWORD_HASH!,
    expectedChannelId: channel,
    stateFile,
    trustProxy: trust === undefined || trust === "" || trust === "false" ? false : trust === "true" ? true : Number(trust),
    allowedHosts: list(env.YT_MCP_ALLOWED_HOSTS).length ? list(env.YT_MCP_ALLOWED_HOSTS) : [publicUrl.host],
    extraRedirectUris: list(env.YT_MCP_EXTRA_REDIRECT_URIS),
    dashboardTtlMs: Number(env.YT_MCP_DASHBOARD_TTL_SECONDS || 900) * 1000,
  };
}

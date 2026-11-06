import { ApiError, AuthRequiredError, ConfigError, MetricUnavailableError, QuotaError, YouTubeMcpError } from "../errors.js";
import { redactString } from "../redact.js";
import type { LiveCheckStep } from "./check.js";

export type CheckStatus = "ok" | "warn" | "action";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** What we found. Never contains secrets. */
  detail: string;
  /** Plain-language next step, when there's something to do. */
  next?: string;
}

/** A category a beginner can act on, derived only from what Google actually told us. */
export type FailureKind =
  | "not_signed_in"
  | "expired_or_revoked"
  | "missing_permissions"
  | "api_disabled"
  | "oauth_client_rejected"
  | "quota"
  | "network"
  | "no_channel"
  | "channel_mismatch"
  | "analytics_refused"
  | "config"
  | "unknown";

export interface Diagnosis {
  kind: FailureKind;
  title: string;
  detail: string;
  next: string;
}

const STEP_LABEL: Record<LiveCheckStep, string> = {
  channel: "reading your channel (YouTube Data API)",
  analytics: "running an analytics query (YouTube Analytics API)",
};

/**
 * Translate a failure into plain language. We only name a cause when the
 * error says so; otherwise we say we don't know rather than guess.
 */
export function diagnoseFailure(err: unknown, step?: LiveCheckStep): Diagnosis {
  const where = step ? ` while ${STEP_LABEL[step]}` : "";
  const msg = redactString(err instanceof Error ? err.message : String(err));

  if (err instanceof AuthRequiredError) {
    switch (err.reason) {
      case "not_signed_in":
        return { kind: "not_signed_in", title: "Not signed in", detail: `No saved Google sign-in${where}.`, next: "Run `youtube-channel-mcp setup` (or `youtube-channel-mcp auth`) and sign in with the Google account that owns the channel." };
      case "expired_or_revoked":
        return {
          kind: "expired_or_revoked",
          title: "Sign-in expired or revoked",
          detail: `Google no longer accepts the saved sign-in${where}: ${msg}`,
          next: "Run `youtube-channel-mcp auth` to sign in again. If this keeps happening about every 7 days, your OAuth consent screen is in Testing status; see docs/GOOGLE_CLOUD_SETUP.md.",
        };
      case "insufficient_scope":
        return {
          kind: "missing_permissions",
          title: "Missing permissions",
          detail: `The sign-in doesn't include a permission this request needs${where}.`,
          next: "Run `youtube-channel-mcp auth` again and tick every checkbox on Google's consent screen.",
        };
      case "network":
        return { kind: "network", title: "Network problem", detail: `Couldn't reach Google's sign-in service${where}: ${msg}`, next: "Check your internet connection, VPN or proxy, then try again." };
      default:
        return { kind: "expired_or_revoked", title: "Authorization rejected", detail: `Google rejected the request${where}: ${msg}`, next: err.hint ?? "Run `youtube-channel-mcp auth` to sign in again." };
    }
  }
  if (err instanceof ConfigError) {
    if (err.reason === "api_disabled") {
      return {
        kind: "api_disabled",
        title: "API not enabled",
        detail: `Google says an API is disabled for your Cloud project${where}: ${msg}`,
        next: "In Google Cloud Console > APIs & Services > Library, enable 'YouTube Data API v3' and 'YouTube Analytics API' for the project that owns your OAuth client, wait a few minutes, then retry.",
      };
    }
    if (err.reason === "invalid_client") {
      return {
        kind: "oauth_client_rejected",
        title: "OAuth client rejected",
        detail: `Google rejected the OAuth client${where}. This happens when the client was deleted, or the saved sign-in was made with a different client.`,
        next: "Run `youtube-channel-mcp setup` to import the current Desktop app client JSON, then sign in again.",
      };
    }
    return { kind: "config", title: "Configuration problem", detail: msg, next: err.hint ?? "Run `youtube-channel-mcp setup`." };
  }
  if (err instanceof QuotaError) {
    return { kind: "quota", title: "Quota or rate limit", detail: `Google refused because of quota${where}: ${msg}`, next: err.hint ?? "Wait and try again later." };
  }
  if (err instanceof MetricUnavailableError) {
    return { kind: "analytics_refused", title: "Analytics request refused", detail: `${msg}${where ? ` (${where.trim()})` : ""}`, next: err.hint ?? "Check that the signed-in account owns the channel." };
  }
  if (err instanceof YouTubeMcpError && err.code === "NO_CHANNEL") {
    return { kind: "no_channel", title: "No YouTube channel on this account", detail: msg, next: err.hint ?? "Sign in again and pick the channel's Brand Account on Google's account chooser." };
  }
  if (err instanceof YouTubeMcpError && err.code === "CHANNEL_MISMATCH") {
    return { kind: "channel_mismatch", title: "Different channel", detail: msg, next: err.hint ?? "Sign in with the account that owns the expected channel." };
  }
  if (err instanceof ApiError && err.status === 0) {
    return { kind: "network", title: "Network problem", detail: `Couldn't reach Google${where}: ${msg}`, next: "Check your internet connection, VPN or proxy, then try again." };
  }
  return { kind: "unknown", title: "Unexpected error", detail: `${msg}${where}`, next: "Run `youtube-channel-mcp doctor` and include its output (it contains no secrets) when asking for help." };
}

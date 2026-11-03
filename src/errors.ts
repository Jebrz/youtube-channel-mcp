import { redactString } from "./redact.js";

/** Base class for errors that are safe to show to the user / model. */
export class YouTubeMcpError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly status?: number;
  readonly reason?: string;
  constructor(code: string, message: string, opts: { hint?: string; status?: number; reason?: string } = {}) {
    super(redactString(message));
    this.name = this.constructor.name;
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.reason = opts.reason;
  }
}

/** No token, token revoked, refresh token expired, or insufficient scopes. */
export class AuthRequiredError extends YouTubeMcpError {
  constructor(message: string, hint = "Run `npx youtube-channel-mcp auth` in a terminal to sign in again.") {
    super("AUTH_REQUIRED", message, { hint });
  }
}

/** Missing or invalid local configuration (e.g. no client_secret.json). */
export class ConfigError extends YouTubeMcpError {
  constructor(message: string, hint?: string) {
    super("CONFIG_ERROR", message, { hint });
  }
}

/** Daily quota exhausted or rate limited. */
export class QuotaError extends YouTubeMcpError {
  constructor(message: string, reason: string, status: number) {
    super("QUOTA_EXCEEDED", message, {
      reason,
      status,
      hint:
        reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || status === 429
          ? "Requests are being rate limited. Wait a minute and try again."
          : "The Google Cloud project's daily API quota is used up. Quotas reset at midnight Pacific Time. You can view usage in Google Cloud Console > APIs & Services > Quotas.",
    });
  }
}

/** The requested metric / dimension / filter combination is not supported, or the data isn't available. */
export class MetricUnavailableError extends YouTubeMcpError {
  constructor(message: string, hint?: string, status?: number, reason?: string) {
    super("METRIC_UNAVAILABLE", message, { hint, status, reason });
  }
}

/** Input that fails local validation before any API call is made. */
export class InvalidInputError extends YouTubeMcpError {
  constructor(message: string, hint?: string) {
    super("INVALID_INPUT", message, { hint });
  }
}

/** Any other API failure. */
export class ApiError extends YouTubeMcpError {
  constructor(message: string, status: number, reason?: string) {
    super("API_ERROR", message, { status, reason });
  }
}

interface GoogleErrorBody {
  error?:
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string; domain?: string }>;
      }
    | string;
  error_description?: string;
}

const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

/**
 * Convert a non-2xx Google API response into a typed error.
 * `api` controls wording for the Analytics "query not supported" case.
 */
export function mapGoogleError(status: number, body: unknown, api: "data" | "analytics"): YouTubeMcpError {
  const b = (body ?? {}) as GoogleErrorBody;
  const errObj = typeof b.error === "object" ? b.error : undefined;
  const message = errObj?.message || (typeof b.error === "string" ? b.error : "") || `HTTP ${status}`;
  const reason = errObj?.errors?.[0]?.reason || errObj?.status;

  if (status === 429 || (reason && QUOTA_REASONS.has(reason))) {
    return new QuotaError(`Google API quota/rate limit: ${message}`, reason || "rateLimitExceeded", status);
  }
  if (status === 401) {
    return new AuthRequiredError(`Authorization was rejected by Google (${message}).`);
  }
  if (status === 403 && (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient.*scope/i.test(message))) {
    return new AuthRequiredError(
      `The saved authorization does not include the scope needed for this request (${message}).`,
      "Run `npx youtube-channel-mcp auth` again (add `--monetary` if you need revenue metrics).",
    );
  }
  if (status === 403 && (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message))) {
    return new ConfigError(
      `The required API is not enabled for your Google Cloud project: ${message}`,
      "Enable both 'YouTube Data API v3' and 'YouTube Analytics API' in Google Cloud Console > APIs & Services > Library.",
    );
  }
  if (api === "analytics" && (status === 400 || status === 403)) {
    if (/query is not supported/i.test(message) || reason === "badRequest" || reason === "invalid") {
      return new MetricUnavailableError(
        `YouTube Analytics rejected this metric/dimension/filter combination: ${message}`,
        "Choose a different report or a subset of metrics; see docs/ANALYTICS.md for supported combinations.",
        status,
        reason,
      );
    }
    if (status === 403) {
      return new MetricUnavailableError(
        `YouTube Analytics refused the request: ${message}`,
        "Monetary metrics need `auth --monetary` and a channel in the YouTube Partner Program. Analytics are only available for channels/videos owned by the signed-in account.",
        status,
        reason,
      );
    }
  }
  if (status === 404) {
    return new ApiError(`Not found: ${message}`, status, reason);
  }
  return new ApiError(`Google API error (${status}${reason ? `, ${reason}` : ""}): ${message}`, status, reason);
}

/** Shape returned to MCP clients when a tool fails. Never contains secrets. */
export function errorToToolPayload(err: unknown): { error: { code: string; message: string; hint?: string; status?: number; reason?: string } } {
  if (err instanceof YouTubeMcpError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.status ? { status: err.status } : {}),
        ...(err.reason ? { reason: err.reason } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "INTERNAL_ERROR", message: redactString(message) } };
}

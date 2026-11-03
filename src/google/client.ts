import type { AccessTokenProvider, FetchLike } from "../auth/manager.js";
import { ApiError, AuthRequiredError, QuotaError, mapGoogleError } from "../errors.js";
import { log } from "../redact.js";

export interface GoogleClientOptions {
  fetchImpl?: FetchLike;
  /** Retries for transient failures (5xx, short-term rate limits). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal authenticated GET client for Google REST APIs.
 *
 * - Adds the OAuth bearer token (never logged).
 * - On HTTP 401, refreshes the token once and retries.
 * - Retries 5xx and short-term rate limits with exponential backoff.
 * - Never retries daily quota exhaustion (quotaExceeded).
 * - Maps error bodies to typed errors (see errors.ts).
 */
export class GoogleClient {
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly auth: AccessTokenProvider,
    opts: GoogleClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async getJson<T = unknown>(url: URL, api: "data" | "analytics"): Promise<T> {
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getAccessToken();
      log.debug(`GET ${url.origin}${url.pathname}`, { attempt });
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ApiError(`Network error calling ${url.host}: ${(e as Error).message}`, 0);
      }

      if (res.ok) {
        return (await res.json()) as T;
      }

      const body = await res.json().catch(() => undefined);
      const err = mapGoogleError(res.status, body, api);

      if (res.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.auth.invalidate();
        continue; // getAccessToken() will refresh; throws AuthRequiredError if it can't.
      }
      if (err instanceof AuthRequiredError) throw err;

      const transientRate =
        err instanceof QuotaError && (err.reason === "rateLimitExceeded" || err.reason === "userRateLimitExceeded" || res.status === 429);
      const transient = res.status >= 500 || transientRate;
      if (transient && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        continue;
      }
      log.warn(`Google API request failed: ${err.message}`, { status: res.status, path: url.pathname });
      throw err;
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

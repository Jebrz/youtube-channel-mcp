import { GOOGLE_TOKEN_URL, SCOPES } from "../config.js";
import { AuthRequiredError, ConfigError } from "../errors.js";
import { log } from "../redact.js";
import type { ClientCredentials, StoredToken } from "./store.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Anything that can hand out a valid access token. */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  /** Drop the cached access token so the next call refreshes it. */
  invalidate(): void;
  hasScope(scope: string): boolean;
}

export interface TokenPersistence {
  load(): StoredToken | undefined;
  save(token: StoredToken): void;
}

const EXPIRY_SKEW_MS = 60_000;

/**
 * Manages the OAuth access token lifecycle: uses the cached token while valid,
 * refreshes it with the refresh token when expired, and reports clearly when the
 * user has to sign in again.
 */
export class AuthManager implements AccessTokenProvider {
  private token: StoredToken | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(
    private readonly getCredentials: () => ClientCredentials,
    private readonly persistence: TokenPersistence,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.token = persistence.load();
  }

  get grantedScopes(): string[] {
    return (this.token?.scope ?? "").split(/\s+/).filter(Boolean);
  }

  /**
   * True if the scope was granted. When the granted scopes are unknown (e.g. a
   * refresh token supplied via env var before its first refresh), returns true
   * and lets Google decide; a missing scope then surfaces as AUTH_REQUIRED.
   */
  hasScope(scope: string): boolean {
    const granted = this.grantedScopes;
    return granted.length === 0 ? this.isSignedIn() : granted.includes(scope);
  }

  hasMonetaryScope(): boolean {
    return this.hasScope(SCOPES.analyticsMonetaryReadonly);
  }

  isSignedIn(): boolean {
    return Boolean(this.token?.refresh_token || this.token?.access_token);
  }

  invalidate(): void {
    if (this.token) this.token = { ...this.token, access_token: undefined, expiry_date: undefined };
  }

  async getAccessToken(): Promise<string> {
    const t = this.token;
    if (t?.access_token && t.expiry_date && t.expiry_date - EXPIRY_SKEW_MS > this.now()) {
      return t.access_token;
    }
    if (!t?.refresh_token) {
      throw new AuthRequiredError(
        t ? "The saved authorization has expired and has no refresh token." : "Not signed in to YouTube yet.",
        undefined,
        t ? "expired_or_revoked" : "not_signed_in",
      );
    }
    // Coalesce concurrent refreshes.
    if (!this.refreshing) {
      this.refreshing = this.refresh(t.refresh_token).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async refresh(refreshToken: string): Promise<string> {
    const creds = this.getCredentials();
    const body = new URLSearchParams({
      client_id: creds.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (creds.clientSecret) body.set("client_secret", creds.clientSecret);

    log.debug("Refreshing OAuth access token");
    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new AuthRequiredError(
        `Could not reach Google's token endpoint to refresh authorization: ${(e as Error).message}`,
        "Check network access to oauth2.googleapis.com, then retry.",
        "network",
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = String(json.error ?? `HTTP ${res.status}`);
      if (err === "invalid_grant") {
        throw new AuthRequiredError(
          "Google rejected the saved refresh token (invalid_grant). It was revoked, expired, or the password changed. " +
            "Note: if your OAuth consent screen is in 'Testing' status, Google expires refresh tokens after 7 days.",
          undefined,
          "expired_or_revoked",
        );
      }
      if (err === "invalid_client" || err === "unauthorized_client") {
        throw new ConfigError(
          `Google rejected the OAuth client (${err}).`,
          "Check that client_secret.json matches the OAuth client that was used to sign in, then run `auth` again.",
          "invalid_client",
        );
      }
      throw new AuthRequiredError(`Token refresh failed: ${err}`);
    }
    const accessToken = json.access_token;
    if (typeof accessToken !== "string") throw new AuthRequiredError("Token refresh returned no access token.");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.token = {
      ...this.token,
      access_token: accessToken,
      expiry_date: this.now() + expiresIn * 1000,
      // Google normally omits refresh_token on refresh; keep the old one.
      refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
      scope: typeof json.scope === "string" ? json.scope : this.token?.scope,
      token_type: typeof json.token_type === "string" ? json.token_type : "Bearer",
    };
    try {
      this.persistence.save(this.token);
    } catch (e) {
      log.warn("Could not persist refreshed token; continuing with in-memory token.", e);
    }
    return accessToken;
  }
}

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "../redact.js";
import { OAuthStore, randomToken, sha256 } from "./oauthStore.js";
import { verifyPassword } from "./password.js";

/**
 * Single-owner OAuth 2.1 authorization server for the remote connector.
 *
 * Exactly one person (the channel owner) can authorize: approving a sign-in
 * requires the owner passphrase, whose scrypt hash is configured on the
 * server. Claude registers itself via Dynamic Client Registration; only
 * Claude's documented redirect URIs are accepted.
 */

export const MCP_SCOPE = "youtube.analytics.read";

/** Redirect URIs Claude uses (https://claude.com/docs/connectors/building/authentication#callback-urls). */
export const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

export function isAllowedRedirectUri(uri: string, extra: string[] = []): boolean {
  if (uri === CLAUDE_REDIRECT_URI || extra.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // Claude Code: loopback redirect on any port, path /callback.
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname === "/callback" && !u.search && !u.hash;
}

export interface ProviderOptions {
  /** The protected resource (MCP endpoint URL) tokens are issued for. */
  resource: URL;
  ownerPasswordHash: string;
  store: OAuthStore;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  extraRedirectUris?: string[];
  /** Max failed passphrase attempts per client IP per window. */
  maxFailuresPerIp?: number;
  /** Max failed passphrase attempts in total per window (lockout). */
  maxFailuresGlobal?: number;
  failureWindowMs?: number;
  now?: () => number;
}

export type ApproveResult =
  | { kind: "redirect"; location: string }
  | { kind: "retry"; pendingId: string; message: string }
  | { kind: "error"; status: number; message: string };

export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly now: () => number;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly failures = new Map<string, number[]>();
  private globalFailures: number[] = [];

  constructor(private readonly opts: ProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.accessTtl = opts.accessTokenTtlMs ?? 60 * 60_000;
    this.refreshTtl = opts.refreshTokenTtlMs ?? 30 * 24 * 60 * 60_000;
  }

  private get store() {
    return this.opts.store;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.clients.get(id),
      registerClient: (client) => {
        const uris = client.redirect_uris ?? [];
        const bad = uris.filter((u) => !isAllowedRedirectUri(String(u), this.opts.extraRedirectUris));
        if (!uris.length || bad.length) {
          throw new InvalidClientMetadataError(`redirect_uris not allowed by this server: ${bad.join(", ") || "(none given)"}`);
        }
        const full = client as OAuthClientInformationFull;
        this.store.addClient(full);
        log.info(`Registered OAuth client ${full.client_id} (${full.client_name ?? "unnamed"})`);
        return full;
      },
    };
  }

  private checkResource(resource: URL | undefined): string {
    const expected = this.opts.resource.href;
    if (resource && resource.href.replace(/\/$/, "") !== expected.replace(/\/$/, "")) {
      throw new InvalidTargetError(`This server only issues tokens for ${expected}`);
    }
    return expected;
  }

  private checkScopes(scopes: string[] | undefined): string[] {
    const requested = (scopes ?? []).filter(Boolean);
    const unknown = requested.filter((s) => s !== MCP_SCOPE && s !== "offline_access");
    if (unknown.length) throw new InvalidScopeError(`Unsupported scope(s): ${unknown.join(" ")}`);
    return [MCP_SCOPE];
  }

  /** Step 1: show the owner sign-in page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.checkResource(params.resource);
    const scopes = this.checkScopes(params.scopes);
    this.store.sweep();
    const id = randomToken(24);
    this.store.pending.set(id, {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource,
      expiresAt: this.now() + 10 * 60_000,
    });
    sendConsentPage(res, id, client.client_name, params.redirectUri);
  }

  private tooManyFailures(ip: string): boolean {
    const window = this.opts.failureWindowMs ?? 15 * 60_000;
    const cutoff = this.now() - window;
    const mine = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    this.failures.set(ip, mine);
    this.globalFailures = this.globalFailures.filter((t) => t > cutoff);
    return mine.length >= (this.opts.maxFailuresPerIp ?? 5) || this.globalFailures.length >= (this.opts.maxFailuresGlobal ?? 20);
  }

  private recordFailure(ip: string) {
    const t = this.now();
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), t]);
    this.globalFailures.push(t);
  }

  getPending(id: string) {
    return this.store.pending.get(id);
  }

  /** Step 2: the owner submits the passphrase (or denies). */
  approve(pendingId: string, password: string, decision: "approve" | "deny", ip: string): ApproveResult {
    const p = this.store.pending.get(pendingId);
    if (!p || p.expiresAt <= this.now()) {
      this.store.pending.delete(pendingId);
      return { kind: "error", status: 400, message: "This sign-in request expired. Start connecting again from Claude." };
    }
    const redirect = new URL(p.redirectUri);
    if (p.state) redirect.searchParams.set("state", p.state);

    if (decision === "deny") {
      this.store.pending.delete(pendingId);
      redirect.searchParams.set("error", "access_denied");
      return { kind: "redirect", location: redirect.href };
    }
    if (this.tooManyFailures(ip)) {
      log.warn("Owner sign-in locked out after repeated wrong passphrases", { ip });
      return { kind: "error", status: 429, message: "Too many failed attempts. Try again later." };
    }
    if (!verifyPassword(password, this.opts.ownerPasswordHash)) {
      this.recordFailure(ip);
      log.warn("Owner sign-in: wrong passphrase", { ip });
      return { kind: "retry", pendingId, message: "Incorrect passphrase." };
    }
    this.store.pending.delete(pendingId);
    const code = randomToken(32);
    this.store.codes.set(sha256(code), {
      clientId: p.clientId,
      codeChallenge: p.codeChallenge,
      redirectUri: p.redirectUri,
      scopes: p.scopes,
      resource: p.resource,
      expiresAt: this.now() + 60_000,
    });
    redirect.searchParams.set("code", code);
    log.info(`Owner approved connector sign-in for client ${p.clientId}`);
    return { kind: "redirect", location: redirect.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.store.codes.get(sha256(code));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = sha256(code);
    const rec = this.store.codes.get(key);
    // Single use: delete before any further checks.
    this.store.codes.delete(key);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= this.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource) this.checkResource(resource);
    return this.issue(client.client_id, rec.scopes, rec.resource, randomToken(16));
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const rec = this.store.refresh.get(key);
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (rec.usedAt !== undefined) {
      // A rotated token was presented again: assume theft and revoke the whole family.
      log.warn(`Refresh token reuse detected for client ${client.client_id}; revoking session`);
      this.store.revokeFamily(rec.family);
      throw new InvalidGrantError("Refresh token was already used");
    }
    if (rec.expiresAt <= this.now()) {
      this.store.refresh.delete(key);
      throw new InvalidGrantError("Refresh token expired");
    }
    if (resource) this.checkResource(resource);
    if (scopes?.length) this.checkScopes(scopes);
    rec.usedAt = this.now();
    return this.issue(client.client_id, rec.scopes, rec.resource, rec.family);
  }

  private issue(clientId: string, scopes: string[], resource: string, family: string): OAuthTokens {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const t = this.now();
    this.store.access.set(sha256(access), { clientId, scopes, resource, family, expiresAt: t + this.accessTtl });
    this.store.refresh.set(sha256(refresh), { clientId, scopes, resource, family, expiresAt: t + this.refreshTtl });
    this.store.save();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTtl / 1000),
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.store.access.get(sha256(token));
    if (!rec) throw new InvalidTokenError("Invalid access token");
    if (rec.expiresAt <= this.now()) {
      this.store.access.delete(sha256(token));
      throw new InvalidTokenError("Access token expired");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: new URL(rec.resource),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const rec = this.store.access.get(key) ?? this.store.refresh.get(key);
    if (rec) this.store.revokeFamily(rec.family);
  }
}

// ---------------------------------------------------------------------------
// Consent page (no external resources; strict CSP; cannot be framed)
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function setPageSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

export function sendConsentPage(res: Response, pendingId: string, clientName: string | undefined, redirectUri: string, message?: string, status = 200): void {
  const host = new URL(redirectUri).host;
  const loopback = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  setPageSecurityHeaders(res);
  res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize YouTube channel access</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ccc;border-radius:8px;padding:1rem 1.25rem}.warn{background:#fff3cd;padding:.5rem .75rem;border-radius:6px}
.err{color:#a00}input{font:inherit;width:100%;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head>
<body><h1>Authorize read-only YouTube analytics</h1>
<div class="box"><p><b>${escapeHtml(clientName || "An MCP client")}</b> wants read-only access to this server's YouTube channel data and analytics.</p>
<p>After you approve, you will be sent to <b>${escapeHtml(host)}</b>.</p>
${loopback ? '<p class="warn">This redirect goes to a program on your own computer (loopback). Only continue if you just started connecting from Claude Code.</p>' : ""}
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/oauth/approve">
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<label>Owner passphrase<br><input type="password" name="password" autocomplete="current-password" autofocus></label>
<p><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></p>
</form></div><p>Only the owner of this deployment knows the passphrase. Nothing on this server can change your channel.</p></body></html>`);
}

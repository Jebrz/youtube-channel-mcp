import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline/promises";
import { BASE_SCOPES, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, SCOPES } from "../config.js";
import { AuthRequiredError } from "../errors.js";
import type { FetchLike } from "./manager.js";
import type { ClientCredentials, StoredToken } from "./store.js";

/**
 * Google OAuth 2.0 "installed app" sign-in with PKCE and a loopback redirect
 * (https://developers.google.com/identity/protocols/oauth2/native-app).
 *
 * Nothing in this flow is printed except the consent URL (which contains no
 * secrets) and human-readable status messages on stderr.
 */

export interface LoginOptions {
  monetary?: boolean;
  /** Don't start a local server; ask the user to paste the redirected URL instead (headless machines). */
  manual?: boolean;
  /** Fixed loopback port. 0 = random free port. */
  port?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Where to write user-facing messages. Defaults to stderr. */
  out?: (msg: string) => void;
}

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function requestedScopes(monetary: boolean): string[] {
  return monetary ? [...BASE_SCOPES, SCOPES.analyticsMonetaryReadonly] : [...BASE_SCOPES];
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  // offline + consent => Google returns a refresh token.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Parse the `code` from a redirect URL and check `state`. */
export function parseRedirect(redirected: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirected.trim());
  } catch {
    throw new AuthRequiredError("That doesn't look like the URL from the browser's address bar.", "Copy the full URL starting with http://127.0.0.1 and try again.");
  }
  const error = url.searchParams.get("error");
  if (error) throw new AuthRequiredError(`Google sign-in was not completed: ${error}`);
  if (url.searchParams.get("state") !== expectedState) {
    throw new AuthRequiredError("OAuth state mismatch; the sign-in response was not for this request.", "Start `auth` again.");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new AuthRequiredError("The redirect URL contained no authorization code.");
  return code;
}

export async function exchangeCode(
  creds: ClientCredentials,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new AuthRequiredError(`Token exchange failed: ${String(json.error ?? res.status)} ${String(json.error_description ?? "")}`.trim());
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiry_date: now() + (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    token_type: typeof json.token_type === "string" ? json.token_type : "Bearer",
    obtained_at: new Date(now()).toISOString(),
  };
}

/** Scopes the user deselected on Google's granular consent screen. */
export function missingScopes(token: StoredToken, wanted: string[]): string[] {
  const granted = new Set((token.scope ?? "").split(/\s+/));
  return wanted.filter((s) => !granted.has(s));
}

function waitForLoopback(
  port: number,
  expectedState: string,
  timeoutMs: number,
  onListening: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", redirectUri);
      if (!reqUrl.searchParams.has("code") && !reqUrl.searchParams.has("error")) {
        res.writeHead(404).end();
        return;
      }
      try {
        const code = parseRedirect(reqUrl.toString(), expectedState);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>Signed in</title><p>youtube-channel-mcp is now authorized. You can close this tab.</p>");
        cleanup();
        resolve({ code, redirectUri });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>Sign-in failed</title><p>Sign-in failed. Return to the terminal for details.</p>");
        cleanup();
        reject(e);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new AuthRequiredError("Timed out waiting for the browser sign-in to finish.", "Run `auth` again."));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      server.close();
    }
    server.on("error", (e) => {
      cleanup();
      reject(e);
    });
    // Bind to the IPv4 loopback only; never expose the callback to the network.
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      redirectUri = `http://127.0.0.1:${actualPort}`;
      onListening(redirectUri);
    });
  });
}

export async function runLogin(creds: ClientCredentials, opts: LoginOptions = {}): Promise<StoredToken> {
  const out = opts.out ?? ((m: string) => process.stderr.write(`${m}\n`));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scopes = requestedScopes(Boolean(opts.monetary));
  const { verifier, challenge } = createPkcePair();
  const state = base64url(crypto.randomBytes(16));

  let code: string;
  let redirectUri: string;

  if (opts.manual) {
    redirectUri = `http://127.0.0.1:${opts.port || 8976}`;
    const url = buildAuthUrl({ clientId: creds.clientId, redirectUri, scopes, challenge, state });
    out("\n1. Open this URL in a browser on any device and sign in with the Google account that owns the channel:\n");
    out(url);
    out(
      "\n2. After you approve, the browser will try to open http://127.0.0.1:... and show a 'site can't be reached' page. That's expected.\n" +
        "3. Copy the FULL URL from the address bar and paste it here.\n",
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const pasted = await rl.question("Redirected URL: ");
    rl.close();
    code = parseRedirect(pasted, state);
  } else {
    const result = await waitForLoopback(opts.port ?? 0, state, opts.timeoutMs ?? 5 * 60_000, (uri) => {
      const url = buildAuthUrl({ clientId: creds.clientId, redirectUri: uri, scopes, challenge, state });
      out("\nOpen this URL in your browser and sign in with the Google account that owns the channel:\n");
      out(url);
      out("\nIf your channel is a Brand Account, pick the brand channel on the account chooser.\nWaiting for you to approve access...\n");
    });
    code = result.code;
    redirectUri = result.redirectUri;
  }

  const token = await exchangeCode(creds, code, verifier, redirectUri, fetchImpl);
  const missing = missingScopes(token, scopes);
  if (missing.length) {
    out(
      `\nWarning: you did not grant these permissions: ${missing.join(", ")}.\n` +
        "Some tools will fail until you run `auth` again and tick every checkbox on the consent screen.",
    );
  }
  if (!token.refresh_token) {
    out("\nWarning: Google did not return a refresh token, so you'll need to sign in again in about an hour.");
  }
  return token;
}

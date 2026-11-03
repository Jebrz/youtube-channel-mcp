import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthUrl, createPkcePair, exchangeCode, missingScopes, parseRedirect, requestedScopes } from "../src/auth/login.js";
import { AuthManager } from "../src/auth/manager.js";
import { loadClientCredentials, readTokenFile, writeTokenFile, type StoredToken } from "../src/auth/store.js";
import { BASE_SCOPES, SCOPES } from "../src/config.js";
import { AuthRequiredError, ConfigError } from "../src/errors.js";
import { json, mockFetch } from "./helpers.js";

const creds = () => ({ clientId: "123.apps.googleusercontent.com", clientSecret: "GOCSPX-test", source: "test" });
const NOW = 1_800_000_000_000;

function memStore(initial?: StoredToken) {
  const saved: StoredToken[] = [];
  return { saved, persistence: { load: () => initial, save: (t: StoredToken) => void saved.push(t) } };
}

describe("AuthManager", () => {
  it("uses a still-valid cached access token without network calls", async () => {
    const f = mockFetch();
    const { persistence } = memStore({ access_token: "ya29.cached", refresh_token: "1//r", expiry_date: NOW + 600_000 });
    const m = new AuthManager(creds, persistence, f, () => NOW);
    expect(await m.getAccessToken()).toBe("ya29.cached");
    expect(f.calls).toHaveLength(0);
  });

  it("refreshes an expired token, keeps the refresh token, and persists it", async () => {
    const f = mockFetch((url, init) => {
      if (url.hostname !== "oauth2.googleapis.com") return undefined;
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("1//refresh");
      return json(200, { access_token: "ya29.new", expires_in: 3599, scope: BASE_SCOPES.join(" "), token_type: "Bearer" });
    });
    const { persistence, saved } = memStore({ access_token: "ya29.old", refresh_token: "1//refresh", expiry_date: NOW - 1 });
    const m = new AuthManager(creds, persistence, f, () => NOW);
    expect(await m.getAccessToken()).toBe("ya29.new");
    expect(saved[0]).toMatchObject({ access_token: "ya29.new", refresh_token: "1//refresh", expiry_date: NOW + 3599_000 });
    expect(m.hasScope(SCOPES.analyticsReadonly)).toBe(true);
    expect(m.hasScope(SCOPES.analyticsMonetaryReadonly)).toBe(false);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const f = mockFetch(() => json(200, { access_token: "ya29.once", expires_in: 3600 }));
    const m = new AuthManager(creds, memStore({ refresh_token: "1//r" }).persistence, f, () => NOW);
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    expect(tokens).toEqual(["ya29.once", "ya29.once", "ya29.once"]);
    expect(f.calls).toHaveLength(1);
  });

  it("reports AUTH_REQUIRED when not signed in", async () => {
    const m = new AuthManager(creds, memStore(undefined).persistence, mockFetch(), () => NOW);
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("maps invalid_grant (revoked / expired refresh token) to AUTH_REQUIRED with the 7-day testing note", async () => {
    const f = mockFetch(() => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    const m = new AuthManager(creds, memStore({ refresh_token: "1//r" }).persistence, f, () => NOW);
    const err = await m.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(err.message).toMatch(/7 days/);
  });

  it("maps invalid_client to a configuration error", async () => {
    const f = mockFetch(() => json(401, { error: "invalid_client" }));
    const m = new AuthManager(creds, memStore({ refresh_token: "1//r" }).persistence, f, () => NOW);
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(ConfigError);
  });

  it("invalidate() forces a refresh on next use", async () => {
    const f = mockFetch(() => json(200, { access_token: "ya29.fresh", expires_in: 3600 }));
    const m = new AuthManager(creds, memStore({ access_token: "ya29.c", refresh_token: "1//r", expiry_date: NOW + 600_000 }).persistence, f, () => NOW);
    m.invalidate();
    expect(await m.getAccessToken()).toBe("ya29.fresh");
  });
});

describe("OAuth sign-in helpers", () => {
  it("builds a PKCE consent URL requesting offline, read-only scopes", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", scopes: requestedScopes(false), challenge, state: "st" }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("access_type")).toBe("offline");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual([SCOPES.youtubeReadonly, SCOPES.analyticsReadonly]);
    expect(scopes.every((s) => s.endsWith("readonly"))).toBe(true);
    expect(requestedScopes(true)).toContain(SCOPES.analyticsMonetaryReadonly);
  });

  it("parses the redirect and rejects state mismatches and errors", () => {
    expect(parseRedirect("http://127.0.0.1:1/?state=s&code=4/abc", "s")).toBe("4/abc");
    expect(() => parseRedirect("http://127.0.0.1:1/?state=other&code=4/abc", "s")).toThrow(/state mismatch/);
    expect(() => parseRedirect("http://127.0.0.1:1/?error=access_denied&state=s", "s")).toThrow(/access_denied/);
    expect(() => parseRedirect("not a url", "s")).toThrow(AuthRequiredError);
  });

  it("exchanges the code with the PKCE verifier", async () => {
    const f = mockFetch((_u, init) => {
      const b = new URLSearchParams(String(init?.body));
      expect(b.get("code_verifier")).toBe("ver");
      expect(b.get("grant_type")).toBe("authorization_code");
      return json(200, { access_token: "ya29.x", refresh_token: "1//y", expires_in: 3600, scope: SCOPES.youtubeReadonly });
    });
    const t = await exchangeCode(creds(), "code", "ver", "http://127.0.0.1:1", f, () => NOW);
    expect(t.refresh_token).toBe("1//y");
    expect(missingScopes(t, BASE_SCOPES)).toEqual([SCOPES.analyticsReadonly]);
  });
});

describe("credential & token storage", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ytmcp-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads a Desktop-app client JSON and rejects Web-app clients", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "installed.json"), JSON.stringify({ installed: { client_id: "cid", client_secret: "sec" } }));
    fs.writeFileSync(path.join(d, "web.json"), JSON.stringify({ web: { client_id: "cid" } }));
    expect(loadClientCredentials(path.join(d, "installed.json"), {})).toMatchObject({ clientId: "cid", clientSecret: "sec" });
    expect(() => loadClientCredentials(path.join(d, "web.json"), {})).toThrow(/Web application/);
    expect(() => loadClientCredentials(path.join(d, "missing.json"), {})).toThrow(ConfigError);
    expect(loadClientCredentials(path.join(d, "missing.json"), { YT_MCP_CLIENT_ID: "env-id" }).clientId).toBe("env-id");
  });

  it("writes the token file with owner-only permissions", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const d = tmp();
    const file = path.join(d, "sub", "token.json");
    writeTokenFile(file, { refresh_token: "1//x" });
    expect(readTokenFile(file)).toEqual({ refresh_token: "1//x" });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

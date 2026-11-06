import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardService } from "../src/dashboard/service.js";
import { ChannelGuard, createRemoteApp } from "../src/remote/app.js";
import { createPkcePair } from "../src/auth/login.js";
import { OAuthStore, sha256 } from "../src/remote/oauthStore.js";
import { hashPassword, verifyPassword } from "../src/remote/password.js";
import { CLAUDE_REDIRECT_URI, OwnerOAuthProvider, isAllowedRedirectUri } from "../src/remote/provider.js";
import { loadRemoteConfig } from "../src/remote/config.js";
import { CHANNEL_ID, analyticsResponse, channelResponse, json, makeDeps, mockFetch } from "./helpers.js";

const PASSWORD = "correct horse battery staple";
let PASSWORD_HASH = "";
beforeAll(() => {
  PASSWORD_HASH = hashPassword(PASSWORD);
});
beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));

interface Harness {
  base: string;
  store: OAuthStore;
  googleCalls: () => URL[];
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.close();
});

async function start(opts: { googleChannelId?: string; allowedHostsOverride?: string[] } = {}): Promise<Harness> {
  const g = mockFetch((u) => {
    if (u.pathname.endsWith("/channels")) {
      const r = channelResponse();
      if (opts.googleChannelId) r.items[0]!.id = opts.googleChannelId;
      return json(200, r);
    }
    if (u.hostname === "youtubeanalytics.googleapis.com") return json(200, analyticsResponse([["views", "METRIC", "INTEGER"]], [[42]]));
    return undefined;
  });
  const deps = makeDeps(g);
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const publicUrl = new URL(base);
  const resourceUrl = new URL("/mcp", publicUrl);
  const store = new OAuthStore();
  const provider = new OwnerOAuthProvider({ resource: resourceUrl, ownerPasswordHash: PASSWORD_HASH, store });
  const guard = new ChannelGuard(deps, CHANNEL_ID);
  const app = createRemoteApp({
    publicUrl,
    resourceUrl,
    provider,
    deps,
    dashboard: new DashboardService(deps),
    guard: guard.check,
    allowedHosts: opts.allowedHostsOverride ?? [publicUrl.host],
    disableRateLimits: true,
  });
  server.on("request", app);
  const h: Harness = {
    base,
    store,
    googleCalls: () => g.calls.map((c) => c.url),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  harnesses.push(h);
  return h;
}

async function register(h: Harness, redirect = CLAUDE_REDIRECT_URI) {
  return fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], client_name: "Claude" }),
  });
}

/** Run register -> authorize -> (owner passphrase) -> code. */
async function authorize(h: Harness, password = PASSWORD) {
  const reg = (await (await register(h)).json()) as { client_id: string };
  const { verifier, challenge } = createPkcePair();
  const url = new URL(`${h.base}/authorize`);
  url.search = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: CLAUDE_REDIRECT_URI,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    scope: "youtube.analytics.read",
    resource: `${h.base}/mcp`,
  }).toString();
  const page = await fetch(url, { redirect: "manual" });
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(html).toContain("claude.ai"); // redirect host shown to the owner
  const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
  const approve = await fetch(`${h.base}/oauth/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, password, decision: "approve" }),
  });
  return { clientId: reg.client_id, verifier, approve, pending };
}

async function token(h: Harness, body: Record<string, string>) {
  return fetch(`${h.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}

async function signIn(h: Harness) {
  const { clientId, verifier, approve } = await authorize(h);
  const code = new URL(approve.headers.get("location")!).searchParams.get("code")!;
  const res = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT_URI, resource: `${h.base}/mcp` });
  expect(res.status).toBe(200);
  return { clientId, ...((await res.json()) as { access_token: string; refresh_token: string }) };
}

async function mcpClient(h: Harness, accessToken: string) {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

describe("remote connector: discovery and unauthenticated access", () => {
  it("rejects unauthenticated MCP requests with 401 + resource_metadata pointer", async () => {
    const h = await start();
    const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(h.googleCalls()).toHaveLength(0);
  });

  it("publishes protected-resource and authorization-server metadata Claude needs", async () => {
    const h = await start();
    const prm = (await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${h.base}/mcp`);
    expect(prm.authorization_servers).toEqual([`${h.base}/`]);
    const as = (await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${h.base}/register`);
  });

  it("rejects invalid and garbage bearer tokens", async () => {
    const h = await start();
    for (const auth of ["Bearer nope", "Basic abc", "Bearer "]) {
      const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("refuses requests whose Host header is not the public host (DNS rebinding)", async () => {
    const h = await start({ allowedHostsOverride: ["yt.example.com"] });
    const res = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(421);
    const mcp = await fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(421);
  });

  it("serves a minimal /health (and /healthz alias) without auth, secrets or channel data", async () => {
    const h = await start({ allowedHostsOverride: ["yt.example.com"] }); // probes may use an internal host name
    for (const p of ["/health", "/healthz"]) {
      const res = await fetch(`${h.base}${p}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ ok: true });
      expect(body).not.toMatch(/UC|channel|token|scrypt|views/i);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(h.googleCalls()).toHaveLength(0);
  });
});

describe("remote connector: client registration and owner sign-in", () => {
  it("only registers Claude's documented redirect URIs", async () => {
    const h = await start();
    expect((await register(h)).status).toBe(201);
    expect((await register(h, "http://localhost:4567/callback")).status).toBe(201);
    expect((await register(h, "https://evil.example/callback")).status).toBe(400);
    expect((await register(h, "http://localhost:4567/other")).status).toBe(400);
    expect(isAllowedRedirectUri("http://127.0.0.1:1/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/api/mcp/auth_callback")).toBe(false);
  });

  it("issues no code for a wrong passphrase", async () => {
    const h = await start();
    const { approve } = await authorize(h, "wrong passphrase!!");
    expect(approve.status).toBe(401);
    expect(approve.headers.get("location")).toBeNull();
    expect(h.store.codes.size).toBe(0);
  });

  it("locks out after repeated wrong passphrases", async () => {
    const h = await start();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await authorize(h, `wrong-${i}-passphrase`)).approve.status;
    expect(last).toBe(429);
    // Even the right passphrase is refused while locked out.
    expect((await authorize(h)).approve.status).toBe(429);
  });

  it("deny redirects back with access_denied", async () => {
    const h = await start();
    const reg = (await (await register(h)).json()) as { client_id: string };
    const { challenge } = createPkcePair();
    const html = await (
      await fetch(`${h.base}/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: CLAUDE_REDIRECT_URI, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`)
    ).text();
    const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
    const res = await fetch(`${h.base}/oauth/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending, decision: "deny" }) });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("rejects tokens requested for a different resource", async () => {
    const h = await start();
    const reg = (await (await register(h)).json()) as { client_id: string };
    const { challenge } = createPkcePair();
    const res = await fetch(
      `${h.base}/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: CLAUDE_REDIRECT_URI, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" })}`,
      { redirect: "manual" },
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("remote connector: token endpoint", () => {
  it("requires the matching PKCE verifier, and codes are single-use", async () => {
    const h = await start();
    const { clientId, verifier, approve } = await authorize(h);
    const code = new URL(approve.headers.get("location")!).searchParams.get("code")!;
    expect(new URL(approve.headers.get("location")!).searchParams.get("state")).toBe("st8");
    const bad = await token(h, { grant_type: "authorization_code", code, code_verifier: createPkcePair().verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT_URI });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    const ok = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT_URI });
    expect(ok.status).toBe(200);
    const reuse = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT_URI });
    expect(reuse.status).toBe(400);
  });

  it("stores only token hashes", async () => {
    const h = await start();
    const t = await signIn(h);
    expect(h.store.access.has(sha256(t.access_token))).toBe(true);
    expect(JSON.stringify([...h.store.access.keys(), ...h.store.refresh.keys()])).not.toContain(t.access_token);
  });

  it("rotates refresh tokens and revokes the session when an old one is reused", async () => {
    const h = await start();
    const t1 = await signIn(h);
    const r2 = await token(h, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: t1.clientId });
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    // Replay of the rotated token => theft assumed => whole family revoked.
    const replay = await token(h, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: t1.clientId });
    expect(replay.status).toBe(400);
    const after = await fetch(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t2.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
    const r3 = await token(h, { grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: t1.clientId });
    expect(r3.status).toBe(400);
  });

  it("rejects expired access tokens", async () => {
    const h = await start();
    const t = await signIn(h);
    const rec = h.store.access.get(sha256(t.access_token))!;
    rec.expiresAt = Date.now() - 1;
    const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects a token whose audience is another resource", async () => {
    const h = await start();
    const t = await signIn(h);
    h.store.access.get(sha256(t.access_token))!.resource = "https://other.example/mcp";
    const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("remote connector: authorized MCP access and channel isolation", () => {
  it("serves read-only tools to the signed-in owner", async () => {
    const h = await start();
    const t = await signIn(h);
    const client = await mcpClient(h, t.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).toContain("get_dashboard");
    expect(tools.every((x) => x.annotations?.readOnlyHint === true)).toBe(true);
    const res = await client.callTool({ name: "get_channel_overview", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text).channel.channelId).toBe(CHANNEL_ID);
    await client.close();
  });

  it("refuses to return data if the Google token belongs to a different channel", async () => {
    const h = await start({ googleChannelId: "UCzzzzzzzzzzzzzzzzzzzzzz" });
    const t = await signIn(h);
    const client = await mcpClient(h, t.access_token);
    const res = await client.callTool({ name: "get_channel_analytics", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error.code).toBe("CHANNEL_MISMATCH");
    expect(h.googleCalls().some((u) => u.hostname === "youtubeanalytics.googleapis.com")).toBe(false);
    await client.close();
  });
});

describe("remote config and passphrase hashing", () => {
  it("verifies passphrases and rejects short ones", () => {
    expect(verifyPassword(PASSWORD, PASSWORD_HASH)).toBe(true);
    expect(verifyPassword("nope", PASSWORD_HASH)).toBe(false);
    expect(() => hashPassword("short")).toThrow();
  });

  it("requires https, a password hash and the expected channel", () => {
    const env = { YT_MCP_PUBLIC_URL: "https://yt.example.com", YT_MCP_OWNER_PASSWORD_HASH: PASSWORD_HASH, YT_MCP_EXPECTED_CHANNEL_ID: CHANNEL_ID, YT_MCP_STATE_FILE: "memory" };
    const cfg = loadRemoteConfig(env);
    expect(cfg.resourceUrl.href).toBe("https://yt.example.com/mcp");
    expect(cfg.allowedHosts).toEqual(["yt.example.com"]);
    expect(cfg.host).toBe("127.0.0.1");
    expect(() => loadRemoteConfig({ ...env, YT_MCP_PUBLIC_URL: "http://yt.example.com" })).toThrow(/https/);
    expect(() => loadRemoteConfig({ ...env, YT_MCP_OWNER_PASSWORD_HASH: "plaintext" })).toThrow(/hash/);
    expect(() => loadRemoteConfig({ ...env, YT_MCP_EXPECTED_CHANNEL_ID: undefined })).toThrow(/EXPECTED_CHANNEL/);
  });

  it("validates numeric settings with clear messages", () => {
    const env = { YT_MCP_PUBLIC_URL: "https://yt.example.com", YT_MCP_OWNER_PASSWORD_HASH: PASSWORD_HASH, YT_MCP_EXPECTED_CHANNEL_ID: CHANNEL_ID, YT_MCP_STATE_FILE: "memory" };
    expect(loadRemoteConfig({ ...env, PORT: "8080", YT_MCP_DASHBOARD_TTL_SECONDS: "600", YT_MCP_TRUST_PROXY: "1" })).toMatchObject({ port: 8080, dashboardTtlMs: 600_000, trustProxy: 1 });
    expect(loadRemoteConfig({ ...env, YT_MCP_TRUST_PROXY: "true" }).trustProxy).toBe(true);
    for (const bad of ["abc", "8080abc", "0", "70000", "-1", "1e3", "80.5"]) {
      expect(() => loadRemoteConfig({ ...env, PORT: bad })).toThrow(/PORT must be/);
    }
    expect(() => loadRemoteConfig({ ...env, YT_MCP_DASHBOARD_TTL_SECONDS: "5" })).toThrow(/between 60 and 86400/);
    expect(() => loadRemoteConfig({ ...env, YT_MCP_DASHBOARD_TTL_SECONDS: "fifteen" })).toThrow(/whole number/);
    expect(() => loadRemoteConfig({ ...env, YT_MCP_TRUST_PROXY: "yes" })).toThrow(/YT_MCP_TRUST_PROXY/);
  });
});

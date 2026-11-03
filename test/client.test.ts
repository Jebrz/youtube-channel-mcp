import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthManager } from "../src/auth/manager.js";
import { AuthRequiredError, ConfigError, MetricUnavailableError, QuotaError } from "../src/errors.js";
import { GoogleClient } from "../src/google/client.js";
import { StaticToken, googleError, json, mockFetch, sequence } from "./helpers.js";

const URL_DATA = new URL("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true");
const URL_ANALYTICS = new URL("https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE");

beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));
afterEach(() => vi.restoreAllMocks());

function client(f: ReturnType<typeof mockFetch>, auth = new StaticToken()) {
  return new GoogleClient(auth, { fetchImpl: f, sleep: async () => {}, maxRetries: 2 });
}

describe("GoogleClient", () => {
  it("sends the bearer token and returns JSON", async () => {
    const f = mockFetch(() => json(200, { ok: true }));
    expect(await client(f).getJson(URL_DATA, "data")).toEqual({ ok: true });
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test-token");
  });

  it("on 401 refreshes the token once and retries (expired authorization)", async () => {
    let refreshes = 0;
    const f = mockFetch(
      (u) => (u.hostname === "oauth2.googleapis.com" ? (refreshes++, json(200, { access_token: "ya29.fresh", expires_in: 3600 })) : undefined),
      sequence("/channels", [() => googleError(401, "authError", "Invalid Credentials"), () => json(200, { items: [] })]),
    );
    const auth = new AuthManager(
      () => ({ clientId: "c", clientSecret: "s", source: "t" }),
      { load: () => ({ access_token: "ya29.stale", refresh_token: "1//r", expiry_date: Date.now() + 3_600_000 }), save: () => {} },
      f,
    );
    expect(await client(f, auth as never).getJson(URL_DATA, "data")).toEqual({ items: [] });
    expect(refreshes).toBe(1);
    const authHeaders = f.calls.filter((c) => c.url.pathname.includes("/channels")).map((c) => (c.init!.headers as Record<string, string>).Authorization);
    expect(authHeaders).toEqual(["Bearer ya29.stale", "Bearer ya29.fresh"]);
  });

  it("gives AUTH_REQUIRED if Google still rejects after refresh", async () => {
    const f = mockFetch(() => googleError(401, "authError", "Invalid Credentials"));
    const auth = new StaticToken();
    await expect(client(f, auth).getJson(URL_DATA, "data")).rejects.toBeInstanceOf(AuthRequiredError);
    expect(auth.invalidations).toBe(1);
  });

  it("does not retry daily quota exhaustion", async () => {
    const f = mockFetch(() => googleError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota."));
    const err = await client(f).getJson(URL_DATA, "data").catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.reason).toBe("quotaExceeded");
    expect(err.hint).toMatch(/midnight Pacific/);
    expect(f.calls).toHaveLength(1);
  });

  it("retries short-term rate limits and 5xx, then succeeds", async () => {
    const f = mockFetch(
      sequence("/channels", [() => googleError(403, "rateLimitExceeded", "slow down"), () => json(503, {}), () => json(200, { ok: 1 })]),
    );
    expect(await client(f).getJson(URL_DATA, "data")).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(3);
  });

  it("gives up after max retries with a QuotaError for 429", async () => {
    const f = mockFetch(() => json(429, { error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }));
    await expect(client(f).getJson(URL_ANALYTICS, "analytics")).rejects.toBeInstanceOf(QuotaError);
    expect(f.calls).toHaveLength(3);
  });

  it("maps unsupported analytics queries to METRIC_UNAVAILABLE", async () => {
    const f = mockFetch(() => googleError(400, "badRequest", "The query is not supported. Check the documentation."));
    const err = await client(f).getJson(URL_ANALYTICS, "analytics").catch((e) => e);
    expect(err).toBeInstanceOf(MetricUnavailableError);
    expect(err.code).toBe("METRIC_UNAVAILABLE");
  });

  it("maps forbidden analytics (e.g. monetary on non-YPP channel) to METRIC_UNAVAILABLE", async () => {
    const f = mockFetch(() => googleError(403, "forbidden", "Forbidden"));
    await expect(client(f).getJson(URL_ANALYTICS, "analytics")).rejects.toBeInstanceOf(MetricUnavailableError);
  });

  it("maps disabled APIs to a configuration error", async () => {
    const f = mockFetch(() => googleError(403, "accessNotConfigured", "YouTube Data API v3 has not been used in project 123 before or it is disabled."));
    await expect(client(f).getJson(URL_DATA, "data")).rejects.toBeInstanceOf(ConfigError);
  });

  it("maps insufficient scopes to AUTH_REQUIRED", async () => {
    const f = mockFetch(() => googleError(403, "insufficientPermissions", "Request had insufficient authentication scopes."));
    await expect(client(f).getJson(URL_DATA, "data")).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

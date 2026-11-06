import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardService } from "../src/dashboard/service.js";
import { analyticsResponse, channelResponse, googleError, json, makeDeps, mockFetch, video, type Handler } from "./helpers.js";

beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));
afterEach(() => vi.restoreAllMocks());

/** A switchable mock of both Google APIs. */
function google() {
  const state = { failAnalytics: false, failAll: false, views: 1000 };
  const handler: Handler = (u) => {
    if (state.failAll) return googleError(503, "backendError", "Backend Error");
    if (u.pathname.endsWith("/channels")) return json(200, channelResponse());
    if (u.pathname.endsWith("/videos")) return json(200, { items: [video("aaaaaaaaaaa", "Video A")] });
    if (u.hostname !== "youtubeanalytics.googleapis.com") return undefined;
    if (state.failAnalytics) return googleError(403, "quotaExceeded", "Quota exceeded");
    const dims = u.searchParams.get("dimensions");
    const metrics = (u.searchParams.get("metrics") ?? "").split(",");
    const cols = (d: string[]) => [...d.map((n) => [n, "DIMENSION", "STRING"] as [string, "DIMENSION", string]), ...metrics.map((m) => [m, "METRIC", "INTEGER"] as [string, "METRIC", string])];
    if (!dims) return json(200, analyticsResponse(cols([]), [metrics.map(() => state.views)]));
    if (dims === "day") return json(200, analyticsResponse(cols(["day"]), [["2026-10-30", ...metrics.map(() => 5)]]));
    if (dims === "video") return json(200, analyticsResponse(cols(["video"]), [["aaaaaaaaaaa", ...metrics.map(() => 9)]]));
    if (dims === "insightTrafficSourceType") return json(200, analyticsResponse(cols(["insightTrafficSourceType"]), [["YT_SEARCH", ...metrics.map(() => 7)]]));
    return undefined;
  };
  const fetch = mockFetch(handler);
  return { state, fetch, googleCalls: () => fetch.calls.length };
}

function service(g: ReturnType<typeof google>, clock: { t: number }, opts = {}) {
  return new DashboardService(makeDeps(g.fetch), { now: () => clock.t, ...opts });
}

describe("DashboardService caching", () => {
  it("serves repeat requests from cache within the TTL (no duplicate API calls)", async () => {
    const g = google();
    const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
    const svc = service(g, clock);
    const first = await svc.get();
    const calls = g.googleCalls();
    expect(first.cache.hit).toBe(false);
    expect(Object.values(first.sections).every((s) => s.status === "ok")).toBe(true);

    clock.t += 5 * 60_000;
    const second = await svc.get();
    expect(second.cache.hit).toBe(true);
    expect(second.cache.ageSeconds).toBe(300);
    expect(g.googleCalls()).toBe(calls);
    expect(svc.upstreamAttempts).toBe(1);

    clock.t += 11 * 60_000; // past 15 min TTL
    const third = await svc.get();
    expect(third.cache.hit).toBe(false);
    expect(svc.upstreamAttempts).toBe(2);
  });

  it("coalesces concurrent requests into one upstream fetch", async () => {
    const g = google();
    const svc = service(g, { t: Date.now() });
    const [a, b, c] = await Promise.all([svc.get(), svc.get(), svc.get()]);
    expect(svc.upstreamAttempts).toBe(1);
    expect(a.lastAttemptAt).toBe(b.lastAttemptAt);
    expect(b.lastAttemptAt).toBe(c.lastAttemptAt);
  });

  it("caches per preset/compare combination", async () => {
    const g = google();
    const svc = service(g, { t: Date.now() });
    await svc.get({ preset: "last_28_days" });
    await svc.get({ preset: "last_7_days" });
    await svc.get({ preset: "last_7_days", compare: "previous_year" });
    expect(svc.upstreamAttempts).toBe(3);
  });

  it("throttles forced refreshes, then honors them after the minimum interval", async () => {
    const g = google();
    const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
    const svc = service(g, clock);
    await svc.get();
    clock.t += 10_000;
    const throttled = await svc.get({ force_refresh: true });
    expect(throttled.cache).toMatchObject({ hit: true, throttled: true });
    expect(throttled.notes.join(" ")).toMatch(/too soon/);
    expect(svc.upstreamAttempts).toBe(1);

    clock.t += 60_000;
    const forced = await svc.get({ force_refresh: true });
    expect(forced.cache.hit).toBe(false);
    expect(svc.upstreamAttempts).toBe(2);
  });

  it("reports reporting periods and fetch times", async () => {
    const g = google();
    const svc = service(g, { t: Date.parse("2026-11-03T12:00:00Z") });
    const p = await svc.get();
    expect(p.reportingPeriod).toEqual({
      current: { startDate: "2026-10-05", endDate: "2026-11-01" },
      comparison: { startDate: "2026-09-07", endDate: "2026-10-04" },
    });
    expect(p.lastFullSuccessAt).toBe("2026-11-03T12:00:00.000Z");
    expect(p.sections.summary.fetchedAt).toBe("2026-11-03T12:00:00.000Z");
  });
});

describe("DashboardService refresh failures", () => {
  it("keeps the last successful data and marks failed sections stale", async () => {
    const g = google();
    const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
    const svc = service(g, clock);
    const good = await svc.get();
    const goodSummary = good.sections.summary.data;

    g.state.failAnalytics = true;
    g.state.views = 999_999; // would be visible if stale data were overwritten
    clock.t += 16 * 60_000;
    const p = await svc.get();
    expect(p.stale).toBe(true);
    expect(p.sections.overview.status).toBe("ok"); // Data API still works
    for (const id of ["summary", "daily", "topVideos", "trafficSources"] as const) {
      expect(p.sections[id].status).toBe("stale");
      expect(p.sections[id].error?.code).toBe("QUOTA_EXCEEDED");
      expect(p.sections[id].fetchedAt).toBe("2026-11-03T12:00:00.000Z");
    }
    expect(p.sections.summary.data).toEqual(goodSummary);
    expect(p.lastFullSuccessAt).toBe("2026-11-03T12:00:00.000Z");
    expect(p.lastAttemptAt).toBe("2026-11-03T12:16:00.000Z");
  });

  it("returns error sections with null data when nothing was ever fetched (no fabricated values)", async () => {
    const g = google();
    g.state.failAnalytics = true;
    const svc = service(g, { t: Date.now() });
    const p = await svc.get();
    expect(p.sections.summary).toMatchObject({ status: "error", data: null, fetchedAt: null });
    expect(p.sections.overview.status).toBe("ok");
    expect(p.lastFullSuccessAt).toBeNull();
  });

  it("backs off after a total failure instead of hammering the API", async () => {
    const g = google();
    g.state.failAll = true;
    const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
    const svc = service(g, clock);
    await svc.get();
    expect(svc.upstreamAttempts).toBe(1);
    clock.t += 30_000;
    await svc.get({ force_refresh: true });
    await svc.get();
    expect(svc.upstreamAttempts).toBe(1);
    clock.t += 31_000;
    g.state.failAll = false;
    const recovered = await svc.get();
    expect(svc.upstreamAttempts).toBe(2);
    expect(recovered.stale).toBe(false);
  });

  it("recovers from stale to ok on the next successful refresh", async () => {
    const g = google();
    const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
    const svc = service(g, clock);
    await svc.get();
    g.state.failAnalytics = true;
    clock.t += 16 * 60_000;
    expect((await svc.get()).stale).toBe(true);
    g.state.failAnalytics = false;
    clock.t += 16 * 60_000;
    const p = await svc.get();
    expect(p.stale).toBe(false);
    expect(p.sections.summary.error).toBeUndefined();
  });
});
